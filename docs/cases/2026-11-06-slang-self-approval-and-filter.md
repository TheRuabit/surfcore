# 黑话库：从「等人工批准」改成「AI 自证 + 统计预筛」

> 2026-11-06。用户要求：不想手动给词义、也不想手动批准；旧链路让模型全量扫消息、花半天没效率。
> 参考 AstrBot [self_learning](https://github.com/NickCharlie/astrbot_plugin_self_learning)（AGPL-3.0，**只借鉴设计，未复制代码**）。

## 现象

1. 黑话库 296 条，其中 **293 条 candidate、meaning 全空**，`withSlangContext` 一条都注入不进去。
2. AI 从没用过 `qq_slang_submit` 把学到的词写进去。
3. 打开 learn 会「储存一堆没被批准也没有意义的黑话」，用户因此关掉了。

## 根因（逐条核实）

1. **tool 没有写词义的入口**：[`mcp-snowluma-safe.js:987`](../../src/mcp-snowluma-safe.js#L987) 的 schema 只有 `content`+`context`；
   [`bridge.js:8240`](../../src/bridge.js#L8240) 也只读这两个字段。所以「让 AI 自己写词义和通过」——**它没有这个手**。
2. **提交后一律 candidate**：[`bridge.js:8280`](../../src/bridge.js#L8280) 硬编码 `status: CANDIDATE`，AI 无法让它变 confirmed。
3. **研究只在 count 命中 `[2,4,8]` 时触发**（[`2939`](../../src/bridge.js#L2939)、[`8269`](../../src/bridge.js#L8269)），count=1 的词永远等不到。
4. **注入三重过滤** [`slang-learner.js:217`](../../src/slang-learner.js#L217) 要求 `confirmed && content && meaning` 同时成立。

## 完整逻辑

### 链路

```
群聊消息
  └─ feedSlangWindow
       ├─ slangFilter.updateFromMessage  ← 零 token，本地算分（不受 learn 开关影响）
       ├─ queueResearchFromFilter        ← 每 30min 最多一次，每日上限 10 次
       │    └─ 取出预筛 top-K → 建 candidate → runSlangResearch
       └─ learn=true 时才走旧 extractor（未改）
              ↓
        LLM 返回 meaning
              ↓
        meaning 非空 → status = confirmed  ← 不再要求模型返回 confirmed:true
              ↓
        withSlangContext：正文之后注入【群聊黑话表】

AI 主动调用
  └─ qq_slang_submit({content, meaning, usage, example, confidence})
       └─ 有 meaning 且 confidence !== 'low' → 直接 confirmed
```

### 机制

- **准入契约取代人工批准**：带 `meaning` 就生效，不带就进候选池。AI 想让它生效必须自己给词义。
- **统计预筛是零成本的那一半**：跨群 IDF + 突发频次 + 用户集中度 + 绝对频次，全部本地算。
  真实归档回放（4043 条）：**4014 个候选块筛到 95 个合格**，top 候选是「杂口杂口」这类真黑话。
- **为什么按标点切块而不是滑窗**：滑窗会把「破防了」切成「防了/了兄/防了兄」，实测 124 个词 0 个可用；
  `Intl.Segmenter` 的 zh 词典把「破防」拆成「破」「防」，同样不可用。按标点切块是唯一在真实数据上可用的方案。
- **为什么要求「>=2 个不同用户」**：真实数据里 bot 的固定话术（「剩余抽取次数」「请等待」）都是**单人高频**，
  这条规则把 142 个高频块降到 98 个，挡掉的几乎全是 bot 回声。
- **注入位置后移**：原来黑话拼在正文**前面**，每轮都变，把 prompt 前缀缓存整段打掉。

### 爆炸半径

- 进程：只有桥接。预筛零 token；研究受 `researchPerDayMax` + 冷静期双限。
- 数据：`state/slang.json` **不迁移、不重写**；293 条 candidate 原样保留，一条都不注入（与改前一致）。
- 读者：`slang-filter.js` 只被 bridge 和测试引用。

### 取舍

1. **不引 jieba**（Node 没有/Python 版依赖它）：改用标点切块 + 停用表。召回略低，但零依赖。
   实测能捞出「痒痒鼠暂时复活」「杂口杂口」这类群梗。
2. **不引数据库**：self_learning 用 SQLAlchemy，我们保持 JSON 文件，改动面最小。
3. **不自动转正存量 293 条**：它们没有词义，转正等于把噪音注入 prompt。
4. **置信度由模型自评**，不引二次校验模型（省 token）。
5. **预筛不受 `learn` 开关控制**：它零 token，关掉 learn 不该连本地统计一起停。

## 修法

- 新增 `src/slang-filter.js`：`createSlangFilter()` / `extractTerms()`。
- `bridge.js`：接入预筛、加 `queueResearchFromFilter`（含冷静期与每日配额）、
  `/slang/submit` 接收 `meaning/usage/example/confidence` 并执行准入规则、
  研究结果允许直接写 meaning 并转 confirmed、`withSlangContext` 黑话块移到正文之后。
- `mcp-snowluma-safe.js`：`qq_slang_submit` 加 4 个字段，描述明确「带 meaning 直接采纳」。
- `audit-bridge-harness.mjs`：登记 `slang-filter` 模块，暴露测试钩子。

## 验证

- `npm run test:slang`：**17 项全过**（filter 10 / submit 5 / inject 4）
- `npm run test:commands`：**33/33**
- `npm run test:regressions`：**16/16**
- `npm run test:audit`：**84/93**（基线 83/93 + 新增脚本通过；失败集合与基线完全一致）
- 真实归档回放：4014 块 → 95 个合格候选，零模型调用。

## 成本（用真实用量算）

基线：日均 579 条消息、约 300 次模型调用；flash 非高峰 miss ¥1 / hit ¥0.02 / out ¥4 每百万。

| 方案 | 成本/天 | 成本/月 |
|---|---|---|
| 每条消息都问模型 | ¥0.156 | ¥4.69 |
| **纯统计预筛** | **¥0** | **¥0** |
| 预筛 + 研究 3 词/天 | ¥0.005 | **¥0.16** |

## 生效

- **重启桥接**：预筛、准入、注入位置生效。
- **重启 DSH**：`qq_slang_submit` 的 schema 变了 —— **MCP 工具表是进程启动快照**，不重启模型看不到新字段。

## 回滚

`git revert` 本轮提交；`state/slang.json` 全程未被迁移或重写，可直接回退。

## 残余

- 停用表是硬编码的中文虚词表，遇到新的高频常规词会被误判成候选（表现为多花一点研究额度）。
- 预筛状态在内存里，桥接重启后从零开始积累（与 self_learning 原实现一致）。
- 「痒痒鼠暂时复活」这类**全群共用的梗**会被预筛排到很后面（14 人使用 → 集中度低），
  这是有意为之：它更像群内日常用语，不需要词义解释。
- 研究失败不重试，等下一次冷静期。
