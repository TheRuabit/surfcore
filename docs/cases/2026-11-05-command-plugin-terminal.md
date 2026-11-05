# 命令插件接口 + Log Terminal：失败只记日志，不回 QQ

> 2026-11-05。用户要求：非管理员 `/` 失败不再直接回复，改写入本地 Log Terminal；并做一个通用命令插件接口，先只做接口 + 示例插件，wifepicker/AstrBot 以后作为独立插件接。

## 现象

- 群里任何人输入 `/model`、`/reset` 等，桥接都回「管理命令仅管理员可用。」。
- 没有通用入口让本地插件注册 `/` 命令；现有 `extensions/` 跑在 DSH 进程，命令在桥接进程，直接复用会把命令再绕回 DSH。
- 用户明确不想把 wifepicker 业务代码拆进 SurfCore 核心，也不想本轮强兼 AstrBot。

## 根因

1. `/` 的权限判断和回复都写死在桥接 `handleIncoming`：非管理员统一 `sendToQQ(...)` 后 return。
2. 桥接没有命令注册表；`extensions/` 的 `ExtensionHost` 在 DSH 宿主进程，QQ 消息在桥接进程，进程边界决定了它不能直接拦截 `/`。
3. AstrBot 插件是 Python + AstrBot API；JS 接口不能直接执行，本轮不做兼容层。

## 完整逻辑

### 链路

```
QQ 群
  └─ SnowLuma（只做 OneBot 传输）
       └─ 桥接 src/bridge.js
            ├─ 黑名单/静默
            ├─ CommandHost.dispatch（新）
            │    ├─ 命中 user/admin 插件命令
            │    │    ├─ 成功 → sendCommandReply → QQ
            │    │    └─ 权限/禁用/限流/异常 → 只写 state/command-log.jsonl
            │    ├─ 未命中 → 桥接内置管理命令（/reset /status /role /silent …）
            │    │    ├─ 管理员：原行为 + 日志
            │    │    └─ 非管理员：只日志，不回 QQ
            │    └─ 管理员未知命令 → 记 forwarded-dsh，继续投给 DSH
            └─ DSH（只接管理员未知命令；命令本身不经过模型）
```

### 机制

- **CommandHost 在桥接进程**：扫描 `plugins/surfcore/command-plugins/` 和 `~/.dsh/surfcore/command-plugins/`，读取 manifest，加载 `enabled` 插件。
- 插件通过 `api.commands.register()` 注册命令；命令在桥接进程直接执行，不产生 DSH turn/token。
- **失败只日志**：权限不足、未知、插件未启用、插件异常、限流统一 `commandLog.append()`，不调用 `sendToQQ`。
- **成功才回复**：插件返回 `{text,image,atUserId,silent}`，桥接用 `sendCommandReply` 发送；`silent` 只日志。
- **Log Terminal**：`state/command-log.jsonl`（2000 条/1MB 轮转），桥接 `/api/commands/*`，设置页代理 `/commands/*`，新 tab 轮询展示。
- **不碰 DSH**：命令执行只依赖桥接 + SnowLuma；DSH 挂了插件命令仍能工作（设置页 UI 除外）。
- **插件包独立**：核心不含 wifepicker 业务；以后 wifepicker 是独立 `command-plugins/wifepicker/` 包，可装卸，不改核心。

### 爆炸半径

- 进程：桥接单进程；插件代码在该进程执行，启用 = 信任。
- 读者：命令日志只被本机设置页读；`state/command-plugins.json` 只被桥接读写。
- 数据：不写记忆卡/身份对齐；示例插件只写自己的 `dataDir`。
- 花费：命令不经过模型，0 token；不碰 DSH。

### 取舍

1. **桥接侧 CommandHost vs 复用 ExtensionHost**：复用会经过 DSH，DSH 挂则命令挂；选择桥接侧，代价是插件 API 与 DSH 扩展分开。
2. **新目录 vs 现有 extensions/**：同一份代码不能同时假定两种 API；新目录避免双进程加载。
3. **原生 JS 接口 vs AstrBot 兼容**：本轮只定义原生接口；AstrBot 兼容是独立 sidecar 计划，避免把 Python/Playwright/SQLite 拖进核心。
4. **失败只日志 vs 回 QQ**：按用户要求 fail-closed 不回复；插件主动返回的友好提示（缺 @、次数用完）仍回复。

## 修法

- 新增 `src/command-host.js`、`src/command-log.js`、`src/shared-store.js`。
- 桥接 `handleIncoming` 插入命令分发；删除非管理员 `sendToQQ('管理命令仅管理员可用。')`；管理员内置命令保留回复并记日志；管理员未知命令记 `forwarded-dsh`。
- 新增 `/api/commands/plugins`、`/api/commands/log`、`/api/commands/log/clear`。
- 设置页新增 `CommandTerminalTab`（tab `commands`），代理 `/commands/*`；显示插件开关/重载/配置 + 终端日志。
- 新增示例插件 `plugins/surfcore/command-plugins/example/`：`/回声`（user）、`/插件状态`（admin），默认关闭。
- `plugins/surfcore/command-plugins/README.md` 记录接口；`extensions/README.md` 标注两类扩展的区别。

## 验证

- `node scripts/test-command-host.mjs`：5/5（启停/权限/异常/限流/双目录/重复 id/路径穿越/用户目录不自动启用）。
- `node scripts/test-command-log.mjs`：3/3（追加/过滤/轮转/clear）。
- `node scripts/test-command-example.mjs`：1/1。
- `node scripts/test-command-wiring.mjs`：3/3（桥接不再直接回失败、UI/接口存在）。
- `plugins/surfcore/scripts/test-client-contract.mjs`：通过。
- `npm run test:regressions`：16/16。
- `npm run test:audit`：88/93；新增 4 个命令测试全过。剩余 5 个：
  - `test-audit-security-mcp`（既有 2 条工具注册）
  - `test-audit-setup-guards`（start.bat CRLF）
  - `test-qq-preset-contract`（压缩预算阈值）
  - `test-release-manifest`（工作区 dirty 发布门禁）
  - `test-voice-pack-import`（并行跑时临时目录 ENOENT；单独跑通过，属 flaky，与本轮无关）

## 生效

- **桥接重启**：加载 CommandHost、日志、示例插件。
- **DSH 重启**：加载设置页新 tab 与 `/commands` 代理。
- 在设置 → Log Terminal 启用「命令插件示例」。
- 验证：群友 `/回声 你好` 有回复；群友 `/model` 无回复；Log Terminal 出现对应条目；DSH 无新 turn/token。

## 回滚

- 停用/删除插件包；删除 `state/command-plugins.json`、`state/command-log.jsonl` 不影响 QQ 主流程。
- 代码回退：revert 本轮提交；桥接重启后恢复旧行为（非管理员回管理命令提示）。
- 不碰用户记忆卡/身份对齐数据。

## 残余

- 插件停用后如果 **桥接重启**，命令元数据不保留，群友再发会记 `unknown-command` 而不是 `plugin-disabled`；两者都不回复，不会执行。后续可在 manifest 声明 commands 元数据解决。
- 本轮不做无前缀关键词、私聊专属策略、AstrBot、贴吧。
- 插件代码在桥接进程有完整本机权限；本轮不做 worker 沙箱。
- 示例插件默认关闭；不启用时群友发 `/回声` 会记录为 unknown。

## 发布交接（草稿）

- 范围：`src/command-host.js`、`src/command-log.js`、`src/shared-store.js`、`src/bridge.js`、`plugins/surfcore/lib/index.js`、`plugins/surfcore/lib/client.js`、`plugins/surfcore/command-plugins/*`、测试/文档。
- 测试：`npm run test:audit`、`npm run test:regressions`、`plugins/surfcore` 的 `npm test`。
- 生效：重启桥接（命令宿主/日志）+ 重启 DSH（设置页 tab/代理）。
- 验证：启用示例插件 → `/回声 你好`；非管理员 `/model` 无回复且 Log Terminal 有记录。
