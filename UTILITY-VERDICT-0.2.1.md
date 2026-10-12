# dsh-host-rsi v0.2.1 实测效用裁决（"有没有用"）

> 数据源：E:\DSH\.rsi-memory 遗留库（≤0.1.11 时代真实使用产生），index.json 165 行、trajectories 165 个文件、debug-session-events.jsonl 348 行。
> 方法：只读复制到临时目录，用插件自身 `store.search()`（实际注入路径 index.js:424）对 6 个真实任务跑检索，观察实际注入文本；对全部 165 行做污染/可执行性/去重统计；抽样 trajectory 与事件日志。

---

## 一句话结论

**机制上确实能带来价值（L2 自验证层的技术结论是真实有用的知识，且能被正确检索注入）；但按现状跑真实数据，可信记忆中 10.5% 是插件自己的系统文本，注入内容大量是任务回声、整段任务原文、跨项目噪声、截断垃圾，去重失效、fix 通道几乎为空——净效用当下介于"边际"与"负面"之间。修好捕获门控与去重后，才值得说"有用"。**

---

## 一、证明"有用"的证据（机制真的会工作）

### 1. L2 层内容是货真价实的技术结论
抽样（store 实际行）：
- `NInfer 的 kv-dtype k8v4(K=FP8row256+V=NVFP4G16)是这批 GSQ/Swift/Heretic 制品唯一验证过的交付口径；用户说的 r8kv4=rk8v4(G32 行粒度)与 fp8 同族，是文档记载的 2-token 静默崩溃禁忌…别照搬 llama.cpp 通用结论`
- `单文件 SVG 动画用单一 rAF 时钟统一驱动所有旋转/腿坐标，可保证轮-曲柄-腿严格同步`
- `restart dead stack via pythonw then confirm full-speed with a counting probe (292.6 tok/s = healthy)`
- `just1/justwoker.icu 间歇性空 body 403(Cloudflare)+DNS抖动+上游502/429=聚合转售中继不稳,非 DSH bug`

这类"一次踩坑换来的结论"正是记忆系统该存的。

### 2. 检索相关性有效（好内容能被捞出来）
注入实验（temp copy + 真实 search）：
- 任务「写一个单文件 SVG 动画，轮子曲柄腿要同步」→ 注入命中 `[L2] 单文件 SVG 动画用单一 rAF 时钟…` ✅
- 任务「NInfer kv-dtype k8v4 与 r8kv4 的关系是什么」→ 注入命中 `[L2] NInfer 的 kv-dtype k8v4…2-token 静默崩溃禁忌…` ✅
- 任务「继续提速 swift-rco-iq3s 模型推理，对比文档要单独写」→ 注入 `[L3] 你应该单独写个提速文档 对比 不应该用原本的文档` ✅（该条可执行）

### 3. 行为规则型修正可复现
- `[L3] 继续。你上一轮只输出了内部推理, 既没有回复也没有调用工具…每一轮都要以工具调用或可见回复结束。` —— 若被注入到死循环/纯推理轮，有真实纠偏价值。

---

## 二、证明"危害/稀释"的证据（现状跑偏）

### 1. 系统文本被当成可信用户修正/指令（最严重）
`isSystemLikeText`（policy.js:81-82）的 `SYSTEM_BOILERPLATE_RE` 只匹配 `your project directory|use it as your working directory|for every file operation|rsi-selfcheck|rsi-guard|[verify:|relevant trusted lessons from prior use|you are (an?|a) (ai|assistant|language model)|system prompt|当前项目目录|你的工作目录|请以此作为工作目录`。

**不匹配**：`<goal_round>…Round: 1/256 Continue working…`、`Current runtime context. This snapshot supersedes…`、`<system-reminder> The available skill catalog changed…`。

实测污染行：**11 行，全部 trusted、全部 L3，占可信记忆 10.5%**：
- `<goal_round> Objective: "继续未完成的工作，提速"…`（用户修正，6 行）
- `<goal_round> Objective: "对比 两个方案 应该以KVMEM方案为主…"`（其他会话的陈旧目标，会被注入到无关未来任务）
- `<goal_round> Objective: "在E盘建立 ninfer文件夹 https://github.com/…"`（同上）
- `Current runtime context. This snapshot supersedes…`（用户指令 2 行 + 用户修正 1 行）
- `<system-reminder> The available skill catalog changed…`（用户指令 1 行 + 用户修正 1 行）

后果：插件把"自己注入的轮次目标/运行时快照/技能目录"当用户经验反复回灌自己 —— 自污染闭环。

### 2. 整段任务原文被存成"指令"
注入实验里，任务「优化 dsh-host-rsi 插件 找出不足」实际被注入的第三条是：
`[L3] You are reviewing a DSH host plugin codebase for bugs and optimization opportunities. Review ONLY these files (do not review index.js, tests, or docs…` —— **这是发给子代理的审查 prompt，不是用户经验**。
任务「写一个单文件 SVG 动画…」注入的第一条是用户原始任务全文（"1，创建一个完整独立HTML文件，内部包含SVG，绘制一只鹈鹕骑自行车…禁止用子代理"）—— 上下文回显，非经验。

### 3. 任务回声：当前任务自己出现在注入里
任务「优化 dsh-host-rsi 插件 找出不足」注入第一条：
`[L3] User correction: 检查完本地的dsh host rsi 项目，1 看看有没有需要优化的 2 用户反应安装以后在e盘生成文件夹…` —— 模型被提醒自己正在做的任务，零新信息。

### 4. 跨项目泄漏
任务「优化 dsh-host-rsi 插件」注入第二条：`[L3] 注意 根据参考项目的经验 对rootfs的改动会造成HLT 就是死机…` —— 完全不同项目的经验，靠项目无关词命中。

### 5. 截断垃圾入库
注入实验里任务「修复 powershell 读取 UTF-8…」注入第二条：
`[L3] 更新失败: dsh-web-search-pro — rsion\` or the plugin manager, then retry…` —— 插件管理器的报错中段，无头无尾。

### 6. 去重失效：同一文本被双向存+同块重复注入
- 同一段用户原文既走 `user-instruction` 又走 `user-correction`（domain 不同 → store.js:313 `dedupeText(r.domain) !== dedupeText(lesson.domain) continue` 跳过 → 两条都进库）。
- 注入实验中同一条 L3 任务原文出现两次、同一条 L2 结论出现两次。
- 全库近重复键（同 domain+前 24 字规范化）**37/165 = 22%**。
- `hasDuplicate` 阈值 0.85 对"同文本不同 domain"完全失效。

### 7. fix 通道几乎为空 + 非 L1 不注入 fix
- L2/general 行 `fix` 全空（analyze-store2 抽样 8 条 fix 全 `''`）。
- retrieve.js:141 `l.layer === 'L1' && l.fix ? summary->fix : summary` —— **L2/L3/Q 只注入 summary，永远不带 fix**。而 L3 correction 的 fix = 用户原文逐字（capture.js:132），等于把"投诉原文"注入上下文，无修复指引。

### 8. trajectory 机制实战产出为零
165 个 trajectory 文件抽样全部为：
`{"ts":…,"task":null,"domain":"general","verdict":"UNCERTAIN","conf":null,"lesson":null,"fix":null,"scorer":{…null},"layer":"Q","trusted":false}`
—— task/lesson/fix 全空。guard/轨迹机制在真实使用中没记录下任何可追溯的东西（Q 层 60 行的信息来源即此，但无 task 上下文）。

### 9. sourceKind 从未落盘
165 行 `sourceKind` 全部缺失（"?"）。代码里 extractUserMessages 依赖 `sourceKind==='user'` 做源门控，但 store 根本不持久化来源 —— 无法审计"这条从哪来"，"source-gate"概念名存实亡。

### 10. correction 可执行性低
53 条 user-correction 中仅 14 条（26%）含可执行词（应该/不要/请/改成/先/记住…），其余为困惑提问（"你的报告 我什么没看到 也就是文档在哪里"）、抱怨（"swift-rco-iq3s 不应该这么慢 肯定是你遗漏了什么"）、碎片。

---

## 三、净效用判定

| 维度 | 实测 | 判定 |
|---|---|---|
| 检索相关性（内容好时） | 命中准确 | ✅ 有效 |
| 记忆内容质量 | 10.5% 可信=系统自污染；22% 近重复；74% correction 不可执行 | ❌ 严重稀释 |
| 注入文本 | 任务回声/整段任务/跨项目/截断垃圾占多数，单条有用占比约 1/3 | ❌ 净噪声偏大 |
| 可执行指导（fix） | 非 L1 不注入 fix；L2/general fix 为空 | ❌ 通道空转 |
| 实战溯源 | trajectory 全空壳、sourceKind 全缺 | ❌ 不可审计 |

**裁断**：目前"有没有用"的诚实答案是 **边际偏负** —— 机制具备正确工作的底层能力（L2 检索命中证明），但捕获门控失守 + 去重跨域失效 + 来源不可审计，使插件在真实使用中主要扮演"上下文噪声注入器"角色，仅在少数任务上恰好捞出一条真经验。**按 REVIEW-0.2.1.md 的 C1/H1-H4/M1-M10 修复后（尤其：SYSTEM_BOILERPLATE_RE 扩展覆盖 goal_round/runtime context/system-reminder、hasDuplicate 跨 domain 判重、capture 截断+可执行性提取、sourceKind 落盘、非 L1 也注入 fix），可从"边际偏负"翻转为"明显有用"。**

---

## 附：注入实验原始输出（6 任务 × topK=3）
（temp 副本，未触碰原库；结果已在正文引用，此处保留关键行）
1. 「继续提速 swift-rco-iq3s 模型推理，对比文档要单独写」→ [L3 单独写提速文档] [L3 每轮工具/可见回复] [L3 清理项目文件夹]
2. 「修复 powershell 读取 UTF-8…」→ [L3 整段 ninfer 查证任务] [L3 更新失败截断垃圾] [L3 本环境 pwsh 进程级崩溃 修复一下]
3. 「写一个单文件 SVG 动画…」→ [L3 任务原文] [L3 任务原文·重复] [L2 rAF 同步] ✅
4. 「优化 dsh-host-rsi 插件 找出不足」→ [L3 当前任务回声] [L3 rootfs HLT 跨项目] [L3 子代理审查 prompt]
5. 「帮我检查一下这个项目的代码」→ [L3 ikuai-install 无关] [L3 当前任务回声] [L3 rootfs HLT 跨项目]
6. 「NInfer kv-dtype k8v4 与 r8kv4 的关系是什么」→ [L3 用户原问句] [L2 k8v4 结论·重复×2] ✅

（分析脚本 analyze-store.mjs / analyze-store2.mjs / inject-experiment.mjs 为只读工具，用毕已删除。）
