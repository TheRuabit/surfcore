// extractor 模型客户端测试（2026-10-30）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDERS,
  resolveExtractorConfig,
  createExtractorModelClient,
} from '../src/extractor-model.js';

function fakeResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
  };
}

test('默认 provider 是 deepseek-openai，端点是 OpenAI 兼容路径', () => {
  const cfg = resolveExtractorConfig({});
  assert.equal(cfg.provider, 'deepseek-openai');
  assert.equal(cfg.baseURL, 'https://api.deepseek.com/v1');
  assert.equal(cfg.model, PROVIDERS['deepseek-openai'].defaultModel);
  assert.equal(cfg.ready, true);
});

test('未知 provider 会被判为不可用', () => {
  const cfg = resolveExtractorConfig({ provider: 'nope' });
  assert.equal(cfg.ready, false);
  assert.match(cfg.why, /未知 provider/);
});

test('local 必须给 baseURL', () => {
  const cfg = resolveExtractorConfig({ provider: 'local' });
  assert.equal(cfg.ready, false);
  assert.match(cfg.why, /baseURL/);
});

test('数值字段会被夹到安全范围', () => {
  const cfg = resolveExtractorConfig({ provider: 'local', baseURL: 'http://127.0.0.1:1234/v1', timeoutMs: 999999, maxTokens: 99999, temperature: 9 });
  assert.equal(cfg.timeoutMs, 120000);
  assert.equal(cfg.maxTokens, 4096);
  assert.equal(cfg.temperature, 2);
});

test('askModel 只发 system+user，不带历史', async () => {
  let seen = null;
  const ask = createExtractorModelClient({
    config: resolveExtractorConfig({ provider: 'local', baseURL: 'http://127.0.0.1:1234/v1', model: 'm' }),
    fetchImpl: async (url, init) => { seen = { url, body: JSON.parse(init.body) }; return fakeResponse({ choices: [{ message: { content: '[]' } }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } }); },
  });
  const out = await ask({ system: 'SYS', user: 'USER' });
  assert.equal(out, '[]');
  assert.equal(seen.url, 'http://127.0.0.1:1234/v1/chat/completions');
  assert.equal(seen.body.messages.length, 2);
  assert.deepEqual(seen.body.messages.map((m) => m.role), ['system', 'user']);
  assert.equal(seen.body.messages[0].content, 'SYS');
  assert.equal(seen.body.stream, false);
  assert.equal(seen.body.model, 'm');
  assert.equal(seen.body.messages.length, 2, '不能有 conversation / previous_response_id 之类');
});

test('usage 会被回调（供桥接记回 token-usage）', async () => {
  const got = [];
  const ask = createExtractorModelClient({
    config: resolveExtractorConfig({ provider: 'local', baseURL: 'http://127.0.0.1:1/v1' }),
    fetchImpl: async () => fakeResponse({ choices: [{ message: { content: '[{"term":"瑞"}]' } }], usage: { prompt_tokens: 900, completion_tokens: 40, total_tokens: 940, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 100 } }),
    onUsage: (u) => got.push(u),
  });
  await ask({ system: 's', user: 'u' });
  assert.equal(got.length, 1);
  assert.equal(got[0].inputTokens, 900);
  assert.equal(got[0].outputTokens, 40);
  assert.equal(got[0].cacheHit, 800);
  assert.equal(got[0].cacheMiss, 100);
});

test('HTTP 失败要抛出带状态码的错误，且不含 key', async () => {
  const ask = createExtractorModelClient({
    config: resolveExtractorConfig({ provider: 'local', baseURL: 'http://127.0.0.1:1/v1' }),
    fetchImpl: async () => fakeResponse({ error: { message: 'rate limited' } }, 429),
  });
  await assert.rejects(() => ask({ system: 's', user: 'u' }), (err) => {
    assert.match(err.message, /HTTP 429/);
    assert.match(err.message, /rate limited/);
    assert.ok(!/Bearer|sk-/.test(err.message), '错误信息不能泄漏 key');
    return true;
  });
});

test('provider 需要 key 而没拿到时，构造就失败', () => {
  const cfg = resolveExtractorConfig({ provider: 'openai', model: 'x' });
  // openai 的 key 正常不存在于这个环境；若存在（有人设了 OPENAI_API_KEY）则跳过
  const hasKey = Boolean(process.env.OPENAI_API_KEY);
  if (hasKey) return;
  assert.throws(() => createExtractorModelClient({ config: cfg }), /缺 API key/);
});
