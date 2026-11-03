# 2026-10-30 B站 四类动态的三个闸门太紧（信号 / 间隔 / 分享卡片）

## 现象

- 用户原话："太紧的地方，按我这两天卡住的程度排"
  1. **四类动态的关键词判据最卡**：`game` 要求标题/简介含游戏名——《若娜瓦 恋爱脑》47 万播放因为标题没写「原神」被拒；`anime` 要求含「动漫/MAD/新番」——无职转生那条 AMV 赞播 18.9%，标题只有番名，被拒。
  2. **动态之间 30 分钟**（四类 + 分享共用）：分享当天被卡三次，12:05 发过要等到 12:35。
  3. **share-dynamic 找不到 AV 卡片直接拒**：DSH 那条没卡片，加 `--allow-text` 才发出去。
  4. `limits` 里写 0 是「不限量」不是「发 0 条」——想关停要用 `behavior.publicComment` 这类开关。
- 影响面：只影响 B站 侧的发动态/分享节奏，**不碰 QQ**；不影响历史数据，无不可逆操作。

## 环境

| 项 | 值 |
| --- | --- |
| 系统 / DSH | Windows 11 / DSH 0.2.1-rc.3 桌面版 |
| SurfCore | v0.7.17（合并上游后） |
| 安装方式 | git clone + junction |
| B站 | 已扫码登录（self.mid 已写回） |

## 根因

- **代码位置**
  - `plugins/surfcore/tools/lib/kind-signals.mjs:6-12`（三条正则）
  - `plugins/surfcore/tools/commands/daily.mjs:200`（`text = title + desc + tname`，**缺 tags**）
  - `plugins/surfcore/tools/lib/kinds.mjs:90`（`gapMin` 默认 30）
  - `plugins/surfcore/tools/commands/share-dynamic.mjs:94`（没卡片直接 `exit(4)`）
  - `plugins/surfcore/tools/lib/free-gate.mjs:65`（`publicComment === false` 才拒）
- **问题链条**
  1. 判据只看标题/简介/分区，**不看标签**。B站 的标签才是分类最准的信号（原神视频几乎必有「原神」tag），而 AMV 标题经常只有番名。
  2. `gapMin` 是"任意两条动态之间"的全局间隔，四类和分享共用一本时钟，导致分享被四类的节奏挡住。
  3. 分享卡片是**尽力而为**的富化（找 UP 主的 AV 动态），不该成为硬门槛。
- **为什么之前没发现**：这些门槛都是按"理想投稿"写的，没在真实热门视频上回归过；单测只覆盖了少量正例。

## 完整逻辑

- **链路**：`bili.mjs daily` → `commands/daily.mjs`（读 `bili.config.json` 的 dynamics）→ `viewOf()` 打 B站 接口拿 title/desc/tname → `hasKindSignal()` 判类 → 通过后发动态。`share-dynamic.mjs` 走 `lib/share-dynamic.mjs` 找 AV 卡片，找不到就退文字。
- **机制**：判据是"标题里有没有某个词"，而不是"这条视频属于哪个分区"。B站 的分类信息散落在 `tname`（分区名）、`tags`（用户标签）、以及标题里——只取前两者必然漏。
- **爆炸半径**：只影响 `tools/`（独立 CLI，由调度器调用），**不碰 QQ 桥接、不碰 `config.json`**。改的是判据变宽 + 门槛变松，最坏后果是"多发了一条不太合适的动态"，可删。
- **取舍**：
  - A. 只放宽正则（最小改动）——但角色名会无限膨胀，维护不动。
  - B. 加 tags + 放宽正则（选这条）——tags 是数据驱动，正则只补常见番名/游戏名兜底。
  - C. 直接去掉判据——会让 `best` 以外全放行，失去分类意义，否。
- **生效与重启**：`daily` / `share-dynamic` 是**每次调用现读** `bili.config.json` 的 CLI，改完即生效；不需要重启 DSH 或桥接。调度器下一次 tick 就用新阈值。

## 修法

1. `kind-signals.mjs`：
   - `AI_RE` 追加游戏名（原神/崩坏/星穹铁道/绝区零/鸣潮/明日方舟…）
   - `ANIME_RE` 追加 `AMV|手书|静止画|配音|声优|作画` 与常见番名
2. `daily.mjs`：新增 `tagsOf(bvid)`，`viewOf` 返回 `tags`，判据文本改为 `title + desc + tname + tags`；tags 接口失败不致命（返回空串）。
3. `share-dynamic.mjs`：找不到 AV 卡片时**不再 exit**，自动退回「文字 + 链接」；`--allow-text` 保留为兼容参数。
4. `kinds.mjs` / `config.mjs`：`gapMin` 默认 30 → 15（用户配置同步改 15）。
5. `behavior.publicComment` 保持 `false`（用户要关停公开评论；`limits` 里的 0 是「不限」不能用来停）。

- **回滚**：`git checkout -- plugins/surfcore/tools`；用户配置备份在 `~/.dsh/surfcore/backups/bili.config.<时间戳>.json`。

## 验证

- 自动化：
  - `node plugins/surfcore/scripts/test-kind-signals.mjs` → OK
  - `test-bili-automation.mjs` / `test-automation-config-api.mjs` / `test-store.mjs` → 全 OK
- 手工判据探针：
  - `无职转生 AMV` → PASS（新番名 + AMV）
  - `【手书】…` → PASS
  - `若娜瓦 恋爱脑 原神` → PASS
  - `若娜瓦 恋爱脑`（纯角色名、无标签）→ **仍 MISS**（见下）
  - `今天吃了顿火锅` / `一个安静的 vlog` → MISS（无新增误伤）
- 没验证到的部分：
  1. **纯角色名且无标签**的视频仍会被拒（若娜瓦这条如果 B站 侧也没打「原神」tag）。要彻底解决得加角色名白名单，维护成本高，先观察。
  2. 真实发一条动态/分享的端到端没跑（会真的发到 B站），只做了离线判据与语法验证。
