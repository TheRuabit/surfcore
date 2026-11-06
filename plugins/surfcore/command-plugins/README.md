# 命令插件（桥接侧）

这里放**斜杠命令插件**：命令由 QQ 桥接进程直接执行，不经过 DSH、不产生模型请求。

> 和 `plugins/surfcore/extensions/` 的区别：
> - `extensions/` 在 DSH 宿主进程里跑，负责平台适配/后台任务/设置页路由；
> - `command-plugins/` 在桥接进程里跑，只负责 `/` 命令和即时回复。
> 两者不要混放，否则会出现同一份代码被两个进程加载。

## 目录

```
command-plugins/<id>/
  manifest.json
  index.js
  data/            # 运行时生成，不入库
```

宿主会扫描两个目录：

1. `plugins/surfcore/command-plugins/`（随仓库的示例/内置插件）
2. `~/.dsh/surfcore/command-plugins/`（用户 drop-in 插件，不改核心）

同 id 同时存在两处会被拒绝（`duplicate-id`），不会静默覆盖。

## manifest

```json
{
  "id": "example",
  "name": "命令插件示例",
  "version": "0.1.0",
  "description": "一句话说明",
  "entry": "index.js",
  "enabled": false,
  "capabilities": ["qq.command"],
  "platforms": ["qq"],
  "author": "local"
}
```

- `id`：`^[a-z][a-z0-9_-]{1,31}$`
- `entry`：必须落在插件目录内
- 默认 `enabled: false`；开启等于允许本地代码在桥接进程执行
- 状态文件：`state/command-plugins.json`

## index.js

```js
export async function activate(api) {
  api.commands.register({
    name: '回声',
    aliases: ['echo', 'ping'],
    permission: 'user',          // user | admin
    scopes: ['group', 'private'],
    description: '回显参数',
    async handler(ctx, args) {
      return { text: args || '接口正常。' };
    }
  });
}
```

返回：

```js
{ text?: string, image?: string, atUserId?: string, replyToMessageId?: string, silent?: boolean }
```

- `text` ≤500 字；超出部分被截断（**不分条**，需要分条请自己拆多次返回）
- `image` 支持 http(s) 或本机绝对路径
- `atUserId` 禁止 `all`
- `silent` 只记日志，不回复

### 回复内容会被审计

命令回复与 AI 回复走同一道内容闸门：命中 `SENSITIVE_RE`（本机路径 `C:\...`、
`/home/...`、`token=...` 等）**整条阻止发送**，日志记 `error / reply-error`。

因此：

- **不要**把 `api.dataDir`、配置路径、令牌写进 `text`
- 需要给管理员看路径时，去设置页的插件卡片（`dataDir` 字段），不要发到 QQ
- QQ 是公共通道，群友和别的 bot 都看得到

## 命令触发规则（2026-11-06 起）

| 场景 | 是否执行 | 说明 |
| --- | --- | --- |
| 群聊 `@机器人 /命令` | ✅ | 正常触发。前导的 `@机器人` 会被剥掉，连续多个也能剥 |
| 群聊裸 `/命令` | ❌ | 丢弃并记 `dropped/bare-slash`，**不进 DSH、不进模型** |
| 群聊 `@别人 /命令` | ❌ | 不是命令，按普通对话处理 |
| 私聊 `/命令` | ✅ | 私聊天然指向机器人，不需要 @ |

命令**不受静默模式影响**（不产生模型回合、不花 token），也**不会**写进记忆卡、黑话窗口或公开流。

## handler 收到的 ctx

| 字段 | 说明 |
| --- | --- |
| `key` / `kind` / `groupId` / `userId` / `senderName` / `isOwner` / `messageId` | 会话与发送者 |
| `raw` | **剥离 @ 后**的命令文本（`/今日老婆 参数`），args 由它切出来 |
| `plain` | 原始文本（`@鱼 /今日老婆`），需要展示原貌时用 |
| `hadAtPrefix` | 是否带前导 `@机器人` |
| `atTargets` | `[{ qq, name }]`；`name` 已由桥接用群成员表补全，取不到时为空串，请用 `name \|\| qq` |
| `args` | `raw` 去掉命令名后的剩余文本 |
| `command` / `plugin` / `permission` | 命中的命令元信息 |

## 宿主 API

| API | 说明 |
| --- | --- |
| `api.commands.register(spec)` | 注册命令；name/alias 不能与内置管理命令冲突 |
| `api.config.get()/set(v)` | 本插件配置（落 `state/command-plugins.json`） |
| `api.dataDir` | `state/command-plugins/<id>/` |
| `api.log(...)` | 写桥接日志 |
| `api.qq.activeMembers({ key, days, limit })` | 只读当前群近期发言者（给需要“活跃群友”的插件） |
| `api.shared` | 命名空间共享存储（跨插件/进程少量结构化数据） |
| `api.crypto.randomUUID()` | 生成 id |

### 日切（+08:00）

需要"每天刷新"的插件，用 `src/day-key.js` 的 `dayKey()` 判定，
它钉死 `Asia/Hong_Kong`，**不信宿主时区**：

```js
import { dayKey, msUntilNextDay } from '../../../src/day-key.js';

const today = dayKey();              // '2026-11-06'（UTC+8）
if (record.day !== today) { /* 新的一天，先结算再看时间 */ }
```

**先看日期再看时间**：桥接重启会丢内存定时器，所以每次命令进来都要先比 `dayKey`；
定时器只用于"到点主动播报"。

## 失败语义

所有失败都**只写 Log Terminal，不回 QQ**：

| 情况 | outcome / code |
| --- | --- |
| 权限不足（admin 命令） | `denied / not-owner` |
| 场景不符（scopes） | `denied / scope-mismatch` |
| 插件未启用 | `denied / plugin-disabled` |
| 未注册的命令 | `unknown / unknown-command` |
| 限流（默认 30 次/分/用户/命令） | `rate-limited / rate-limited` |
| 插件抛异常 | `error / plugin-error` |
| 插件超时（默认 5s） | `error / plugin-timeout` |
| 发送失败 | `error / reply-error` |
| 裸斜杠被丢弃 | `dropped / bare-slash` |
| 未注册的斜杠（管理端） | `dropped / unknown-slash` |

- 插件主动返回的友好提示（缺 @、次数用完）属于正常输出，会回复。
- 内置管理命令：管理员行为不变；非管理员失败只记日志。
- **聊天不再驱动 DSH 的斜杠命令**：管理员发未注册的 `/xxx` 也不会转发给 DSH。

## 安全

命令插件在桥接进程执行，拥有本机代码执行权。只启用你信任的插件；不要让远程不可信代码自动落盘。
本轮不做 worker 沙箱。
