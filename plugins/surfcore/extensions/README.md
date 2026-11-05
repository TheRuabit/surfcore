# 扩展接口

这里放“以后要加的功能”，不需要改合体插件主流程。

> QQ 斜杠命令插件不在本目录：它们在桥接进程执行，见 `plugins/surfcore/command-plugins/README.md`。
> 本目录的扩展运行在 DSH 宿主进程，适合平台适配/后台任务/设置页路由。

## 目录约定

```
extensions/<id>/
  manifest.json
  index.js
```

`manifest.json`：

```json
{
  "id": "my-feature",
  "name": "我的功能",
  "version": "0.1.0",
  "description": "一句话说明",
  "entry": "index.js",
  "enabled": false,
  "capabilities": ["actions"],
  "platforms": ["qq", "bili"]
}
```

**默认必须 `enabled: false`**：扩展是本地代码，开启等于把执行权交给它。
设置窗口「扩展」页里显式打开后才会 `import()`。

## 宿主 API

`activate(api)` 拿到：

| 面 | 说明 |
| --- | --- |
| `api.config.get()` / `set(v)` | 扩展自己的持久化配置 |
| `api.dataDir` | `~/.dsh/surfcore/extensions/<id>/` |
| `api.paths` | 插件/surfcore/DSH/B站工具链的绝对路径 |
| `api.platforms` | 平台注册表；`api.registerPlatform(adapter)` 接入贴吧等新平台 |
| `api.align` | 身份对齐：`listLinks` / `addLink` / `findBy...` |
| `api.memory` | 记忆状态、预览、手动同步 |
| `api.bridge` | QQ 桥接状态/启停/重启/任意控制台 API |
| `api.bili.run(args)` | 用真 node 跑插件自带 `tools/bili.mjs`，返回 `{ok,out,err}` |
| `api.qq.readConfig()` | 只读 QQ 配置（写请走设置窗口的受控 API） |
| `api.registerRoute(method, path, handler)` | 挂到 `/dsh-surfcore/ext/<id>/<path>`（只接受本机回环） |
| `api.on(event, fn)` / `api.emit(event, payload)` | 事件总线 |
| `api.crypto.randomUUID()` | 生成 id |

## 平台适配器（贴吧）

`api.registerPlatform({ id, name, version, capabilities, status, readMemory, writeMemory, promptBlock })`。

主流程（身份对齐 / 记忆同步 / 设置窗口）只认这个接口，不关心平台是 QQ、B站还是贴吧。
`tieba` 已经在 `platforms/` 里以 `planned` 占位；接好适配器后把状态改成 `active` 即可。

## 现有示例

- `sts2/`：杀戮尖塔启动器（空壳，演示路由与配置）
- `bili-live/`：B站自主直播（空壳，演示状态路由）

两个示例都默认关闭。
