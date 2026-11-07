# 今日群报插件：把聊天聚合成日报，默认只落盘预览

> 2026-11-07。用户想要一个抽老婆之外的玩法插件。先做纯统计版（0 token），
> 且**默认只写本地文件、QQ 只回一句提示**，方便先看样式再决定要不要发群。

## 现象

命令插件接口就绪后只有示例插件（`/回声`），没有真实业务。需要第一个能验证接口的插件。

## 根因

做群报需要「某一天某群的全部消息原文」，而现有接口给不了：

| 数据源 | 能力 | 为什么不够 |
| --- | --- | --- |
| `api.qq.activeMembers` | 只有 `{userId,sender,count,lastTime}` | **没有文本** |
| `social-v2.json` 的 `recentMessages` | 有文本 | **只保留最近 100 条**，单日 562 条 |
| `message-archive.jsonl` | 全量 | 插件直接读会硬依赖内部文件；且它**受 `vectorMemory` 开关控制** |

## 完整逻辑

### 链路

```
群友 @鱼 /今日群报
  → 桥接 dispatch → daily-report 插件 handler
       → 算 UTC+8 当天的 [00:00, 次日 00:00) 绝对时间窗
       → api.qq.messages({ key, since, until })
            → bridge.readArchiveMessages（只读归档，按时间窗过滤）
       → aggregateMessages（纯函数：过滤/采样/统计）
       → renderReport（纯函数：模板拼文本，受 maxChars 约束）
       → 写 state/command-plugins/daily-report/reports/group-<id>/<day>.txt
       → previewOnly ? 回一句短提示 : 回完整报告
```

### 机制

- **不调模型**：全程模板拼装，0 token，5 秒超时塞得下。
- **采样用混合法**：每用户按长度降序取 2 条（保证人人到场）+ 全群最长 8 条（捞梗），
  再去重、每条截断 60 字。理由：真实数据里 29 人、562 条，全量 12k token。
- **默认 previewOnly**：完整报告落盘，QQ 只回「群报已生成：11-06，559 条 / 29 人（预览模式，未播报）」。
  这是用户明确要求的「先拦截下来本地看样式」。
- **日切钉死 +08:00**：用 `src/day-key.js` 的 `dayKey`，不信宿主时区。
- **失败结构化**：归档不可用返回 `{ok:false, code:'archive-missing', hint}`，插件把 hint 一起回给发命令的人。

### 爆炸半径

- 进程：桥接。插件在桥接进程执行，读归档、写自己的 dataDir。
- 花钱：**0 token**（不调模型）。
- 数据：只写 `state/command-plugins/daily-report/`，不碰记忆卡/身份对齐。
- 隐私：报告里只有**群名片**，没有 QQ 号；私聊记录永不进报告（`readArchiveMessages` 只接受 `group:`）。

### 取舍

1. **新增 `api.qq.messages` vs 插件直接读归档**：直接读少改代码，但插件会硬依赖由另一个功能
   （向量记忆）控制开关的内部文件，且无法感知「读到的是三天前的最后一条」。选新增接口。
2. **纯统计 vs AI 点评**：先纯统计（0 token、立刻能测）；AI 点评作为 v2 增量。
3. **全量 vs 采样**：全量 12k token 太贵；选混合采样（约 80 条）。
4. **直接发群 vs 落盘预览**：用户要先看样式，选默认落盘。
5. **插件自己判 fish-guard vs 不判**：`evaluateConversationFishGuard` 是桥接内部函数，插件拿不到；
   默认 `autoReport:false` 完全不动 QQ，把风险降到 0。

## 修法

- 新增 `src/daily-report-core.js`：`normalizeText` / `isReportable` / `aggregateMessages` / `renderReport`（纯函数）。
- 新增 `src/bridge.js` 的 `readArchiveMessages`，装配成 `readMessages` 传给 `createCommandHost`。
- `src/command-host.js` 的 `makeApi` 增加 `api.qq.messages`，失败**原样返回**（不像 activeMembers 吞成 []）。
- 新增插件包 `plugins/surfcore/command-plugins/daily-report/`（`enabled:false`）。
- 命令：`/今日群报`（user, scopes:['group']）、`/群报设置`（admin）。
- 配置：`previewOnly:true` / `autoReport:false` / `topUsers` / `picks` / `perUser`。

## 验证

- `npm run test:commands`：**57/57**（core 12 / log 3 / host 11 / example 1 / wiring 13 / text 9 / plugin 8）。
- `npm run test:regressions`：16/16。
- `npm run test:audit`：**86/95**，失败项与改动前基线完全一致（9 个既有环境/flaky 项），新增 2 个脚本都通过。
- **真实归档冒烟**（2026-11-06，562 条 / 29 人）：生成的报告 426 字，含条数/人数/最活跃/高峰/精选。

## 生效

- **重启桥接**（新接口 + 新插件）→ 设置页启用「今日群报」。
- 不改 DSH、不重启 DSH。
- 验证：群里 `@鱼 /今日群报` → 回「群报已生成…（预览模式）」；
  开 `state/command-plugins/daily-report/reports/group-<群号>/<日期>.txt` 看正文。
  私聊发该命令 → 无回复，Log Terminal 记 `scope-mismatch`。

## 回滚

- 停用插件即可；代码 `git revert`；删 `state/command-plugins/daily-report/` 无副作用。

## 残余

1. **自动播报不遵守 fish-guard**：插件拿不到 `evaluateConversationFishGuard`。默认 `autoReport:false`，
   开启后可能和其他 bot 撞车。要严格遵守需桥接再暴露 `api.qq.fishBlocked({key})`。
2. 自动播报**缺少群上下文**：定时器触发时没有 `ctx.key`，当前实现只写日志不发送��
   要做「到点自动发到某群」需要插件配置里存群号。
3. 报告里可能混入**其他 bot** 的发言（无法从消息本身区分真人/机器人）。
4. 归档文本入库时已截断到 200 字，精选里拿不到更长原文。
5. 精选是「按长度」而非「按信息量」，会偏长消息。

## 发布交接（草稿）

- 范围：`src/daily-report-core.js`（新）、`src/bridge.js`、`src/command-host.js`、
  `plugins/surfcore/command-plugins/daily-report/`（新）、`plugins/surfcore/command-plugins/README.md`、测试/文档。
- 测试：`npm run test:commands`、`npm run test:regressions`、`npm run test:audit`。
- 生效：重启桥接 + 设置页启用插件。
- 验证：群里 `@鱼 /今日群报` 看到预览提示，本地报告文件有正文。
---

## 2026-11-08 追加：命令超时误杀 + 话痨榜条数回归

### 现象

按用户要求触发真实 `/今日群报 2026-11-07`（404 条 / 25 人）时：

1. 长图里群名是「**本群**」而不是「幼儿园」，**没有锐评、没有话题/称号/夺舍榜**；
2. 命令日志 `plugin-timeout / 插件处理超过 5000ms`，`回复条数: 0`；
3. 几分钟后磁盘上分析缓存和长图**都生成好了** —— 说明插件跑完了，只是没人等它。

### 根因（两个独立问题）

**A. 测试旁路缺接口（不是插件缺陷）**

`scripts/trigger-command.mjs` 只注入了 `readMessages` / `readMembers`，没注入
`readGroupName` 和 `analyze`。插件里这两处都写了 `if (!api.qq.groupName)` 式的降级，
于是平稳退化成「群名=本群、分析=null」，渲染成功、不报错 —— **降级路径把缺接口伪装成了正常输出**。
补上两个注入（`analyze` 转发到桥接进程内的 `/api/commands/analyze`，因为 DSH 会话只能由桥接进程创建）。

**B. 5 秒全局超时（生产真 bug）**

`command-host` 的 `handlerTimeoutMs` 默认 5000ms。`Promise.race` 只放弃等待，**不取消**插件里已启动的
异步任务 —— 所以 token 照烧、文件照写，用户什么都没收到。LLM 分析约 20s，必然触发。

### 修法

- `command-host.js`：`register()` 接受自报 `timeoutMs`，夹在 `[500, 180000]`；不声明走全局默认。
- `daily-report/index.js`：声明 `analysisTimeoutMs + 30s`。
- 超时 hint 里写**实际生效**的毫秒数。
- `templates/report.typ`：话痨榜第三列恢复 `str(r.count)`（`9b26049` 重排版面时丢的，列宽 30pt 还在）。

### 验证

- `node scripts/test-command-host.mjs`：**13/13**（新增 2 条：自报超时突破默认 / 不声明仍走默认且 hint 带实际值）。
- `npm run test:commands` 全量：**58/58**。
- 真实触发：`outcome: ok`、`durationMs: 1302`、`reply: true`（上一次是 `5002ms / plugin-timeout`）。
- 长图：群名「幼儿园」、夺舍榜 2 条、锐评「有人办空壳婚礼，有人发报错，这群白天全靠碎片续命」、
  话痨榜条数 64/58/41/38/35/30/21/21/17/15。

### 残余

1. `autoReport` 仍不能自己发群（定时器触发时没有 `ctx.key`），只写日志。
2. 第二条真实触发命中了分析缓存，所以 `durationMs` 只有 1302ms —— 冷启动（要调模型）的耗时
   本轮**没有**在真实触发里复现，只有先前那次被掐断的 20s 观测。重启桥接后要再验一次。
3. 字体 `NotoSansSC-VF.ttf` 17MB 未做子集化。
