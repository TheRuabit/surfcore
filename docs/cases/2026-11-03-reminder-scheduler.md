# 定时提醒：她说“没有定时器，只有 wait”

> 2026-11-03。用户要「九点半叫我」，她连 wait 600 秒 ×3；DSH Scheduler 在 QQ preset 被安全边界 ban，而 `qq_set_wake_config` 的 `sleepUntil` 是一次性、可被其他唤醒顶掉、且不能立刻设。新增独立 `qq_set_reminder`。

## 现象

- 用户 21:05:44：「九点半叫我……」；21:05:50 她回「我没有定时器，只有等：一次最多十分钟……wait 就是我唯一的闹钟」；21:05:55 调用 `qq_wait_for_messages(timeoutMs=600000)`。
- 日志里 600 秒 wait 正好 3 次（11-02 17:39、17:49、11-03 13:05）；49 次 `qq_set_wake_config` 全是 `infinite:true`，0 次 `sleepUntil`/`sleepMs`。
- 影响：用户明确要求的时间点叫醒，被拆成多次长等待；wait 还会被 lease/429 拦。

## 根因

1. `schedule_create/list/update/delete` 在 QQ preset 被 [qq-tool-restrict.mjs:93](../../plugins/surfcore/qq-tool-restrict.mjs#L93) 归为「无人值守的自我调度」，注册期隐藏 + 执行期白名单拒绝；不是没装。
2. 唯一近似定时器的 `qq_set_wake_config` 有四个限制：
   - **不能立刻设**：`preSleepWaitBlockedV2` 要求最近 180 秒无消息或完成一次沉睡前观察（[bridge.js:6014](../../src/bridge.js#L6014)）。
   - **会被顶掉**：任何真实唤醒都会清 `sleepUntil`（[bridge.js:13173](../../src/bridge.js#L13173)）；私聊消息无条件唤醒（`kind === 'private'`），主动机会也不看 `sleepUntil`。
   - **一次性**：成功唤醒后定时器消失，需要重新设。
   - **不存提醒内容**：到点只是“有限潜水时间到”，模型得自己想起来要说什么。
3. 提示词里没有“定时提醒”的用法；`qq_set_wake_config` 被描述成「潜水/唤醒条件」，她自然用 wait 硬等。

## 完整逻辑（给用户看的那一遍）

- **链路**：QQ 消息 → 桥接 `handleIncoming` → 模型调用 `qq_set_reminder` → `/api/socialV2/reminder` → `reminderScheduler.set()` 落盘 `state/reminders.json` 并起独立 timer。
- **到点两种模式**：
  - `wake=false`：桥接直接 `sendToQQ(key, text)`，不叫模型，不花 token。
  - `wake=true`：`wakeForReminder()` 把 `{text, at, lateMs}` 写进 `st.reminderWake`，调 `sendWakePromptV2(key,'reminder')`；模型醒来看到【定时提醒】原文，自己决定说什么/做什么。
- **独立性**：提醒 timer 不读也不改 `wakeConfig.sleepUntil`；沉睡前观察、对话活跃度、其他唤醒都不会取消它。私聊/暂停/模式变化时 `wake=true` 退化为直接发文本（仍走 `sendToQQ` 的发送闸门）。
- **持久化/补发**：`state/reminders.json` 跨重启；启动时 `load()` 重排；过期 ≤30 分钟补发（文本前加“补发”），超过 30 分钟丢弃并记日志。
- **繁忙/限频**：`sendWakePromptV2` 繁忙时把 `reminder` 放进 `pendingWakeReasons`，回合结束由 `replayPendingWakeReasonsV2` 调 `wakeForReminder`；`st.reminderWake` 跨重放保留。
- **爆炸半径**：1 个桥接进程 × 1 个提醒文件；只碰已授权会话的文本；不碰密钥；`wake=false` 不花 token，`wake=true` 多一轮模型调用。

## 修法

- 新增 [reminder-scheduler.js](../../src/reminder-scheduler.js)：`set/cancel/list/load/checkDue/close`，原子 JSON 落盘，远未来分段续期，失败重试 3×60s。
- 新增 MCP 工具 `qq_set_reminder`（[mcp-snowluma-safe.js](../../src/mcp-snowluma-safe.js)）：`key/token/at/text/wake/cancelId`，一个工具两种模式。
- 桥接新增 `/api/socialV2/reminder`（agent token + 模式/白名单 + `setReminder` 开关），**不经过** `preSleepWaitBlockedV2`。
- `socialV2.tools.setReminder` 默认 true；`config.example.json` / 文档同步。
- `st.reminderWake` 随 `social-v2.json` 持久化；`buildWakePromptV2` 增加 `reminder` 分支；`sendWakePromptV2` 返回 `{ok/skipped/queued}` 供兜底判断。
- preset 增加「定时提醒」规则：用户说 X 点叫我时用 `qq_set_reminder`，不要用 wait 硬等。

## 取舍

- **一个工具两种模式 vs 两个工具**：一个 `wake:false/true` 省 schema（约 326 tokens，按仓库 2.2 字符/token 估；实际更低），也避免模型选错工具。
- **直接发 vs 唤醒模型**：`wake=false` 不花 token、最可靠；`wake=true` 保留模型判断（需要看消息/记忆/上下文时）。默认 false。
- **独立 scheduler vs 复用 `sleepUntil`**：复用会被顶掉且不存内容；独立文件/timer 才能满足“设完继续聊，到点系统叫我”。
- **不放开 `schedule_*`**：那等于把无人值守自我调度交给群聊，违反 L7；专用 reminder 只做已授权会话的一次性提醒。

## 验证

- 自动化：`npm run test:reminder` 7/7（set/cancel/持久化/过期补发/wake 两种模式/接线）；`npm run test:memory` 11/11 + 12/12；`npm run test:regressions` 16/16。
- `npm run test:audit` → 85/89；剩余 4 个为既有失败：`test-audit-security-mcp`（2 条工具注册）、`test-audit-setup-guards`（start.bat CRLF）、`test-qq-preset-contract`（压缩预算阈值 12k vs 测试期望 50k）、`test-release-manifest`（工作区 dirty 的发布门禁）。`test-token-guard` 已恢复通过（前置同步把 preset 的“8 条上限/不要拆 10 条”文案删了，本轮补回）。
- 未验证：真实桥接重启后的到点触发（需要部署后实测）；`wake=true` 在繁忙/限频下的补发路径需要实机观察一轮。
- Schema：`qq_set_reminder` description+schema 717 字符 ≈ 326 tokens（2.2 字符/token），满足 ~300 目标。

## 回滚

- 代码：`git revert` 本次提交；或从上一个本地快照 `7f7aa1b` 恢复。
- 数据：`state/reminders.json` 可删；`state/social-v2.json` 的 `reminderWake` 为可选字段，旧版本忽略。

## 发布交接（草稿）

- 范围：`src/reminder-scheduler.js`、`src/bridge.js`、`src/mcp-snowluma-safe.js`、`config.example.json`、`dsh/agent-presets/qq-chat-v2/agent.cordis.yml`、`plugins/surfcore/presets/qq-chat-v2.patch.yml`、测试/文档。
- 测试：`npm run test:reminder`、`npm run test:memory`、`npm run test:regressions`、`npm run test:audit`。
- 生效：**重启 DSH**（让 MCP server 重新注册 `qq_set_reminder`，并应用 preset 提示词）+ 重启桥接（加载 scheduler 与 `/api/socialV2/reminder`）。
- 验证：QQ 里说「21:30 叫我」→ 看 `state/reminders.json` 有记录、`bridge.log` 有 `[提醒] 已设置`；到点看 `[提醒] 已触发` 与 QQ 消息。
