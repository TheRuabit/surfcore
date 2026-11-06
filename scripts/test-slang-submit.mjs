/**
 * 黑话准入契约：带 meaning 直接 confirmed，不带就留在 candidate。
 *
 * 这是「不想人工批准」的落地方式：AI 想让它生效，就必须自己给出词义。
 * 走 harness 的桥接实例（不连真 QQ / DSH）。
 */
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
async function test(name, run) {
  const h = await bridgeHarness({});
  try { await run(h); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, error.message); }
  finally { await h.close(); }
}

await test('带 meaning 且 confidence 未标 low → confirmed', async (h) => {
  const r = h.applySlangSubmit({ content: '杂口杂口', meaning: '形容人多嘴杂，场面混乱', confidence: 'high' });
  assert.equal(r.autoConfirm, true);
  assert.equal(r.status, 'confirmed');
});

await test('confidence 不传也视为有把握', async (h) => {
  const r = h.applySlangSubmit({ content: '破防', meaning: '心理防线被击穿' });
  assert.equal(r.status, 'confirmed');
});

await test('不带 meaning → candidate（进候选池，不生效）', async (h) => {
  const r = h.applySlangSubmit({ content: 'yyds' });
  assert.equal(r.autoConfirm, false);
  assert.equal(r.status, 'candidate');
});

await test('confidence=low 时即使给了 meaning 也只进候选池', async (h) => {
  const r = h.applySlangSubmit({ content: '绝绝子', meaning: '不确定的猜测', confidence: 'low' });
  assert.equal(r.autoConfirm, false);
  assert.equal(r.status, 'candidate');
});

await test('meaning 为空串等同于没给', async (h) => {
  const r = h.applySlangSubmit({ content: 'xswl', meaning: '   ' });
  assert.equal(r.status, 'candidate');
});

console.log(failures ? `${failures} 项失败` : 'slang submit tests OK');
if (failures) process.exitCode = 1;
