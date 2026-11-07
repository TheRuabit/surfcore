/**
 * 群报 LLM 分析：把一天的群聊喂给模型，产出「趣味向」结构化内容。
 *
 * 一次调用产出全部维度（省 token），结果按「群 + 日期」落盘缓存，同一天重复调用不再花 token。
 * 任何一步失败都不影响统计版报告：调用方拿到 null 就退回纯统计。
 */

export const ANALYSIS_VERSION = 1;

/** 采样喂给模型的消息：优先长消息（信息量大），总量受字符预算约束。 */
export function buildAnalysisInput(messages, { maxMessages = 160, maxChars = 2600 } = {}) {
  const usable = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && !m.isSelf && String(m.text ?? '').trim())
    .map((m) => ({ name: String(m.sender ?? '').trim() || '某人', text: String(m.text).trim() }));
  const picked = [...usable].sort((a, b) => b.text.length - a.text.length).slice(0, maxMessages);
  const lines = [];
  let used = 0;
  for (const m of picked) {
    const line = m.name + '：' + m.text.slice(0, 120);
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length;
  }
  return lines.join('\n');
}

/** 提示词：只要趣味字段，不要总结腔。 */
export function buildAnalysisPrompt({ groupName, dayText, transcript }) {
  const head = [
    '你是群聊观察员，负责给「' + groupName + '」写 ' + dayText + ' 的趣味日报。',
    '',
    '下面是当天群聊片段（每行「昵称：内容」）：',
    transcript,
    '',
    '请只输出一个 JSON 对象，不要 markdown 代码块，不要解释：',
    '{',
    '  "topics": [{"title": "话题短标题", "who": "主要参与者"}],',
    '  "titles": [{"name": "群友昵称", "title": "有趣称号", "reason": "一句话依据"}],',
    '  "ghost": [{"name": "疑似被 bot 夺舍的人", "reason": "为什么"}],',
    '  "repeat": [{"text": "被复读的话", "count": 3}],',
    '  "hottest": {"name": "今日最活跃", "comment": "一句吐槽"},',
    '  "lowest": {"name": "今日最空气", "comment": "一句调侃"},',
    '  "verdict": "用一句话锐评今天这个群"',
    '}',
    '',
    '要求：',
    '- topics 3~5 条，标题不超过 14 字；',
    '- titles 3~5 条，称号要有网感、不重复；',
    '- ghost 0~2 条：说话像模板/复读/只发指令的人；',
    '- repeat 0~3 条：真的被多人重复的话；',
    '- verdict 不超过 40 字，带点损但不人身攻击；',
    '- 只用提供的昵称，不要编造没出现的人。',
  ];
  return head.join('\n');
}
