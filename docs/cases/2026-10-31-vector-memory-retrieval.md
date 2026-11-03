# 长期记忆检索没生效：query 读错表 + 自匹配 + 归档正则失效

> 2026-10-31。审查后修复（原改动只加到工作区，未重启桥接、未开 `enabled`）。
> 影响的是 shadow 检索日志，不影响 QQ 聊天；不丢数据。

## 现象

- shadow 日志里的检索 `score` 长期卡在 0.80；`query` 是身份声明/规则，不是群聊内容。
- `state/message-archive.jsonl` 里混进 `[图片]`、`[表情]`、纯 `@` 消息（交接前手工清了 120 条 + 7 条）。
- 复现：`vectorMemory.shadow=true` 后，等一次 reserved2 唤醒，看 `state/memory-shadow.jsonl` 的 `query`/`scores`。
- 影响面：只有桥接自己读这份日志；不改聊天行为、不碰密钥；清空日志即可回滚数据。

## 环境

| 项 | 值 |
| --- | --- |
| 系统 / DSH 版本 | Windows 10 / 0.2.1-rc.3 |
| SurfCore 版本 | 0.7.17（`sync/v0.7.17-final`，基线 `d076df6`） |
| 安装方式 | git（工作区） |
| 其它相关版本 | SnowLuma 1.14.x，默认模式 `reserved2` |

## 根因

1. `loadConfig()` 是显式白名单，`vectorMemory` 没列进去 → `cfg.vectorMemory` 恒 `undefined`，归档/检索从未跑过（本轮已修，见交接）。
2. `probeMemoryShadow` 读 `social.recentMessages`（一代 `reserved` 才写），而默认 `reserved2` 的消息在
   `getSocialV2State(key).recentMessages`（`appendSocialV2Message` → 12546）；默认模式这个 Map 恒空，
   于是回落 `promptText.slice(-200)` —— 唤醒提示词的尾部是「沉睡前必须等待…直接 `qq_close_conversation` 收尾」，
   检索的仍是指令文本，等于修复前。
3. `before: Date.now() - 10 * 60 * 1000` 挡不住自匹配：群安静超过 10 分钟后唤醒，query 来源的最后 3 条
   本身就早于这个上界，仍会进候选。实测（临时目录）：30 分钟前的 `alpha beta gamma`、query `alpha beta`、
   `before=now-10min` → top1 仍是来源消息（0.219）。
4. `sender` 唯一调用点（`deliverPromptNow`）从不传；`archiveMemory` 又把 `replyTo` 只写成 `'self'`/`''`，
   即使传了也匹配不上 → `sameSpeaker`/`replyChain` 恒 0，新权重里 0.15 是死的。
5. 归档过滤正则写成 `/^\\[(图片|…)\\]$/`（源码里是双反斜杠），`[图片]` 永远不匹配；纯 `@` 同样。
   手清数据只治了结果，没治入口。
6. `filter.before` 只实现 BM25；`memory-store.search` 没有它，`retriever=hash` 时被静默忽略。
   `test-vector-memory.mjs` 只测 hash 向量 store，不 import BM25，也不在 `test:audit` 清单里。
7. `tokenize` 把 `@昵称` 当正文切词：真机重启后两条新 shadow 记录的 top8 全是 `@寻玉型大肥鱼`
   的历史消息，得分 0.987–0.993、首位差只有 0.005；问「羊蹄山」也返回同一批 @ 消息。
   IDF 压不住高频称谓，检索变成「谁被 @ 得多」而不是「聊了什么」。

## 完整逻辑（给用户看的那一遍）

- **链路**：`handleIncoming` → reserved2 `appendSocialV2Message`（写 `st.recentMessages`，并调 `archiveMemory`）
  → `ensureMemory`（建 BM25/hash store + shadow）→ 投递前 `probeMemoryShadow` → `memory-shadow.probe`
  → `store.search` → 追加 `state/memory-shadow.jsonl`。读者只有桥接自己，结果**不进 prompt**。
- **机制**：两代仿真各有一条消息窗口（v1 `social.recentMessages` / v2 `st.recentMessages`），记忆链只挂在 v2；
  shadow 是「只观察、不注入」的旁路，`before` 是它唯一能「只看更早」的手段。
- **爆炸半径**：1 个桥接进程 × 1 个读者 × 静默 3 = 3 分；碰群聊原文（`state/`），不碰密钥，不直接花钱。
- **取舍**：
  - 查询窗口 A（单条最新消息）vs B（最近 3 条）。保留 B（原设计），上界取 `min(窗口最早一条, now-10min)`：
    窗口里的 3 条不会被检索回来，同时保留「最近 10 分钟是当前话题」的旧设计；比固定 10 分钟更准。
  - sender 加权 A（传最新消息的 sender）vs B（删掉）。选 B：3 条消息常来自不同人，sender 没有唯一值。
  - `before` A（只 BM25）vs B（两个实现都补）。选 B，维持「上层不知道底下是 BM25 还是向量」的契约。
- **生效与重启**：改 `bridge.js` / `memory-*.js` 需**重启桥接**（从 DSH 设置页启动；sandbox 启动会误判端口）。

## 修法

- 新增 `src/memory-query.js`：`isMemoryNoiseText()`（媒体/纯 @/单字/空串）+ `pickShadowQuery()`
  （跳过自己/拍一拍/噪音，取最近 3 条，`before = min(窗口最早, now-10min)`）。
- `src/bridge.js`：`archiveMemory` 用 `isMemoryNoiseText`；`probeMemoryShadow(key)` 读
  `socialV2.conversations.get(canonicalV2Key(key) || key)`（回退 v1 窗口），无消息直接返回，删除 prompt 尾巴 fallback。
- `src/memory-bm25.js` / `src/memory-store.js`：都支持 `filter.before`；打分统一为
  `语义 0.75 + recency 0.25`；删除 sender / replyChain 项；BM25 的 `doc.len` 改用 token 数（不是去重词数）。
- `src/memory-bm25.js` 的 `tokenize` 先剥掉 `@\S+`（称呼不是内容），文档和 query 同时生效。
- `src/memory-shadow.js`：filter 只传 `key`/`before`，JSDoc 同步。
- 测试：新增 `scripts/test-memory-bm25.mjs`（12 条：tokenize / @ 剥离 / before / len / 单字权重 /
  向量 store 的 before / 噪音过滤 / 查询窗口 / probe 透传 / loadConfig 白名单 / 模板默认段 / 接线断言）；
  `test-vector-memory.mjs` 改为退出时清理临时目录；两者加入 `test:audit` 清单和 `npm run test:memory`。
- 回滚方式：从 `_backups/vector-memory-2026-10-31T16-16/` **按原路径复制回去**（bridge / memory-* / 测试 /
  配置模板 / 文档），再删掉新增的 `src/memory-query.js`、`scripts/test-memory-bm25.mjs`、
  `docs/cases/2026-10-31-vector-memory-retrieval.md`。**不要整体 `git checkout`**：工作区里还有本轮之前
  别人的未提交改动，整体回退会一起抹掉；`state/` 数据不动。

## 验证

- 自动化：
  - `node --check` 六个改动文件全部通过。
  - `npm run test:memory` → vector 11/11、bm25 12/12。
  - `npm run test:audit` → 77/88；11 个失败均不在记忆用例，且不 import 本次改动的模块
    （多数是 sandbox `spawn EPERM`、`start.bat` CRLF、既有未提交 preset 变更；
    `test-release-manifest` 是工作区 dirty 的发布门禁，发布前需按 RELEASE.md 重新生成清单）。
  - `npm run test:regressions` → 16/16（`全部通过`）。
- 真机重启（20:00:39，第一版修复）：`[记忆] 已加载 724 条归档（retriever=bm25）`；新 shadow 记录
  `qLen=32/16`（不再是 120 的身份/规则文本），命中全部早于 `now-10min`，归档 `media=0`。
  查询源、`before`、媒体过滤都确认生效。
- 同一批数据暴露 @ 霸榜：两条新记录 top8 全是 `@寻玉型大肥鱼`，得分 0.987–0.993、首位差 0.005；
  离线剥掉 @ 后同一 query 变成内容命中（0.68–0.83，首位差 0.08–0.36）。@ 剥离已加测试，需再重启一次复核。
- 离线仿真（用真实 `state/social-v2.json` + `state/message-archive.jsonl`，不重启）：
  3 个会话各取最近 3 条 → query 长度 32/33/51，`before` 是窗口最早与 `now-10min` 中更早者
  （这批数据两者恰好都是窗口最早）；检索 top3 得分 0.582–1.0（有命中）/ 0 条（该群归档为空），
  命中项都不在 query 窗口内。
- 修复前运行中的桥接（旧代码）在归档清理后仍新增了 5 条 `[图片]`（14:44–16:12），
  另有 1 条 14:13 的残留；说明正则漏洞仍在生效，重启后不再增加。
- 失败路径：`isMemoryNoiseText` 对空串/`[图片]`/`@123456` 返回 true 有断言；接线测试钉住
  `probeMemoryShadow` 读 `socialV2.conversations` 且不再出现 `promptText.slice(-200)`；
  `tokenize('@昵称 宝宝')` 不含昵称、仍含「宝宝」。
- 手工/集成验证（再次重启后）：`state/memory-shadow.jsonl` 的 top8 不再被同一个 @ 昵称占满；
  `query` 仍是群聊文本；`message-archive.jsonl` 不再新增 `[图片]`/纯 @ 行。
- 没验证到的部分：@ 剥离后的真机 shadow 还没看到（需再重启一次）；检索结果注入 prompt 仍未做。

## 遗留 / 后续

- 检索结果注入 prompt（真正的「长期记忆」）仍未做，当前只是 shadow 观察。
- BM25 store 没有内存上限（`memory-store` 有 200k），长期 24/7 运行需要配额。
- `enabled` 已打开（`enabled=true, shadow=true`）；它目前仍只是「归档」开关，不是总开关，是否合并/重命名要单独定。
- 记忆初始化失败仍只有 `[记忆] 初始化失败` 日志，没有状态页/告警（§1.7 可见性待补）。
- `state/memory-shadow.jsonl` 里的 `query` 现在最多 400 字原文，隐私文档需要补一句。
- 归档里还有 3 条旧的纯 `@` 行（新代码不会再写），可择机清。

## 发布交接（草稿）

- 范围：`src/bridge.js`（记忆段）、`src/memory-bm25.js`、`src/memory-shadow.js`、`src/memory-store.js`、
  `src/memory-query.js`、`scripts/test-memory-bm25.mjs`、`scripts/test-vector-memory.mjs`、
  `scripts/test-audit.mjs`、`package.json`、`config.example.json`、`docs/guides/DATA-AND-CONFIG.md`。
- 建议：patch → 0.7.18（按发布会话决定）。
- 改动层级：实现层。`vectorMemory` 是新增配置段（只增不改）；`memory-store`/`memory-bm25` 去掉
  sender/replyChain 权重属于内部接口，仓库内没有别的调用者。
- 失败路径：噪音过滤、`loadConfig` 白名单、shadow 的 `before` 透传都有断言；记忆初始化失败仍只有日志
  （见遗留，未做可见状态）。
- 测试：`npm run test:memory`、`npm run test:audit`、`npm run test:regressions`。
- 生效：重启桥接（DSH 设置页）；看 `state/memory-shadow.jsonl` 的 `query` 与 `state/message-archive.jsonl` 的新行。
- 回滚：见上（备份目录 `_backups/vector-memory-2026-10-31T16-16/`）。
