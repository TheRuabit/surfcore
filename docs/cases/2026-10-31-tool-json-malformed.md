# 长中文回答导致 tool JSON 崩塌（tool input is invalid JSON）

## 现象

- 用户在 QQ 群问：「这里是系统Prompt，我想知道你的记忆里有告诉你什么时候该发表情包吗」
- 回复：两次「处理失败」，随后 `本轮运行失败 DeepSeek Messages stream: tool input is invalid JSON`
- 日志：`bridge.log` 两行 `⚠️ agent 处理出错 (group:824266596)：DeepSeek Messages stream: tool input is invalid JSON`（01:42:29 / 01:42:43，间隔 14 秒）
- 影响面：单轮失败，不丢数据、不损坏会话；重问一次即可恢复

## 环境

| 项 | 值 |
| --- | --- |
| 系统 / DSH 版本 | Windows 10 / 0.2.1-rc.3 |
| SurfCore 版本 | 0.7.17 |
| 模型 | `deepseek-account/deepseek-flash`（reasoningEffort: high） |
| 触发会话 | `group:824266596`，turn 349 / 350 |

## 根因

**模型把 `messages` 的值裸写进 JSON，没加双引号。**

从 session 的 `assistant/attempt.stream` 里能直接看到逐 token 的生成：

```
第一次（turn 349）：
  {"type":"tool-call-chunks","args":["{\"","key","\"",": \"","group",":","824","266","596","\"",", \"",
   "messages","\"",": ","有","，","写在","系统","提示","里","，","不是","记忆","卡","里",", \"","token"...

第二次（turn 350）：
  ... "messages","\"",": ","记忆","卡","里","没有","这条","规矩","，","那边","只","存","了","表情","库","的","标签",...
```

拼接后是：

```json
{"key": "group:824266596", "messages": 有，写在系统提示里，不是记忆卡里, "token": "..."}
                                                  ^ 缺开引号
```

**DSH 的 JSON 解析器在 `messages:` 后遇到中文 `有` 就抛错**，整轮请求失败。

## 完整逻辑（给用户看的那一遍）

- **链路**：桥接 `deliverPromptNow` → DSH `session.prompt` → 模型流式输出 → DSH 解析 `tool-call` 的 `args` → 若 JSON 非法则整轮 `MALFORMED_RESPONSE` → `pumpMux`（`src/bridge.js:14627`）收到 `ended.reason.kind === 'error'` → `sendToQQ` 发「⚠️ agent 处理出错」
- **机制**：不是 DSH 或桥接的 bug，是**模型侧 token 生成格式崩塌**。`messages` 的 schema 是 `z.union([z.string(), z.array(z.string()).min(1)])`，模型知道这里可以是字符串，但在长中文解释句上丢掉了开引号。
- **爆炸半径**：进程 2 个（bridge / DSH）× 读者 1（用户）× 静默 0（有日志、有 QQ 回执）= 低。不碰用户数据、不花钱（失败请求不计费）。
- **取舍**：
  - 路线 A（改 schema 描述 + prompt 规则）：低成本、降概率。
  - 路线 B（换 `deepseek-pro`）：根治，但贵 2~3 倍。
  - 路线 C（桥接端重试）：**不可行**——`pumpMux` 是事件泵，拿不到原始 prompt，无法重放。
  - 选 A：0.8% 的失败率下，重问一次的成本远低于全程用 Pro。
- **生效与重启**：改的是 `mcp-snowluma-safe.js`（工具 schema，桥接进程）和两个 preset 文件（DSH 插件宿主）→ **两个进程都要重启**。

## 修法

**① `src/mcp-snowluma-safe.js:678`** —— schema 描述加引号要求：

```js
messages: z.union([z.string(), z.array(z.string()).min(1)])
  .describe('要发送的内容。**JSON 字符串必须带双引号**："你好" 或 ["第一条","第二条"]；'
          + '不要把整句裸写进 JSON 里（那会让整轮请求失败）')
```

**② system prompt 规则 19**（两份都加）：

```
19. 【参数格式】调用 qq_send_message / qq_reply 时，messages 的值必须是**带双引号的
    JSON 字符串**（"你好"）或字符串数组（["第一条","第二条"]）。不要把整句裸写进
    JSON——那会让整轮请求直接失败（tool input is invalid JSON），用户只看到「处理失败」。
    说不完分两条发，别写超长单条。
```

- `dsh/agent-presets/qq-chat-v2/agent.cordis.yml`
- `plugins/surfcore/presets/qq-chat-v2.patch.yml`（实际生效的那份）

**没选更简单的方案**：没有更简单的了——重试拿不到上下文，DSH 侧改不动。

## 验证

- 静态：`node --check src/mcp-snowluma-safe.js` 通过
- 手工：用户在群里重问同一句 → 应该不崩（**待验证，需要重启**）
- **没验证到的**：改完后的失败率是否真的下降（需要跑几天看 `bridge.log` 里 `invalid JSON` 的出现频率）

## 遗留 / 后续

- **根治只能换模型**（`deepseek-pro`）或等 DeepSeek 修 Flash 的格式稳定性
- 需要补的测试：无法用单测覆盖（模型侧行为）
- 长期监控：`bridge.log` 里 `tool input is invalid JSON` 的频次；如果升高，说明这道防线不够
- **这条 case 的价值**：留下流式分片证据。将来换 Pro 或换 Flash 版本时，可以直接对照同一段 `args` 分片看是否还丢引号
