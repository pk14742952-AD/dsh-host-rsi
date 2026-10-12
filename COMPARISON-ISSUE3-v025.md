# 对照报告：dsh-host-rsi v0.2.5 × ninfer-fusion-kvmem issue#3（3188 轮实测）

> 日期：2026-10-12 ｜ 版本：v0.2.5（已推送 + Release 资产已上传）
> 对比依据：[issue#3 报告](https://github.com/1314521gjy/ninfer-fusion-kvmem/issues/3)
>（SWE-bench Verified 50 题 × 3188 轮真实负载：轮级空响应 206 次 / 6.5%，打回恢复率 ~100%，实例级空手交付 3/50 / 6%）

---

## 1. 完成状态总览（本轮交付）

| 项 | 值 |
|---|---|
| 版本 | v0.2.2 → v0.2.3 → v0.2.4 → **v0.2.5**（三轮连续优化，均含 issue#3 吸取项） |
| main | `76ea47ee1c1ce406e2cfdfbb17fa16e58dd3976d`（已推送 github.com，origin/main 同步） |
| tag | v0.2.5 = 已推送；Release [id=410668644](https://github.com/pk14742952-AD/dsh-host-rsi/releases/tag/v0.2.5) + 资产 `dsh-host-rsi.tgz`（sha256 下载回验两端一致） |
| 测试套件 | **141 pass / 0 fail**（演进：138 → 139 → 140 → +1 dashboard 指标测试 = 141） |
| 对照测试 | scripts/compare-baseline.mjs 20 场景三列对照（v0.2.2 基线 / 工作区 / 已装 profile）——工作区=profile 逐行一致，基线仅在 2 个目标修复点不同 |
| profile 同步 | lib/guard.js、lib/dashboard.js 哈希一致；package.json version 0.2.5 |

---

## 2. 对照表：issue#3 观测与结论 → 我们的实现

### 2.1 现象诊断（§1.1）

| issue#3 观测 | 数值 | 我们插件的对应实现 | 状态 |
|---|---|---|---|
| 轮级空响应（0 内容） | 206/3188 = 6.5% | 五态守卫 classifyLoop：EMPTY（原 400 字符阈值） | ✅ 已实现，且校准（见 2.2） |
| 空响应签名 = finish_reason=length + reasoning 烧满 | — | guard.js:95-98 按 finish_reason=length 分流：空→EMPTY（"budget burned, nothing delivered"）/ 非空→TRUNCATED | ✅ v0.2.3 新增 |
| 打回后恢复率 ~100% | R1 206 次全救回 | followup 纠正 ≤2 次（maxRetries=2 / maxPerSession=4），救回计数 guard.rescued | ✅ 已有 + v0.2.5 把"救回"补上 GUI |
| 实例级空手交付（任务收尾仍无结果） | 3/50 = 6% | guard.undelivered 遥测 + 轨迹落库（state Q, trusted:false） | ✅ 记录存在，**无实例级二道防线**（见 §4-A） |
| 退化循环 = 复读而非深思 | — | FIXED_POINT（规范化逐字相同检测） | ✅ 已有 |

### 2.2 校准教训（§2.3「400 字符阈值误伤对话短答」）

| issue#3 结论 | 我们 v0.2.3 落地 |
|---|---|
| 默认只抓 **0 字符真空交付**；400 阈值仅显式 `X-Guard-Profile: deliverable` 档启用 | `thresholdEmpty` 默认 `?? 0`（config.default.json:57 = 0）；显式 `thresholdEmpty:400` 仍可 opt-in；文件型交付仍用 thresholdFile=2000 |

### 2.3 补丁方向（§2.1/§2.2/§4 S3/S4/S5/S6）

| issue#3 建议 | 归属 | 我们的对应/判断 |
|---|---|---|
| S3 per-request thinking_budget | 服务端采样 | 无直接对应（JS 插件不动宿主请求）——但我们的烧穿话术（v0.2.4）在客户端给出同向干预：明确指令"直接把交付物写到可见回复，不要先长篇推理" |
| S2 分通道 presence 惩罚 | 服务端采样 | 同上，客户端不可操作；我们的轨迹层 Q 隔离（0.3 权重）承担"不回灌退化内容"职责 |
| S4 池守卫（max_tokens>kv_capacity → 显式 4xx） | 服务端 | 无对应（不代理请求） |
| S5 真 /healthz（1-token 探测 + 客户端熔断） | 服务端+客户端 | 我们有 /rsi/status.json 全状态（enabled/degraded）；熔断语义由 guard 的 canRetry 上限承担 |
| S6 ngram 接受率 >90% = 免费 loop 信号 | 服务端遥测 | 我们的免费信号 = FIXED_POINT 规范化逐字复读检测 + SHELL_LOOP 命令身份循环（v0.2.2 修复 names→identities） |

### 2.4 issue#3 未覆盖、但我们从自身真实数据发现并已修的（我们的额外贡献）

| 数据来源 | 问题 | 修复 |
|---|---|---|
| 真实遗留库 index.json（165 行） | 11 行系统自污染 `<goal_round>` / `Current runtime context` / `<system-reminder>` 全部 trusted L3，占可信记忆 10.5% | F1 SYSTEM_BOILERPLATE_RE 门控（isSystemLikeText 过滤系统块） |
| 真实库 53 条 user-corrections | 仅 26% 可执行（其余是抱怨/提问/任务回声） | 门控 + retrieve 只注入可执行指令类 |
| 真实库近重复键 | 37/165 = 22% | F2 hasDuplicate 跨 kind 判重（scopeOf 剥 kind 前缀，token 交集 ≥0.85） |
| 注入实验 | 检索注入含任务原文回声、截断垃圾、同文本双份 | F3 isTaskEcho 回声过滤 + fix 非冗余注入 |
| 真实库 user-corrections fix 全空 | — | L2 捕获路径已有 fix 注入逻辑（自反问 [VERIFY:] 提取） |

---

## 3. 双方能力对照（快照表）

| 维度 | issue#3 客户端护栏（Python 守卫代理） | dsh-host-rsi |
|---|---|---|
| 五态判定 | TRUNCATED > EMPTY > FIXED_POINT > SAME_PLAN | EMPTY/TRUNCATED/FIXED_POINT/SAME_PLAN/SHELL_LOOP |
| length 分诊 | length+非空→TRUNCATED | ✅ 同（v0.2.3） |
| 空交付阈值 | 0 字符默认，400 opt-in | ✅ 同（v0.2.3） |
| 纠正重试 | ≤2 次点名纠正 | maxRetries=2 / maxPerSession=4 |
| 恢复率遥测 | R1：206/206 救回 | guard.rescued 计数（v0.2.5 上 GUI） |
| 最终空手率 | 3/50 = 6% | guard.undelivered 计数 + Q 轨迹 |
| 预算烧穿话术 | "你把预算烧在内部思考了，立即输出一个短 bash 命令" | "You spent the previous turn's budget on internal reasoning…"（v0.2.4，适用 EMPTY+budget burned） |
| 模型侧推理预算 | thinking_budget / presence（服务端补丁） | 不可操作（客户端），以话术+轨迹隔离替代 |
| 记忆侧 | 无 | 这是我们独有维度：五态教训进入 L2 自反问 / 轨迹 |

**结论：客户端防卡死能力维度上，v0.2.5 与 issue#3 报告的护栏代理已对齐（同构五态 + 同阈值校准 + 同重试上限 + 同恢复率遥测）。差异集中在"服务端采样补丁"（我们不可操作）和"记忆侧进化"（我们独有）。**

---

## 4. 下一步优化方向（按优先级）

### A [高] 实例级二道防线：任务收尾最终交付检查（对位 issue#3 的 3/50）
- 现状：guard.undelivered 只计数+落轨迹；undelivered>0 时没有在实例级（任务结束）主动兜底。
- 建议：在 `handleMessage` 收尾路径检查该会话 `guard.undelivered > 0` 时，追加一条"最后通牒" followup（类似烧穿话术：明确要求输出交付物路径/结论，作为最终 chance），并记录 `guard.rescuedFinal`——把 6% 压到接近 0。
- 收益：直接对位报告最痛的两个数字之一（另一个 6.5% 轮级已覆盖）。

### B [高] 收敛计数窗口化（对位 issue#3 S1「环形窗口才治愈、累计直方图只能打断」）
- 现状：convergence 的 fingerprintCounts / consecutivePassCount 整会话累计，仅源文件改动 resetState。
- 报告 S1 的核心洞见：**近 ~20-48 token 环形窗口** 优于全序列累计。长会话中同类工具在无源码改动时反复出现，累计计数可能过晚触发或误触发。
- 建议：给 fingerprintCounts 加"近 N 轮滑动窗口"（如近 8 轮指纹去重计数），保留源码编辑重置；用窗内计数驱动 SOFT_STEER 阈值。
- 收益：避免"打断"（纠正式）过度依赖，前移为"预防式"收敛注入——正是报告"治愈 vs 打断"的客户端对应物。

### C [中] 检索注入的剩余噪声：跨项目/跨会话泄漏
- 现状：F1/F3 已过滤系统块与回声；但注入实验显示仍可能混入"当前任务的回声"（正在进行的任务文本被当作既有记忆注入）与跨项目噪声。
- 建议：retrieve 时对 query 与候选做"任务级指纹"去重（若 lesson 文本与当前任务文本相似度 >0.8 则跳过）；可选给 lessons 加 `project` 白名单上下文参数。
- 收益：提升注入信噪比——这是"插件有没有用"的关键杠杆（真实库数据：26% 可执行）。

### D [低] 遥测闭环：救回后完成度二阶统计
- 现状：guard.rescued 只数"打回后下一轮被守卫放行"，不验证该轮是否真正产出交付物。
- 建议：在 followup 后下一轮结束时回填 `rescuedCompleted`（该轮非空/fix 提出），dashboard 展示完成率，对齐报告 R1"恢复率"口径。

### E [低] LoRA 蒸馏路径（PRINCIPLES §可选下一步，与报告 §4 无冲突）
- 报告证明护栏+推理预算控制提升 resolved 30/50 vs 23/50（+14 分点）。护栏是"外挂"，蒸馏是把五态教训压进模型参数；两者正交，可作为远期。

### F [低] S6 免费信号移植思想
- 报告：ngram 接受率 >90% = 复读信号。我们已用 FIXED_POINT 覆盖"逐字复读"，可扩展"SAME_PLAN 连续 ≥2 次"进 SOFT_STEER（已存在 SAME_PLAN 态，仅需接线计数）。

---

## 5. 论文级判断（把 issue#3 当实证论文读）

1. **"presence 只能打断、环形窗口才算治愈"**（S1）——判断成立且可迁移：
   服务端采样器与我们客户端的"纠正话术"本质都是"打断"。真正的客户端"治愈"只能是**收敛预防**（提前注入 steering，让模型不进退化态）。这正是我们 convergence 模块的定位；方向 B 把它从"累计计数+源码重置"升级为"近窗计数"是最高性价比的下一步。
2. **恢复率 > 拦截率**：报告 R1 的 100% 恢复率说明"打回-纠正"循环本身可靠，瓶颈在实例级（3/50）。方向 A 与之精确对齐。
3. **校准比阈值更重要**：400→0 的教训（§2.3）我们 1:1 复刻并加了 opt-in；这验证了"默认保守、显式严苛"的配置哲学应贯穿后续所有阈值。
4. **记忆侧是你能给、对方没有的**：issue#3 全程无记忆侧；我们的 L2 自反问教训、轨迹、LoRA 蒸馏是差异化纵深。下一步重心应放在 B/C（预防+信噪比），而非继续堆客户端五态。

---

## 6. 数据附录

### 6.1 我们插件的测试与对照数据
- 测试套件：141 pass / 0 fail（test/*.test.js，node --test）
- 对照：scripts/compare-baseline.mjs 20 场景，三列（v0.2.2 基线 / 工作区 / profile）：
  - 工作区 = profile 全部一致
  - 基线仅在 2 点不同：EMPTY 短答（基线误伤 EMPTY → 新 OK）、length+空（基线 TRUNCATED → 新 EMPTY）
  - 其余 18 项完全一致（F1 门控、F2 判重、F5 自愈、F4 收敛判定、F7 tokens、SHELL_LOOP、signal REFUTED、scorers、20k 截断）

### 6.2 我们的真实遗留库（E:\DSH\.rsi-memory）统计
- index.json 87,829B / 165 行；debug-session-events.jsonl 189,925B
- lessons 12 文件 32,467B；trajectories 165 文件 112,294B（全部空壳 Q 轨迹）；quarantined 2 文件
- 53 条 user-corrections → 14 条可执行（26%）；近重复键 37/165（22%）
- 11 行系统自污染（已修门控）

### 6.3 issue#3 关键数值（引自报告）
- 3188 轮、空响应 206（6.5%）、恢复率 ~100%、undelivered 3/50（6%）
- max_tokens 64000→~160s / 16384→~40s
- ngram 投机接受率常态 ~71.8%
- resolved 30/50（新栈）vs 23/50（旧栈），出 patch 率 94%，缓存命中中位 97%，infra_failure=0

---

*本文档随 v0.2.5 发布；下一步实施时更新。*