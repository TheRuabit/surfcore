// extractor 的模型客户端（无状态 one-shot，2026-10-30）
//
// 为什么单独一层：slang-extractor.js 只依赖一个 askModel({system,user})，
// 具体发给谁、用哪个端点、怎么拿 key，全部留在这里。这样以后想 A/B
// （deepseek-openai / openai / local / dsh）不用动 extractor 本体。
//
// 核心约束：**一次调用 = 一次请求，不带任何历史**。
//   - 不用 conversation / previous_response_id / session
//   - 只发 messages: [system, user]
//   - 没有 tools，没有 tool_result replay
//
// key 解析顺序沿用 web-search.js：config.apiKey → env → DSH credentials → DSH account credential。
// key 绝不出现在日志/错误信息里。
import { readDshCredential } from './web-search.js';

export const PROVIDERS = Object.freeze({
  // DeepSeek 官方的 OpenAI 兼容端点
  'deepseek-openai': {
    label: 'DeepSeek（OpenAI 兼容）',
    baseURL: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-v4-flash',
    keyEnv: 'DEEPSEEK_API_KEY',
    keyRef: 'deepseek-account-platform/default',
  },
  // 真 OpenAI（如果你想对比质量）
  openai: {
    label: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    keyEnv: 'OPENAI_API_KEY',
    keyRef: '',
  },
  // 任何 OpenAI 兼容的自建服务（必须给 baseURL）
  local: {
    label: '本机/自建（OpenAI 兼容）',
    baseURL: '',
    defaultModel: 'local',
    keyEnv: 'EXTRACTOR_API_KEY',
    keyRef: '',
    requiresBaseURL: true,
  },
});

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_TOKENS = 1200;
const DEFAULT_TEMPERATURE = 0.2;

function trimUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

/**
 * 归一化 extractor 的模型配置。
 * @param {object} raw  config.json 里的 slang.extractor 段
 * @returns {{provider:string, model:string, baseURL:string, timeoutMs:number, maxTokens:number, temperature:number, ready:boolean, why:string}}
 */
export function resolveExtractorConfig(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const provider = String(src.provider || 'deepseek-openai').trim();
  const spec = PROVIDERS[provider];
  const baseURL = trimUrl(src.baseURL) || trimUrl(spec && spec.baseURL);
  const model = String(src.model || (spec && spec.defaultModel) || '').trim();
  const timeoutMs = Number(src.timeoutMs) > 0 ? Math.min(120_000, Number(src.timeoutMs)) : DEFAULT_TIMEOUT_MS;
  const maxTokens = Number(src.maxTokens) > 0 ? Math.min(4096, Number(src.maxTokens)) : DEFAULT_MAX_TOKENS;
  const temperature = Number.isFinite(Number(src.temperature)) ? Math.min(2, Math.max(0, Number(src.temperature))) : DEFAULT_TEMPERATURE;
  let why = '';
  if (!spec) why = '未知 provider：' + provider;
  else if (!baseURL) why = 'provider ' + provider + ' 需要 baseURL';
  else if (!model) why = '缺 model';
  return { provider, model, baseURL, timeoutMs, maxTokens, temperature, ready: !why, why };
}

/**
 * 解析 key。返回值绝不打印。
 *
 * 注意这里**不用** web-search 的 resolveSearchApiKey：它最后一档会无条件回落到
 * DeepSeek 的账号凭据，于是 provider=openai 时也会拿到一个 DeepSeek token，
 * 发出去只会 401（或者更糟，让人以为配好了）。所以按 provider 精确取：
 *   env（各 provider 自己的变量名） → 该 provider 声明的 DSH 凭据 → 只有 DeepSeek 才回落账号凭据。
 */
export function resolveExtractorKey(cfg) {
  const spec = PROVIDERS[cfg && cfg.provider];
  if (!spec) return { key: '', source: 'unknown-provider' };
  const envKey = String(process.env[spec.keyEnv] || '').trim();
  if (envKey) return { key: envKey, source: 'env:' + spec.keyEnv };
  if (spec.keyRef) {
    const fromRef = readDshCredential(spec.keyRef);
    if (fromRef) return { key: fromRef, source: 'dsh-ref:' + spec.keyRef };
  }
  if (cfg.provider === 'deepseek-openai') {
    const fromAccount = readDshCredential('deepseek-account-platform/default');
    if (fromAccount) return { key: fromAccount, source: 'dsh-account-credential' };
  }
  return { key: '', source: 'none' };
}

function endpointOf(baseURL) {
  const base = trimUrl(baseURL);
  if (/\/chat\/completions$/.test(base)) return base;
  return base + '/chat/completions';
}

/**
 * 建一个 askModel。返回值签名：({system,user}) => Promise<string>
 * @param {{config:object, log?:Function, fetchImpl?:Function, onUsage?:Function}} options
 */
export function createExtractorModelClient(options) {
  const opts = options || {};
  const cfg = opts.config || resolveExtractorConfig({});
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const doFetch = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : fetch;
  const onUsage = typeof opts.onUsage === 'function' ? opts.onUsage : null;

  if (!cfg.ready) {
    throw new Error('extractor 模型配置不可用：' + cfg.why);
  }
  const resolved = resolveExtractorKey(cfg);
  const url = endpointOf(cfg.baseURL);
  // 本机自建服务通常不校验 key；其余 provider 必须要有。
  const keyRequired = cfg.provider !== 'local';
  if (keyRequired && !resolved.key) {
    throw new Error('extractor 缺 API key（provider=' + cfg.provider + '，可设 ' + (PROVIDERS[cfg.provider] && PROVIDERS[cfg.provider].keyEnv) + '）');
  }
  log('[黑话提取] 模型客户端：' + cfg.provider + ' · ' + cfg.model + ' · key 来源 ' + resolved.source);

  return async function askModel(prompt) {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      const body = {
        model: cfg.model,
        messages: [
          { role: 'system', content: String((prompt && prompt.system) || '') },
          { role: 'user', content: String((prompt && prompt.user) || '') },
        ],
        temperature: cfg.temperature,
        max_tokens: cfg.maxTokens,
        stream: false,
      };
      const headers = { 'content-type': 'application/json' };
      if (resolved.key) headers.authorization = 'Bearer ' + resolved.key;
      const res = await doFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* 下面统一报错 */ }
      if (!res.ok) {
        const detail = json && json.error && (json.error.message || json.error.code)
          ? String(json.error.message || json.error.code).slice(0, 200)
          : String(text || '').slice(0, 200);
        throw new Error('extractor HTTP ' + res.status + '：' + detail);
      }
      const choice = json && Array.isArray(json.choices) ? json.choices[0] : null;
      const content = choice && choice.message && choice.message.content;
      const usage = (json && json.usage) || {};
      const out = String(content || '');
      if (onUsage) {
        try {
          onUsage({
            provider: cfg.provider,
            model: cfg.model,
            inputTokens: Number(usage.prompt_tokens) || 0,
            outputTokens: Number(usage.completion_tokens) || 0,
            totalTokens: Number(usage.total_tokens) || 0,
            // DeepSeek 的 OpenAI 兼容端点会在 usage 里带上这两个字段（存在时用）
            cacheHit: Number(usage.prompt_cache_hit_tokens) || 0,
            cacheMiss: Number(usage.prompt_cache_miss_tokens) || 0,
            ms: Date.now() - started,
          });
        } catch { /* 记账失败不影响结果 */ }
      }
      return out;
    } finally {
      clearTimeout(timer);
    }
  };
}
