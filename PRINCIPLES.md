# DSH host RSI — 技术原理与复刻指南

> 专用文档：解释这套"本地 LLM 每次使用自动进化"系统**为什么这样设计**，以及**如何从零复刻**。
> 实现代码在 `E:\DSH\dsh-host-rsi\`（本目录），本文每个设计点都标注对应源码文件与行号，可对照阅读。
> 目标读者：想理解原理、并能在自己环境重建这套机制的人。

---

## 0. 一句话原理

**冻结的本地 27B 模型不会变强；让它每次使用都"自己反思 → 留下可复用教训 → 下次注入相关教训"，能力就在不改动权重的前提下持续累积。** 这是 Reflexion / AREX-2 反思范式的"推理时脚手架"落地版。

- 它**不是** RSI（递归自我改进，改权重、复合式自举）——权重全程冻结，安全。
- 它是 AREX-2 论文里"test-time scaling"思想的落地：更多反思轮次（`r̄·T*`）→ 更好的解。我们把"轮次"变成"跨会话的记忆复用"，让提升落在**模型能力外**的记忆层，而非重新训练。

---

## 1. 设计原则（五条，先读这个）

| # | 原则 | 含义 | 代码落点 |
|---|---|---|---|
| P1 | **只有可信教训才注入** | 不确定的自判一律进"隔离区"，绝不喂回模型 | `lib/signal.js:67-75` `isInjectable/isQuarantined` |
| P2 | **越强的信号权重越高** | 可验证检查(L1) > 用户末拍(L3) > 自反(L2) > 存疑(Q) | `lib/signal.js:15-18` `LAYER_ORDER` |
| P3 | **便宜方法没解决才升级** | 独立批评轮（重）只在自反问未决时自动开，不默认常开 | `lib/policy.js:74-88` `shouldEscalate` |
| P4 | **无意义轮次零成本** | 闲聊/无结果信号的轮次完全 no-op | `lib/policy.js:16-38` `outcomeSignal/isNonTrivial` |
| P5 | **快速定位内部记忆** | 倒排索引先圈候选（内存），再精排 + token 预算封顶；读走内存缓存、写后台防抖 | `store.js` `candidatesFor` + `retrieve.js:42-75` |

这五条是"用户提出"的四个诉求的展开：**自动触发时机合理（P3/P4）+ 索引机制快速定位（P5）+ 反问式验证（见 §3/§4）**。

---

## 2. 三层架构（复刻时的模块边界）

```
┌──────────────────────────────────────────────────────────────┐
│ index.js  ——  薄胶水（host-only）：把下面两层接到 DSH 事件      │
│   5 个钩子：always-on 注入 / 门控注入 / 门控捕获+自动升级 / 强制工具 │
└──────────────┬───────────────────────────────┬───────────────┘
               │ 调用                          │ 调用
     ┌─────────▼─────────┐          ┌──────────▼──────────┐
     │  纯逻辑层 lib/*    │          │  数据层 store.js     │
     │ interrogate/capture│          │  index.json         │
     │ signal/policy/      │  编排    │  + 倒排 termindex.json│
     │ retrieve/scorers   │ ───────► │  + 人可读 .md / .jsonl│
     │  (零 DSH/Node 依赖， │  数据     │  (Node fs)           │
     │   可独立单测)        │          └──────────────────────┘
     └─────────────────────┘
```

**复刻铁律：纯逻辑层不得 import 任何 DSH 对象。** 这样它能在 `node --test` 里脱离宿主独立验证（对应 `test/*.test.js` 7 套）。宿主侧只有 `index.js`，且每个 DSH 调用都用 `?.` 防御（形状错了 no-op 不崩），首启再用 `cordis_inspect_query` 校准。

---

## 3. 信号阶梯（Signal Ladder）——通用模式的核心

**难题：** 通用模式下大多数任务没有单一干净的可验证评分器 S（不像 AREX-2 训练时那种"参考解 vs 朴素基线"环境）。**解法：** 把"一次使用"的结果按**信号强度**分四层，只有足够强的才成为可注入的教训。

层定义（`lib/signal.js:15-18`）：

| 层 | 来源 | 是否可信注入 | 权重 | 说明 |
|---|---|---|---|---|
| **L1** | 真实可验证检查（代码测试过 / 数学==期望 / SQL 结果匹配 / schema 合法） | 总是可信 | 1.0 | 最强；**L1 失败**= 高价值"纠正型教训" |
| **L2** | 自反问（反问式验证）的判定 | 视判定与置信 | 0.8–0.85 | CONFIRMED→可信；REFUTED→纠正型可信 |
| **L3** | 用户末拍（对/错/修正） | CONFIRMED 可信 | 1.0 | 兜底权威信号 |
| **Q** | 存疑 / 未验证自判 | **不注入** | 0.3 | 进隔离区，等更强信号再转正 |

**判定顺序（`classifySignal`，`lib/signal.js:31-65`，顺序即优先级，复刻务必保持）：**

1. `scorer.definitive` → **L1**（passed/failed 都 trusted，weight 1.0）。
2. `userTap.verdict !== UNCERTAIN` → **L3**（trusted = 是否 CONFIRMED）。
3. `verdict === REFUTED` → **L2 trusted 0.85**（模型抓到自己错了，fix 是纠正型教训）。
4. `verdict === CONFIRMED`：
   - `conf == null` 或非法 → L2 trusted 0.8；
   - `conf ≥ threshold(0.6)` → L2 trusted 0.8；
   - `conf < threshold` → **Q**（低置信自判 → 隔离）。
5. 其余（UNCERTAIN / 无判定）→ **Q**。

**为什么这样分层（原理）：** 可信度与"信号是否独立于被检验的答案"正相关。L1 独立于模型自述（外部事实），故最可信；自判 CONFIRMED 与自判 REFUTED 都来自模型，但 REFUTED 携带了"我抓到自己错在哪 + 怎么修"，是高价值纠正知识；低置信的 CONFIRMED 与 UNCERTAIN 可能是"幻觉式自信"，**必须隔离**，否则持续自改会漂移（P1）。

**转正机制（`store.js` `promote`）：** 隔离区(Q)里的教训一旦后续被 L1/L3 证实，`promote(id)` 把 `trusted` 置真、层 `Q→L2`，并在 `lessons/` 记一条 `[PROMOTE]`。这是"教训从存疑变可信"的通道，也是防漂移的关键。

---

## 4. 反思循环（反思式验证：反问 + 自动升级批评 + 自一致）

分**便宜层**与**重层**（对应 P3）：

### 4.1 便宜层：内联自反问（默认，`lib/interrogate.js:13-24` `buildSelfCheckInstruction`）

注入一段固定指令，让模型在定稿任何非平凡答案前做三步反证：
> 1) 从头重推；2) 找一个具体反例/边界；3) 点出关键假设并验证它成立。
> 然后以**单行机器可解析标签**收尾（`;` 分隔字段）：
> ```
> [VERIFY: CONFIRMED; conf=<0..1>; lesson=<一行可复用的要记住的点>; reason=<短>]
> [VERIFY: REFUTED;   conf=<0..1>; lesson=<要避开的错误>; fix=<修正后的答案>; reason=<短>]
> [VERIFY: UNCERTAIN; conf=<0..1>; lesson=<还开放的问题>; reason=<短>]
> ```

**标签解析（`parseVerifyTag`，`lib/interrogate.js:31-62`）**：取**最后一个** `[VERIFY:...]`，按 `;` 切分，容错"裸判定词"（首词就是 CONFIRMED/REFUTED/UNCERTAIN 而无 `verdict=` 前缀也认）。**复刻要点**：`;` 是字段分隔符（不是 `,`），`lesson=` 必须一行；解析务必取最后一个标签（正文里可能有多个）。

### 4.2 重层：独立批评轮（升级路径，`lib/interrogate.js:65-77` `criticPrompt`）

一个"严格批评者"prompt：不信任候选答案，独立重推 + 找反例 + 查假设 + 对任务约束，输出同一 `[VERIFY]` 标签。

- **自动升级判定（`shouldEscalate`，`lib/policy.js:74-88`，顺序复刻）：**
  1. `userForced`（用户调 `rsi_verify`）→ **开**（永远赢）。
  2. `scorer.definitive`（L1 已解决）→ **不开**（效率，P4）。
  3. 无标签（非平凡轮却没自检）→ **开**。
  4. REFUTED / UNCERTAIN → **开**。
  5. CONFIRMED 且 `conf < threshold` → **开**；否则 **不开**。
- **预算闸（`criticBudgetOk`，`lib/policy.js:94-98`）：** 每会话 `maxCriticsPerSession`（默认 4），封住最坏成本。
- **自一致投票（`selfConsistencyVerdicts`，`lib/interrogate.js:84-91`）：** 跑 N 次（`selfConsistency`，默认 1）取多数判定；不确定/高 stakes 时调 N 提升可靠性。

**升级的落点（`index.js:120-129`）：** 满足 `shouldEscalate && criticBudgetOk` 时，调 `agent.followup(criticPrompt)`（或 `ctx.followup`）——用 DSH 文档化的 followup 把批评轮作为一轮新的输入喂给 agent。

### 4.3 用户只做"最后的反馈"（m00099 诉求）

内联自反问 + 自动批评 + 自一致，把绝大多数验证都自动完成。**用户只在"存疑"时拍板**（对/错/修正 = L3 末拍），这是唯一需要人的地方，且是权威兜底信号。

---

## 5. 合理触发 + 效率（何时捕获 / 何时注入）

### 5.1 捕获触发（`lib/policy.js:16-64`）

`outcomeSignal`（`lib/policy.js:16-23`）先算四个布尔：`hasVerifyTag`（模型自选了 `[VERIFY]`）、`ranTools`（跑过工具）、`hadFailure`（工具失败或答案里出现 `ERROR_RE`）、`hasCode`。

`isNonTrivial`（`lib/policy.js:30-38`）判定"值得进化"，**任一为真**：
- 模型显式自检（`hasVerifyTag`）；
- 出了错（`hadFailure`）→ 高价值纠正教训；
- 有工具支撑的真实任务（`ranTools && (hasCode || 决策词)`）；
- 无工具的实质性决策（`len(answer) ≥ minChars(200) && 决策词`）。

`shouldCapture`（`lib/policy.js:57-64`）在此之上叠加三道闸：`capture.enabled`、**每会话 `maxPerSession`(20)**、**去重（§5.3）**。

`ERROR_RE`（`lib/policy.js:12`）与 `DECISION_RE`（`lib/policy.js:13`）是触发正则，复刻时按你的实际 L1 场景精调。

### 5.2 注入（门控，`lib/retrieve.js:42-75` + `index.js:73-91`）

在 `agent/pre-step` 上按当前任务检索相关**可信**教训；`retrieve` 返回 `null`（无相关）时**不注入**，零成本。相关 = 词元重叠（tags 加权 2× + summary + fix），仅 trusted（除非 `includeQuarantined`）。

### 5.3 去重（`lib/policy.js:46-50` + `lib/store.js:181-198`）

`findSimilar` 用倒排索引圈出与新教训最相似的既有行，算词元重叠率 `overlap`；`isDuplicate` 当 `overlap ≥ dedupeThreshold(0.8)` 判重 → 跳过捕获。避免同一教训反复入库膨胀。

### 5.4 预算总账（复刻时别漏）

`maxPerSession`(捕获 20) / `maxCriticsPerSession`(批评 4) / `topK`(注入 4) / `tokenBudget`(注入 1500) / `candCap`(候选 40) / `dedupeThreshold`(0.8) / `threshold`(自判置信门 0.6) / `selfConsistency`(1)。**这些上限就是"自动但可控"的保证**（P4/P5 的成本边界）。

---

## 6. 索引机制（快速定位内部记忆）

数据目录（默认 `E:\DSH\.rsi-memory\`，`store.js` `openStore`）：

```
.rsi-memory/
├─ index.json        # 权威结构化源：每条教训一行 {id,domain,tags[],summary,fix,layer,trusted,weight,sourceRef,createdAt,updatedAt}
├─ termindex.json    # 倒排索引缓存：{ 词元 -> [lessonId,...] }（可由 index.json 重建）
├─ lessons/          # 人可读镜像（append-only）：每 domain 一个 <slug>.md，trusted 教训
├─ quarantined/      # 同上但存 !trusted 的隔离教训（待转正）
└─ trajectories/     # 原始自反问+工具轨迹 <ts>_<id>.jsonl（供日后 LoRA 蒸馏）
```

**倒排索引（`termindex`）**：`term → Set<lessonId>`。

- **内存缓存（非侵入关键）**：`index.json` + `termindex.json` 只在 `openStore`/`ensureLayout` 时读一次进内存，之后所有读（`candidatesFor/findSimilar/search/list`）全走内存，**热路径零磁盘 I/O**。
- **候选圈定（`candidatesFor`）**：对查询词元取各自 postings 的并集、按命中数排序、取前 `candCap`。**复杂度 O(查询词数 × postings)**，而非 O(全部教训 × 全文)——这就是"快速定位"。
- **精排（`retrieve`）**：在候选上做词元相关度 + 层优先级（`LAYER_ORDER`）+ 新度排序，封顶 topK 与 tokenBudget。
- **后台防抖写入（最小资源）**：`addLesson/promote/remove` 立即更新内存并**排队**；`flushSync` 在 `flushMs` 防抖后**一次性批量**落盘 `index.json`+`termindex.json`+`.md` 镜像+`trajectories/`。计时器 `unref`，不拖住进程；`close()` 收尾。
- **优雅降级（最大兼容）**：数据目录不可写时 `store.disabled=true`，退化为纯内存（继续可用，仅停止持久化），绝不向宿主抛错。

**复刻要点：** 权威源永远是 `index.json`（结构可查）；`termindex.json` 可丢可重建；`lessons/`、`trajectories/` 是人读与后续训练的镜像/原料。这样规模上千条时检索仍是线性可查。

---

## 7. 数据流（一次使用发生了什么）

```
用户任务
  │
  ├─ [pre-step] 倒排索引圈候选 → retrieve(trusted) → agent.inject 相关教训  (门控，可能 null)
  │
  ├─ [模型作答，内联] 注入的"自检指令"使模型三步反证 + 收尾 [VERIFY] 标签
  │
  └─ [turn/end]
        1. captureFromContext：解析 [VERIFY] + 跑 L1 scorers + classifySignal
             lib/capture.js:25-73
        2. shouldCapture？（非平凡 ∧ 预算 ∧ 去重）  lib/policy.js:57
        3. addLesson（trusted→lessons/，Q→quarantined/，后台落盘）+ addTrajectory  store.js
        4. shouldEscalate？→ criticBudgetOk？→ agent.followup(criticPrompt)  policy.js shouldEscalate / index.js
```

`captureFromContext`（`lib/capture.js:25-73`）产出 `{lesson, tag, scorer, cls, trajectory, capture}`；`capture` 为真当且仅当 `有 lesson/fix/L1-definitive`（`lib/capture.js:43`）——否则这轮什么都不留。

---

## 8. 与 AREX-2 论文的概念对应（原理溯源）

| 论文概念 | 本插件对应 |
|---|---|
| 自提升 = test-time scaling，`提升 ≈ r̄·T*`（每轮增益 × 有效轮数） | 反思轮次 + 跨会话记忆复用（`T*` 落到"复用次数"） |
| 两个元能力：反思(定 r̄) + 长程执行(定 T*) | 内联自反问(反思) + 长程任务的门控捕获/升级(执行) |
| 在**可验证反馈**域学，迁到不可验证域 | 通用模式下用**信号阶梯**把"可验证"做成可自动探测的 L1（有则最强，无则落到自反问/末拍） |
| 训练：对"前进型决策"loss，保留失败/回退轨迹 | `trajectories/` 存原始自反问+工具轨迹（含失败），供日后小 LoRA 蒸馏 |
| 27B 冻结、靠脚手架在推理期变强 | 本插件全程不改权重，只在推理期提供反思循环 + 预算 + 可验证反馈 |

**关键定位：本插件 = 论文"推理期脚手架"的工程实现 + Reflexion 式安全记忆层。** 权重冻结 → 无 RSI 复合自举风险；想"复合式"就进 §9。

---

## 9. 演进路线（把推理期脚手架升成真正的自改）

1. **现状（安全、已实现）：** 记忆/教训银行（无权重变更，即刻可用）。
2. **加一层（可选）：** 把 `trajectories/*.jsonl` + trusted 教训导出成训练语料，做**周期性小 LoRA 蒸馏**（rank 64–256，loss 落在"前进型决策"，即 AREX-2 的训练配方），让模型本身更会反思（r̄ 提升）。**不做"每次使用都自动改自己权重"**——那是 RSI 危险区（灾难性遗忘 + 自改风险）。
3. **检索升级：** 配置里留了 `embeddings` 钩子（`config.default.json:23`，默认 null）。规模大了可把 `candidatesFor` 的倒排并集换成嵌入向量近邻，`retrieve` 的词元相关度换成语义余弦。

---

## 10. 复刻清单（照抄即可重建）

**模块边界**（每个都能独立单测）：
- `interrogate.js`：`buildSelfCheckInstruction()`、`parseVerifyTag(text)`（取最后标签、`;`切、容错裸判定词）、`criticPrompt(task,answer)`、`selfConsistencyVerdicts(verdicts[])`。
- `signal.js`：`classifySignal({verdict,conf,scorer,userTap,threshold})`（§3 顺序）、`LAYERS`、`LAYER_ORDER`、`isInjectable/isQuarantined`。
- `scorers.js`：`codeScorer/mathScorer/sqlScorer/schemaScorer`（各 `{match,check}`）+ `runScorers(ctx)`（首个 definitive）。
- `capture.js`：`captureFromContext(ctx)` → `{lesson,tag,scorer,cls,trajectory,capture}`。
- `policy.js`：`outcomeSignal`、`isNonTrivial`、`isDuplicate`、`shouldCapture`、`shouldEscalate`（§4.2 顺序）、`criticBudgetOk`。
- `retrieve.js`：`tokenize`、`retrieve(lessons,task,cfg)`、`estimateTokens`。
- `store.js`：`openStore(dir,{flushMs})` → `{disabled,ensureLayout,list,addLesson,candidatesFor,findSimilar,promote,remove,addTrajectory,search,flushSync,flush,close}`（内存缓存 + 后台防抖写入 + 优雅降级）。
- `index.js`：`apply(ctx,config)` + `Config`（§5.4/§附 全部默认值；含 `enabled` 总开关 + `flushMs`）；注入"每轮一次"，清理时 `store.close()`。

**必守约定：**
1. 纯逻辑层零宿主依赖（可 `node --test`）。
2. `classifySignal` 判定顺序 = L1 → L3 → L2(REFUTED) → L2(CONFIRMED 分置信) → Q。
3. `shouldEscalate` 顺序 = userForced → L1 已决 → 无标签 → 判定。
4. 只注入 trusted；Q 走 `promote` 转正。
5. 倒排 `termindex` 是缓存，`index.json` 是权威源。
6. 宿主侧每个 DSH 调用带 `?.` 防御 + try/catch，形状错误 no-op。

---

## 11. 已知边界与风险

- **推理期脚手架而非权重自改**：能力提升靠记忆复用，模型本体不变（安全但上限有限，需 §9.2 蒸馏突破）。
- **通用模式 L1 覆盖率**：代码/数学/SQL/schema 之外的任务没有自动可验证检查，只能靠自反问 + 末拍；触发正则（`ERROR_RE/DECISION_RE`）需按场景精调。
- **宿主事件形状待校准**：`index.js` 的 `turn/end` 载荷、`agent.followup/inject`、`tools.register` 是"文档名 + 防御假设"，首启用 `cordis_inspect_query`（Event/Service）确认。
- **词元相关度是粗信号**：千级规模后建议启用 §9.3 嵌入近邻。

---

## 12. 优化目标达成（非侵入 / 后台 / 最小资源 / 最大兼容）

本次优化把"自动进化"做到**不打扰宿主、不占资源、最大兼容**，五个要求逐一落地：

| 要求 | 落地机制 | 落点 |
|---|---|---|
| 不影响大模型/DSH 正常工作 | 读全走**内存缓存**；磁盘 I/O 只在**后台防抖**时发生；热路径（pre-step/turn-end）零阻塞；所有宿主调用 `?.`+try/catch | `store.js` + `index.js` |
| 只在特定时机自动触发 | 注入"**每轮一次**"（任务变化门控）；捕获只在 `turn/end` 且过 `shouldCapture`；批评轮只在 `shouldEscalate` 自动/强制 | `index.js` 钩子(2)(3) |
| 教训后台自动搜集到本地插件目录 | `addLesson/addTrajectory` 立即写内存 + **批量后台落盘**到 `dir`；`flushMs` 防抖合并 | `store.js` `scheduleFlush/flushSync` |
| 最小资源占用 | `index.json`/`termindex.json` 仅打开时读一次；写入合并；防抖计时器 `unref` 不拖住进程 | `store.js` |
| 最大兼容性 | 纯逻辑层零宿主依赖；目录不可写→`disabled` 纯内存降级；`enabled=false` 完全空操作；绝不向宿主抛错 | `store.js` + `index.js` |

**"自动但可控"的本质**：进化是后台、增量、有预算上限的；宿主感知成本≈0（一次内存检索 + 一次 prompt 注入），磁盘成本被防抖摊平。

---

## 附：默认配置（复刻的起始参数）

```jsonc
{
  "enabled": true,                       // 总开关；false = 完全空操作
  "dir": "E:\\DSH\\.rsi-memory",
  "flushMs": 500,                        // 后台写入防抖间隔（ms）
  "inject":   { "topK": 4, "tokenBudget": 1500, "candCap": 40, "enabled": true, "includeQuarantined": false },
  "capture":  { "enabled": true, "maxPerSession": 20, "minChars": 200, "dedupeThreshold": 0.8 },
  "escalate": { "enabled": true, "maxCriticsPerSession": 4, "selfConsistency": 1, "threshold": 0.6 },
  "embeddings": null
}
```

对照源码：`index.js`（`Config.defaults`）与 `config.default.json`。
