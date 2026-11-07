/**
 * 群报 LLM 分析：把一天的群聊喂给模型，产出「趣味向」结构化内容。
 *
 * 一次调用产出全部维度（省 token），结果按「群 + 日期」落盘缓存，同一天重复调用不再花 token。
 * 任何一步失败都不影响统计版报告：调用方拿到 null 就退回纯统计。
 */

import fs from 'node:fs';
import path from 'node:path';

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

/** 解析模型输出：容忍纯 JSON / 代码块包裹 / 前后带解释。失败返回 null。 */
export function parseAnalysisJson(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const tryParse = (input) => {
    try {
      const v = JSON.parse(input);
      return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
    } catch { return null; }
  };
  const direct = tryParse(raw);
  if (direct) return direct;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const v = tryParse(fenced[1].trim());
    if (v) return v;
  }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const v = tryParse(raw.slice(start, end + 1));
    if (v) return v;
  }
  return null;
}

const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * 规范化分析结果：裁剪长度 + 剔除不在成员表里的昵称。
 *
 * 模型会编造不存在的人（尤其「称号」这种自由发挥的字段），不校验就会在报告里出现幽灵群友。
 */
export function normalizeAnalysis(raw, members, { maxTopics = 5, maxTitles = 6, maxGhost = 3 } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const known = new Set();
  for (const m of Array.isArray(members) ? members : []) {
    const card = String(m?.card ?? '').trim();
    const nick = String(m?.nickname ?? '').trim();
    if (card) known.add(card);
    if (nick) known.add(nick);
  }
  const keepName = (name) => {
    const n = clip(name, 24);
    if (!n) return '';
    if (!known.size) return n;
    return known.has(n) ? n : '';
  };
  const arr = (v) => (Array.isArray(v) ? v : []);

  const topics = arr(raw.topics).map((t) => ({
    title: clip(t?.title, 18),
    who: clip(t?.who, 40),
  })).filter((t) => t.title).slice(0, maxTopics);

  const titles = arr(raw.titles).map((t) => ({
    name: keepName(t?.name),
    title: clip(t?.title, 14),
    reason: clip(t?.reason, 34),
  })).filter((t) => t.name && t.title).slice(0, maxTitles);

  const ghost = arr(raw.ghost).map((g) => ({
    name: keepName(g?.name),
    reason: clip(g?.reason, 38),
  })).filter((g) => g.name && g.reason).slice(0, maxGhost);

  const hottestName = raw?.hottest ? keepName(raw.hottest.name) : '';
  const hottest = hottestName
    ? { name: hottestName, comment: clip(raw.hottest.comment, 30) }
    : null;
  const verdict = clip(raw.verdict, 60);

  if (!topics.length && !titles.length && !verdict) return null;
  return { version: ANALYSIS_VERSION, topics, titles, ghost, hottest, verdict };
}

/** 缓存文件路径：<dataDir>/analysis/group-<id>/<dayKey>.json */
export function analysisCachePath(dataDir, groupId, dayKey) {
  const gid = String(groupId ?? '').replace(/[^0-9]/g, '') || 'unknown';
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(dayKey)) ? String(dayKey) : 'unknown';
  return path.join(dataDir, 'analysis', 'group-' + gid, day + '.json');
}

/** 读缓存。版本不符或文件损坏都当没有。 */
export function loadCachedAnalysis(dataDir, groupId, dayKey) {
  const file = analysisCachePath(dataDir, groupId, dayKey);
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || data.version !== ANALYSIS_VERSION) return null;
    return data;
  } catch { return null; }
}

/** 写缓存（原子写）。 */
export function saveCachedAnalysis(dataDir, groupId, dayKey, analysis) {
  const file = analysisCachePath(dataDir, groupId, dayKey);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(analysis, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return file;
  } catch { return ''; }
}