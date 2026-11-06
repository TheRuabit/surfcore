# 群内命令必须 @机器人：裸斜杠丢弃、scopes 生效、失败留痕

> 2026-11-06。用户要求：群里 `@机器人 /命令` 才是通行证（裸 `/` 丢弃、不进 DSH）；
> `@` 后面的群名片要能从桥接拿到；`scopes` 必须真的检查；命令不受静默限制、不花 token；
> 聊天不再驱动 DSH 的斜杠命令。

## 现象

1. 群友按真实习惯发 `@寻玉型大肥鱼 /reset`，命令**根本没被执行**。
2. 插件的 `atTargets[].name` 永远是空串。
3. 插件声明 `scopes: ['private']` 的命令，在群里照样执行。
4. 命令消息会污染记忆卡、黑话学习窗口和公开流。

## 根因

1. 命令判定写的是 `plainContent.startsWith('/')`，而 `plainContent` 由 `segmentsToText`
   渲染，开头的 at 段会变成 `@群名片`。全仓没有任何地方剥这个前缀。
   真实归档 3513 行里：裸 `/xxx` **0 条**，`@机器人 /xxx` **10 条** —— 即真实用法 100% 不命中。
2. `seg.data.name` 依赖上游给名字；OneBot at 段只保证 `qq`（归档里 7 条 `@2282845568`
   就是解析失败时回退成号码的证据）。
3. `validateSpec` 只把 `scopes` 存下来，`dispatch` 从未读取。
4. `recordMemoryInboxEvent` / `feedSlangWindow` / `appendPublicFeed` 都只用
   `startsWith('/')` 过滤，前缀变成 `@鱼` 后全部漏过。

## 完整逻辑

### 链路

```
QQ 群
  └─ SnowLuma → 桥接 handleIncoming
       ├─ segmentsToText → plainContent（"@群名片 /命令"）
       ├─ leadingSelfAtCount(段, selfUserId)   ← 新增：数开头几个「@自己」
       ├─ segmentsToText(剩余的段) → commandTail
       ├─ resolveCommandText(...)  ← 新增：纯函数判定
       │    ├─ 群聊 + 有前导@ + 剩下是 "/" → 命令
       │    ├─ 群聊 + 无前导@ + "/"        → 裸斜杠，丢弃并留痕
       │    ├─ 私聊 + "/"                  → 命令（不需要 @）
       │    └─ 其它                         → 普通对话
       ├─ 记忆卡/黑话/公开流：用 isCommand 排除
       ├─ 静默模式：命令放行，其余照旧不投递
       └─ commandHost.dispatch({ raw: commandText, plain, hadAtPrefix, atTargets })
```

### 机制

- **为什么按段切而不是剥字符串**：`@` 后面渲染的是**群名片**，和机器人昵称未必同名
  （归档里 `@寻玉型大肥鱼` 是群名片，账号昵称是 `deepseek`）。按字符串匹配会漏。
  按段切只认 `seg.data.qq === selfUserId`，精确且与显示名无关。
- **为什么裸斜杠要丢弃而不是当普通消息**：当普通消息就会进 DSH → 模型回合 → 花钱，
  等于「用斜杠调起对话」，正是用户要去掉的调试行为。
- **为什么 `unknown` 要返回 `matched: true`**：返回 `matched:false` 会让桥接把它当普通消息
  投给 DSH。未注册的命令必须"到此为止"。
- **为什么 `setEnabled` 改成先激活后落盘**：旧顺序在激活抛错时已经写了 `enabled:true`，
  UI 显示「已启用/未加载」，重启后反复失败，且用户无法用"停用"回到干净状态。

### 爆炸半径

- 进程：只有桥接。命令不经过 DSH，0 token。
- 读者：`state/command-plugins.json`（开关）、`state/command-log.jsonl`（日志，新增 `.seq` 侧车）。
- 数据：不碰记忆卡（命令被显式排除）、不碰身份对齐。
- 兼容：`ctx` 只增字段（`plain` / `hadAtPrefix`），`raw` 语义改成"剥离后"，示例插件不受影响。

### 取舍

1. **按消息段切 vs 按字符串剥**：字符串剥实现简单但依赖显示名，会漏；选按段切。
2. **裸斜杠丢弃 vs 回一句提示**：回提示会让每个手滑的人被 bot 打扰，且用户明确要求丢弃；选丢弃 + 留痕。
3. **命令走静默 vs 不走**：命令不产生模型回合，静默的本意是省钱省打扰；选放行（Q4）。
4. **命令回复走 sendToQQ vs 保持段发送**：`sendToQQ` 只吃纯文本，拼不出 at 段前置；
   保持 `sendCommandReply`，但补 `captureSendGuard` + `sendDelayMs`（Q5）。
5. **日切信宿主时区 vs 钉死 +08:00**：宿主机搬去别的时区就错；选钉死 `Asia/Hong_Kong`。

## 修法

- 新增 `src/command-text.js`（`leadingSelfAtCount` / `resolveCommandText`）、`src/day-key.js`（`dayKey` / `msUntilNextDay`）。
- `bridge.js`：命令判定改用解析结果；裸斜杠记 `dropped/bare-slash` 并 return；
  删掉 `forwarded-dsh` 转发（改为 `dropped/unknown-slash`）；`atTargets` 用
  `resolveGroupMemberName` 补 name；静默分支放行命令；记忆/黑话/公开流用 `isCommand` 排除；
  `sendCommandReply` 补会话守卫。
- `command-host.js`：检查 `scopes`（`scope-mismatch`）、未注册命令写 `unknown`、
  handler 超时（`plugin-timeout`，默认 5s）、`setEnabled` 先激活后落盘。
- `command-log.js`：轮转不再把 `seq` 归零，并用 `<file>.seq` 侧车跨重启保存水位。
- `client.js`：Log Terminal 四处 toast 带上 `e.hint`。
- `audit-bridge-harness.mjs`：把两个新模块注入测试沙箱（否则 vm 载入的 bridge 找不到符号）。

## 验证

- `npm run test:commands`：**31/31**（text 9 / log 3 / host 9 / example 1 / wiring 9）。
- 新增用例：@前缀 4 种、私聊放行、scopes 双向、unknown 留痕、超时、激活失败不落盘、
  静默放行、记忆不污染、seq 不归零、日切边界（15:59:59Z → 11-05、16:00:01Z → 11-06）。
- `npm run test:regressions`：**16/16**。
- `npm run test:audit`：**83/93**，与未改动基线（同环境跑 `.verify-baseline` worktree）**完全一致**，
  无新增失败。基线 9 个失败均为既有环境/flaky 项。

## 生效

- **重启桥接**：新判定、守卫、超时、日志生效。
- **重启 DSH**：仅当需要 Log Terminal 的新 toast 文案（`client.js`）。
- 验证：群里 `@鱼 /回声 你好` 有回；裸 `/回声 你好` 无回且日志有 `bare-slash`；
  群友 `@鱼 /插件状态` 无回且日志 `not-owner`；私聊 `/reset` 正常。

## 回滚

`git reset --hard backup/plugin-iface-20261106`（标签 `snapshot-plugin-iface-20261106` 指向同一提交）。
删掉 `state/command-log.jsonl` 与 `.seq` 不影响 QQ 主流程。

## 残余

- 同步 IO（`appendFileSync`/`readFileSync` 整读归档）仍在，违反 12 课 §0；本轮未动。
- 限流 map 的清理条件（`rate.size > 500`）对"同一分钟大量不同用户"无效；用户明确说不用担心。
- `text()`/`normalizeText()` 重复、`readJson+writeJsonAtomic` 三份、`list()` 的 O(n²) 未清理。
- README 曾写"桥接负责分条"，实际只有截断；本轮已改文档，未实现分条。
