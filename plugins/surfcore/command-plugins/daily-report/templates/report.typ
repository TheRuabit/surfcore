// 群报长图模板（报纸版式）。数据由 render.js 以 JSON 注入。
#let raw = json("data.json")
// 新字段用默认值兜底：老缓存/旧 data.json 不应该让整个渲染失败。
#let data = raw
#let topicsOf = if "topics" in raw { raw.topics } else { () }
#let titlesOf = if "titles" in raw { raw.titles } else { () }
#let ghostOf = if "ghost" in raw { raw.ghost } else { () }
#let verdictOf = if "verdict" in raw { raw.verdict } else { "" }

#let c-bg      = rgb("#eef2f8")
#let c-paper   = rgb("#ffffff")
#let c-line    = rgb("#e1e7f0")
#let c-text    = rgb("#232c3a")
#let c-muted   = rgb("#8d97a8")
#let c-accent  = rgb("#5b8def")
#let c-accent2 = rgb("#a8c2f5")
#let c-warm    = rgb("#e8dcc8")

#set page(width: 820pt, height: auto, margin: 26pt, fill: c-bg)
#set text(font: "Noto Sans SC", size: 9.5pt, fill: c-text, lang: "zh")
#set par(leading: 0.66em)

#let card(body) = block(width: 100%, inset: 14pt, radius: 12pt, fill: c-paper, stroke: 0.5pt + c-line, body)

#let sectionbar(no, title, note) = block(width: 100%)[
  #grid(columns: (auto, auto, 1fr, auto), gutter: 7pt, align: (left + horizon, left + horizon, left + horizon, right + horizon),
    box(fill: c-accent, inset: (x: 5pt, y: 1pt), radius: 3pt, text(size: 7.5pt, fill: white, weight: "bold", no)),
    text(size: 11pt, weight: "bold", title),
    line(length: 100%, stroke: 0.5pt + c-line),
    if note != "" { text(size: 7.5pt, fill: c-muted, note) },
  )
]
#let gap(n) = v(n * 1pt)

#let stat(label, value, unit) = block(width: 100%, inset: 11pt, radius: 12pt, fill: c-paper, stroke: 0.5pt + c-line)[
  #text(size: 7.5pt, fill: c-muted, label)
  #v(2pt)
  #text(size: 19pt, weight: "bold", font: "Raleway", value + unit)
]

// ── 报头：立绘直接压在纸面上，不加任何底色框 ──
#block(width: 100%, fill: c-paper, radius: 14pt, inset: 18pt, stroke: 0.5pt + c-line)[
  #grid(columns: (1fr, 132pt), gutter: 10pt, align: (left + horizon, right + bottom),
    [
      #text(size: 8pt, fill: c-muted, "D A I L Y   R E P O R T")
      #v(6pt)
      #text(size: 25pt, weight: "bold", data.groupName)
      #v(5pt)
      #text(size: 11.5pt, fill: c-accent, weight: "bold", "今日群报 · " + data.dateText)
      #v(7pt)
      #line(length: 56%, stroke: 1.4pt + c-warm)
      #v(6pt)
      #text(size: 8pt, fill: c-muted, data.tagline)
    ],
    image("mascot/dafeiyu-front.png", width: 100%),
  )
]

// ── 四宫格（右侧带小鲸鱼图标）──
#gap(12)
#grid(columns: (1fr, 1fr, 1fr, 1fr), gutter: 9pt,
  stat("消息总数", str(data.stats.total), ""),
  stat("参与人数", str(data.stats.users), "人"),
  stat("总字数", str(data.stats.chars), ""),
  stat("表情数", str(data.stats.emojis), "个"),
)

// ── 左栏 ──
#gap(12)
#let leftCol = [
  #card[
    #sectionbar("01", "摸鱼雷达", "24h")
    #gap(7)
    #let mx = calc.max(..data.hourly.map(h => h.count), 1)
    #grid(columns: 24, gutter: 1.5pt, align: bottom,
      ..data.hourly.map(h => {
        let ratio = h.count / mx
        box(width: 100%, height: 22pt + 54pt * ratio, radius: 2pt,
          fill: if h.count == 0 { c-line } else if ratio > 0.72 { c-accent } else { c-accent2 })
      }),
    )
    #gap(3)
    #grid(columns: 24, gutter: 1.5pt,
      ..range(24).map(i => align(center, text(size: 6pt, fill: c-muted, if calc.even(i) { str(i) } else { "" }))),
    )
  ]
  #gap(9)
  #card[
    #sectionbar("02", "话痨榜", "")
    #gap(7)
    #let mx2 = calc.max(..data.ranking.map(r => r.count), 1)
    #for (i, r) in data.ranking.enumerate() [
      #if i > 0 { gap(5) }
      #grid(columns: (12pt, 1fr, 30pt), gutter: 6pt, align: (right + horizon, left + horizon, right + horizon),
        text(size: 8pt, fill: c-muted, str(i + 1)),
        block[
          #text(size: 8.5pt, r.name)
          #gap(1.5)
          #box(width: 100%, height: 4pt, radius: 2pt, fill: c-line)[
            #box(width: (r.count / mx2 * 100%), height: 4pt, radius: 2pt, fill: c-accent)
          ]
        ],
      )
    ]
    #if titlesOf.len() > 0 [
      #gap(9)
      #card[
        #sectionbar("05", "群友称号", str(titlesOf.len()) + " 人")
        #gap(6)
        #for (ti, tt) in titlesOf.enumerate() [
          #if ti > 0 { gap(5); line(length: 100%, stroke: 0.4pt + c-line); gap(5) }
          #grid(columns: (1fr, auto), gutter: 8pt, align: (left + horizon, right + horizon),
            block[
              #text(size: 8.5pt, weight: "bold", tt.name)
              #gap(2)
              #text(size: 8pt, fill: c-muted, tt.reason)
            ],
            box(fill: c-accent2.transparentize(62%), inset: (x: 6pt, y: 2pt), radius: 4pt,
              text(size: 8pt, weight: "bold", fill: c-accent, tt.title)),
          )
        ]
      ]
    ]
  ]
]

// ── 右栏：金句，底部压一张大脸特写 ──
#let rightCol = [
  #card[
    #sectionbar("03", "今日金句", str(data.quotes.len()) + " 条")
    #gap(6)
    #for (i, q) in data.quotes.enumerate() [
      #if i > 0 { gap(6); line(length: 100%, stroke: 0.4pt + c-line); gap(6) }
      #block(inset: (left: 9pt), stroke: (left: 2pt + c-accent2))[
        #text(size: 9pt, q.text)
        #gap(3)
        #text(size: 7.5pt, fill: c-muted, "—— " + q.name)
      ]
    ]
    #if ghostOf.len() > 0 [
      #gap(10)
      #line(length: 100%, stroke: 0.4pt + c-line)
      #gap(8)
      #text(size: 11pt, weight: "bold", "👻 夺舍榜")
      #gap(6)
      #for (gi, g) in ghostOf.enumerate() [
        #if gi > 0 { gap(5) }
        #block(inset: (left: 9pt), stroke: (left: 2pt + c-accent2))[
          #text(size: 8.5pt, weight: "bold", g.name)
          #gap(2)
          #text(size: 7.5pt, fill: c-muted, g.reason)
        ]
      ]
    ]
  ]
]

#grid(columns: (1.15fr, 1fr), gutter: 11pt, leftCol, rightCol)

// ── 今日话题（全宽，LLM）──
#if topicsOf.len() > 0 [
  #gap(12)
  #card[
    #sectionbar("04", "今日话题", str(topicsOf.len()) + " 个")
    #gap(7)
    #grid(columns: (1fr, 1fr), gutter: 10pt,
      ..topicsOf.map(item => block[
        #grid(columns: (auto, 1fr), gutter: 7pt, align: (left + horizon, left + horizon),
          box(width: 5pt, height: 5pt, radius: 3pt, fill: c-accent),
          text(size: 9pt, weight: "bold", item.title),
        )
        #gap(2)
        #text(size: 7.5pt, fill: c-muted, item.who)
      ]),
    )
  ]
]

// ── 复读榜（全宽）──
#if data.repeats.len() > 0 [
  #gap(12)
  #card[
    #sectionbar("06", "复读榜", str(data.repeats.len()) + " 组")
    #gap(7)
    #for (i, r) in data.repeats.enumerate() [
      #if i > 0 { gap(6) }
      #grid(columns: (44pt, 1fr), gutter: 10pt, align: (left + horizon, left + horizon),
        box(fill: c-accent2.transparentize(72%), inset: (x: 6pt, y: 2pt), radius: 4pt,
          text(size: 9pt, weight: "bold", font: "Raleway", fill: c-accent, "×" + str(r.count))),
        text(size: 9pt, r.text),
      )
    ]
  ]
]

// ── 群锐评（全宽）──
#if verdictOf != "" [
  #gap(12)
  #block(width: 100%, fill: c-paper, radius: 12pt, inset: 16pt, stroke: 0.5pt + c-line)[
    #grid(columns: (auto, 1fr), gutter: 12pt, align: (left + horizon, left + horizon),
      text(size: 26pt, fill: c-accent2, "“"),
      block[
        #text(size: 11pt, weight: "bold", verdictOf)
        #gap(3)
        #text(size: 7pt, fill: c-muted, "本日群锐评 · 由模型生成"),
      ],
    )
  ]
]

// ── 页脚：小立绘 + 文字 ──
#gap(12)
#block(width: 100%, fill: c-paper, radius: 10pt, inset: 10pt, stroke: 0.5pt + c-line)[
  #grid(columns: (auto, 1fr), gutter: 9pt, align: (left + horizon, left + horizon),
    image("mascot/dafeiyu-side.png", height: 34pt),
    text(size: 7pt, fill: c-muted, data.footer),
  )
]
