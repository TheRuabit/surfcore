/**
 * 黑话注入：只有 confirmed + 有 meaning 的才进提示词；
 * 而且位置必须在正文**之后**（前面的前缀要稳定，才能命中缓存）。
 */
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
// harness 默认 slang.enabled=false；这些用例就是要测注入，必须显式打开。
const config = { slang: { enabled: true, injectMax: 8 } };
async function test(name, run) {
  const h = await bridgeHarness({ config });
  try { await run(h); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, error.message); }
  finally { await h.close(); }
}

await test('没有已确认词时只返回时间行 + 正文', async (h) => {
  const out = h.withSlangContext('群友说：杂口杂口');
  assert.ok(out.includes('【当前时间】'));
  assert.ok(out.includes('群友说：杂口杂口'));
  assert.ok(!out.includes('【群聊黑话表】'));
});

await test('候选（无 meaning）不注入', async (h) => {
  h.getSlangEntries().push({
    id: 'x1', content: '杂口杂口', meaning: '', usage: '', example: '', risk: '',
    sources: [], status: 'candidate', source: 'ai', count: 5,
    evidence: [], lastInferenceCount: 0,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  const out = h.withSlangContext('群友说：杂口杂口');
  assert.ok(!out.includes('【群聊黑话表】'), '候选不该注入');
});

await test('已确认且有 meaning 的词会注入，且排在正文之后', async (h) => {
  h.getSlangEntries().push({
    id: 'x2', content: '杂口杂口', meaning: '形容人多嘴杂、场面混乱', usage: '吐槽时用', example: '这波太杂口杂口了',
    risk: '', sources: [], status: 'confirmed', source: 'ai', count: 5,
    evidence: [], lastInferenceCount: 5,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  const body = '群友说：杂口杂口';
  const out = h.withSlangContext(body);
  assert.ok(out.includes('【群聊黑话表】'), '已确认词应被注入');
  assert.ok(out.includes('形容人多嘴杂'), '应带上词义');
  // 位置断言：正文在时间行之后、黑话表之前。
  const iTime = out.indexOf('【当前时间】');
  const iBody = out.indexOf(body);
  const iSlang = out.indexOf('【群聊黑话表】');
  assert.ok(iTime < iBody, '时间行应在正文前');
  assert.ok(iBody < iSlang, '黑话表应在正文之后（保住前缀缓存）');
});

await test('正文里没出现的已确认词不注入（只注入相关的）', async (h) => {
  h.getSlangEntries().push({
    id: 'x3', content: '完全无关的词', meaning: '不该被带进来', usage: '', example: '',
    risk: '', sources: [], status: 'confirmed', source: 'ai', count: 9,
    evidence: [], lastInferenceCount: 9,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  const out = h.withSlangContext('群友说：今天天气不错');
  assert.ok(!out.includes('不该被带进来'));
});

console.log(failures ? `${failures} 项失败` : 'slang inject tests OK');
if (failures) process.exitCode = 1;
