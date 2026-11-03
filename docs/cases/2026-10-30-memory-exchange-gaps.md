# 记忆交换断裂：QQ 与 B站 互相读不到对方

> 2026-10-30 诊断记录。**本轮只写诊断，不改代码**（用户明确要求先留证据）。

## 现象

- 用户原话：「QQ bot 那边看不到 B站 bot 留下的 BV 号，也没法给我发对应的链接」
- 用户判断：「难道不应该是日记类的吗，又不用查找历史？」
- 复现步骤：
  1. B站 侧发一条带视频的动态（正文末尾含 `https://www.bilibili.com/video/BV...`）
  2. QQ 侧问她「你昨天 B站 发的那条视频是哪条」
  3. 她能复述内容，但给不出 BV 号或链接
  4. 反向：B站 调度器唤醒时，上下文里没有任何 QQ 近况
- 影响面：两个平台的角色各自「半失忆」；不丢数据、可恢复，但用户无法让她引用自己发过的视频

## 环境

| 项 | 值 |
| --- | --- |
| 系统 / DSH 版本 | Windows 10 / 0.2.1-rc.3 |
| SurfCore 版本 | 0.7.17（`sync/v0.7.17-final`） |
| 安装方式 | zip |
| 其它相关版本 | 角色 char-mvrytl5w，B站 账号 mid 3493295099480350 |

## 根因

四条独立断链，叠加成「互相读不到」：

### ① B站 见闻没有写进 `memory-card`

- 代码位置：`src/bridge.js:13830`（`recordMemoryInboxEvent`）、`13853`（`recordSelfMemoryEvent`）
- 两个写入点都只处理 **QQ 消息**；`bili-api.js` 抓到的动态/视频/收藏进的是 `bili-memory.json`，从不进 card
- 后果：`renderMemoryCard(platform:'bili')` 里的 `biliModule` 永远为空

### ② `renderMemoryCard` 对 bili 平台的配额把 qq 侧全关了

- 代码位置：`src/memory-card.js:1778-1780`
  ```js
  platform === 'bili'
    ? { firstMet: 0, anchors: 4, initial: 0, owner: 0, recent: 6, bili: 8, qq: 0, pet: 0, fuzzy: 3 }
  ```
- 只剩 `bili / recent / anchors / fuzzy`；而 `recent/anchors/fuzzy` 里的条目都是 `scope:'qq'`，被 `sectionize` 过滤
- 后果：所有 section 为空 → `memory-card.js:1815` 的 `if (!calls.length) return ''` → **写入 0 字节**

### ③ QQ→B站 的开关默认是关的

- 代码位置：`plugins/surfcore/lib/scheduler.js:145-151`
  ```js
  if (unified.memory?.qqToBili?.enabled !== true) return ''
  ```
- 实际配置：`~/.dsh/surfcore/config.json` 里 `memory.qqToBili.enabled = false`
- 后果：`qqMemoryBlockForBili()` 恒返回空，B站 看不到任何 QQ 近况（其余参数 `lookbackDays:7 / maxMessages:300 / useNicknames:true` 都已配好，只差这个开关）

### ④ `memory-card-prompt-bili.md` 写了但没人读

- 写入：`src/memory-card.js:1915`
- 读者：
  - `src/bridge.js` 只读 `promptQq`（`11960/11963`）
  - `plugins/surfcore/lib/scheduler.js:157` 用的是 `memoryCardPromptBlock('bili')`（现算，不读文件）
- 后果：这个文件是纯装饰（只给设置页预览），**且它还是空文件**，双重无效

### ⑤ BV 号丢失与上面无关，是 `buildBrief` 内部截断

- 代码位置：`src/bili-memory.js:577-582`
  ```js
  const body = e.type === 'dynamic' ? short(e.text, 110) : ...
  lines.push(`- ${e.date}【${label}】${short(e.title, 46)}${body ? `：${body}` : ''}`);
  ```
- `e.url` 与 `e.bvid` **一次都没被读过**；动态正文里的 URL 永远在 110 字之外
- 且 `bili-memory.json` 里动态条目的 `bvid` 字段本来就是空的（抓取时没从正文正则提取）

## 完整逻辑（给用户看的那一遍）

- **链路**：
  - QQ→记忆：`handleIncoming` → `recordMemoryInboxEvent` → `memory-inbox.jsonl` → 插件整理 → `memory-card.json` → `renderMemoryCard('qq')` → `memory-card-prompt-qq.md` → `bridge.js` 注入 QQ prompt
  - B站→记忆：`bili-api.js` → `bili-memory.json` → `buildBrief()` → `bili-memory-brief.md` → `bridge.js:11008/13024` 注入 QQ prompt
  - B站→上下文：`scheduler.js` `identityContextLines()` = 人设 + 自我锚点 + 管理员 + 对齐 + `qqMemoryBlockForBili()` + `memoryCardBlockForBili()`
- **机制**：两套记忆系统并行存在，设计目标是「一张卡 + 平台模块」，但只有 QQ 侧真正接上了。B站 侧的两个入口（写 card、读 QQ 记忆）一个没实现、一个默认关闭。
- **爆炸半径**：进程 2 个（bridge / 插件宿主）× 读者 3 个（QQ 注入 / B站 注入 / 设置页预览）× 静默 3 = 18 分。碰用户数据（记忆内容），不碰密钥，不直接花钱（注入体积会变）。
- **取舍**：
  - 路线 A（检索）：用 BM25/向量在 `message-archive` 里找「相关消息」。**否决**：BV 号是「我发过这条」的事实，不是「相似内容」；检索还会引入误召回。
  - 路线 B（共享日记）：B站 见闻按 `scope:'bili'` 写进 `memory-card`，带 `bvid`；QQ 侧直接读。**采用**：符合 `memory-card` 既有设计，零检索成本，且天然带遗忘策略。
- **生效与重启**：`memory-card.js` 由插件宿主进程调用（整理时），`bridge.js` 读结果文件；改完需**重启桥接**，插件宿主随 DSH 重启。

## 修法

**本轮不修。** 修复方案按依赖顺序记录如下：

1. **`qqToBili.enabled` 打开**（一行配置，风险最低，可立即验证 B站 能否看到 QQ 近况）
2. **`bili-memory` 条目写入 `memory-card`**（新代码）：
   - 在 `bili-memory.js` 刷新完成后，把近期条目 append 进 `memory-inbox.jsonl`，带 `scope:'bili'` 与 `bvid`
   - 或在 `bridge.js` 的 `biliMemory.refresh()` 回调里做同样的事
3. **`buildBrief` 带上链接**：
   - 抓取阶段正则提取 `bvid`（`/BV[0-9A-Za-z]{10}/`）
   - brief 每行追加 `link`，同时把条目数 10→6、正文 110→60 以守住 2700 上限
4. **`prompt-bili.md` 的归属**：要么删掉写入逻辑（承认它是死文件），要么让 `scheduler.js` 改成读文件走 mtime 缓存（和 QQ 侧一致）

## 验证

**本轮只做了只读验证**：

```
memory-card-prompt-qq.md     3765 字节
memory-card-prompt-bili.md      0 字节

memory.qqToBili.enabled = false
memoryCard.enabled      = true
memoryCard.injectMaxChars = { qq: 2200, bili: 2000 }
```

```
bili-memory.json 里动态条目：
  "bvid": "",
  "url": "https://t.bilibili.com/1264967902769971225",
  "text": "... https://www.bilibili.com/video/BV1UnHN6SECP/"
```

**没验证到的**：
- `sectionize` 对 `scope` 的具体过滤条件（只从「所有 section 为空」反推）
- B站 调度器实际拿到的 prompt 全文（未抓现场）

## 遗留 / 后续

- 需要补的测试：`test-memory-card.mjs` 里加一条「bili 平台在有 bili scope 条目时非空」的断言（现有测试只断言了 `promptBili === ''` 这一种情况）
- 需要改的文档：`docs/guides/MEMORY_CARD.md` 补「双向 exchange 的实际状态」；本 case 的修复完成后更新 `README.md` 表格
- 相关待办：`docs/RELEASE-QUEUE.md` 待发布批次（修复后追加）
