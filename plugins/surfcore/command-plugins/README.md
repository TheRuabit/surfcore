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

- `text` ≤500 字，桥接负责转义/分条
- `image` 支持 http(s) 或本机绝对路径
- `atUserId` 禁止 `all`
- `silent` 只记日志，不回复

## 宿主 API

| API | 说明 |
| --- | --- |
| `api.commands.register(spec)` | 注册命令；name/alias 不能与内置管理命令冲突 |
| `api.config.get()/set(v)` | 本插件配置 |
| `api.dataDir` | `state/command-plugins/<id>/` |
| `api.log(...)` | 写桥接日志 |
| `api.qq.activeMembers({ key, days, limit })` | 只读当前群近期发言者（给需要“活跃群友”的插件） |
| `api.shared` | 命名空间共享存储（跨插件/进程少量结构化数据） |
| `api.crypto.randomUUID()` | 生成 id |

## 失败语义

- 权限不足、未知命令、插件未启用、插件异常、限流：**只写 Log Terminal，不回 QQ**。
- 插件主动返回的友好提示（缺 @、次数用完）属于正常输出，会回复。
- 内置管理命令：管理员行为不变；非管理员失败只记日志。

## 安全

命令插件在桥接进程执行，拥有本机代码执行权。只启用你信任的插件；不要让远程不可信代码自动落盘。
本轮不做 worker 沙箱。
