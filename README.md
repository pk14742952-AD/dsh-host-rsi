> 中文（默认） · [English](./README.en.md)

> **欢迎使用与回馈**：如果发现 bug 或有改进想法，欢迎提交 Issue / PR，我会不定期修正与合并；
> 如果觉得好用，希望能点一个 ⭐ Star，谢谢支持！

# DSH HOST RSI记忆

**给 DSH 做的通用宿主插件，默认面向本地大模型调参；当前重点覆盖 Qwen3.8-27B 与 Qwen3.8 Flash 等本地 27B/轻量模型，也兼容 API 模型。**
插件不做模型权重修改，只做**每次使用持续自进化**的宿主侧记忆层，以 DSH **宿主插件**形式实现。
每次使用：模型先"反问式"自检（counter-reason）自己的答案；**可信**教训被保存并在下次注入；
便宜方法没解决时，深度批评轮**自动**升级。通用模式：无需针对特定任务的评分器。

仓库地址：<https://github.com/pk14742952-AD/dsh-host-rsi>

> **插件简介**：这是一个给 DSH 用的通用记忆 / 自进化插件。它在后台采集每次使用的
> 成功、失败、用户纠正与长期偏好，把高价值经验沉淀为可信教训，并在下次遇到相似任务时自动注入。
> 更新日志见 [CHANGELOG.md](./CHANGELOG.md)。

> **想理解技术原理、或在自己环境复刻？** 读 [PRINCIPLES.md](./PRINCIPLES.md)
> （专用文档：信号阶梯 / 反思循环 / 触发与效率 / 索引机制 / 与 AREX-2 的对应 / 复刻清单，逐点标注源码行号）。

## 原理来源（致谢 / Principle Source）

本项目的**核心原理**源自并致敬以下公开研究成果：

- **AREX-2**（arXiv:2609.38288，BAAI 2026）——自我进化智能体框架。本项目把它**落地**为「本地、增量、可用即学」的 DSH 宿主插件；逐点技术对应见 [PRINCIPLES.md](./PRINCIPLES.md)。
- **递归自我改进（Recursive Self-Improvement, RSI）与持续学习（Continual Learning）**——每次运行把成功/失败经验沉淀为**可检索、可反驳、可自动升级**的经验条目；可信经验下轮注入上下文，实现「**越用越强**」。这是本项目记忆层信号阶梯与升级策略的原理基础。

> **GUI 说明**：本项目此前**缺少 GUI**，本次补齐。仪表板「设置页里点一下即开网页」的**显示方式**参考了 DSH 插件 `billion-context`（MIT）——**仅参考其展示思路，代码为独立重写，并非复制其代码**（详见 [client.js](./client.js) 与 [lib/dashboard.js](./lib/dashboard.js)）。

## 仪表板 / GUI

DSH 重启后：「设置」→「插件」→ **「DSH HOST RSI记忆」** →「打开仪表板」，即可在浏览器查看插件运行状态（启用中/降级、可信/隔离/轨迹、最近记录）。页面每 5 秒轮询 `status.json`，并显示**触发诊断**：已处理事件、注入、捕获、失败信号、拦截噪声、最近触发事件与原因。
也可在本机直接跑**独立 demo**（不依赖 DSH）：
```
node demo-serve.mjs                # 本机回环 + 示例记录（默认端口 8788）
RSI_DEMO_PORT=9000 node demo-serve.mjs
```

## 设计目标（本次优化重点）

- **不影响大模型 / DSH 正常工作**：所有读走**内存缓存**；磁盘 I/O 只在**后台防抖写入**时发生，
  热路径（pre-step / turn-end）**永不阻塞**。
- **更强的自动触发**：宿主侧同时监听 `pre-step / turn-end / message` 的多个常见事件名（`agent/pre-step`、`message`、`chat/message` 等），谁存在就用谁，并用事件对象/内容去重，避免一轮触发两次。
- **立刻能看到的反馈**：设置页和仪表板显示实时触发计数（事件/注入/捕获/失败）；即使尚未产生可信教训，普通工具失败也会留下**隔离记录**，让用户确认插件确实在工作。
- **诊断与体验工具**：模型或用户可调用 `rsi_events` 查看触发诊断；`rsi_demo_capture` 可写一条示例教训，用于快速验证仪表板/设置页。
- **用户纠正与长期指令会被记住**：当用户在一轮回复后给出明确纠正或新指令（例如“不要用 requests，改用 httpx”），
  插件会把它记为 **L3 可信教训**。明确的长期偏好 / 规则（“以后都用 httpx”“请记住输出用简洁列表”）
  也会在用户提出时记录为 `user-instruction` 可信教训；普通一次性任务请求只记隔离 `Q` 记录，
  不会进入注入，避免污染未来上下文。
- **来源闸门，防止系统内容污染记忆**：只有 `source.kind === 'user'` 的真实用户消息才会被捕获；
  DSH 运行时横幅、其他插件注入的指令、以及本插件的自检块都会被拦截并计入「拦截噪声」，
  每条用户记录还会带上 `sourceKind` 字段方便自查。
- **指令按项目去重，防止记忆库膨胀**：用户指令会尽量按项目/工作区分组（从指令里的路径或会话上下文提取，
  取不到则归到全局），同项目内近义/重复指令会被 `hasDuplicate` 门槛拦截；不同项目出现相似指令不会被误合并。
- **教训后台自动搜集到本地插件目录**：`addLesson/addTrajectory` 立即写内存、**批量后台落盘**
  （`flushMs` 防抖）；目录不可写时**降级为纯内存**（`store.disabled`），插件不崩、照常工作。
- **最小资源占用**：`index.json`+`termindex.json` 仅在打开时读一次，之后全内存；写入合并批处理；
  防抖计时器 `unref`，不占用事件循环 / 不拖住进程退出。
- **最大兼容性**：纯逻辑层零宿主依赖（可 `npm test`）；宿主侧每个 DSH 调用都带 `?.` 防御 +
  try/catch，形状错了就空操作，绝不向宿主抛错。

## 进化机制（可靠性加权信号阶梯）

```
任务 + 答案
  ├─ L1  有可验证检查？（代码测试 / 数学== / SQL 匹配 / schema 合法）
  │        → 跑它。L1 失败 = 高价值纠正型教训。（决定性 → 停）
  └─ 无 L1 → 内联自反问：模型输出
           [VERIFY: CONFIRMED|REFUTED|UNCERTAIN; conf=..; lesson=..; fix=..; reason=..]
         ├─ CONFIRMED 且 conf≥thr   → 可信 L2，结束（不开批评）
         ├─ REFUTED                  → 自动批评轮（重推 fix）→ 纠正型教训
         ├─ UNCERTAIN / 无标签 / 低 conf → 自动批评轮
         └─ 用户 rsi_verify 强制      → 自动批评轮
       批评后仍不确定 → 进隔离区（被更强信号证实后才注入）
```

**自动但高效：** 每条重路径都有门控。无相关时全空操作；只在带结果信号的轮次（出错 / 跑工具 /
产出物 / 决策 / 自选标签）捕获；便宜方法失败才开批评；每会话预算封顶成本。

## 目录结构

```
dsh-host-rsi/            # 插件包（代码）
  index.js               # DSH 宿主入口：apply() + rsi_status 工具 + __RSI__ 注入 + /rsi/* 路由
  client.js              # 浏览器客户端：DSH 设置页「DSH HOST RSI记忆」标签（展示方式参考 billion-context，代码独立重写）
  demo-serve.mjs         # 本机独立 demo（不依赖 DSH，loopback + 示例记录）
  cordis.patch.yml       # DSH 宿主 bundle 补丁（插入 dsh-host-rsi）
  config.default.json    # 默认配置
  icon.svg               # 设置页图标
  lib/                   # 纯逻辑（可单测，零宿主依赖）
    capture.js           # 把一轮编排为"已分类教训 + 轨迹"
    dashboard.js         # dashboardHtml + /rsi/* webserver handler + 本机 dashboard server
    interrogate.js       # 自检指令、[VERIFY] 标签解析、批评 prompt、自一致
    policy.js            # 触发 + 升级 + 预算门控 + 来源/系统内容过滤
    retrieve.js          # 相关度排序 + token 预算
    scorers.js           # L1 可验证检查（code/math/sql/schema 自动探测）
    signal.js            # 信号阶梯判定（L1/L3/REFUTED/CONFIRMED + 权重）
    store.js             # 文件存储 + 倒排索引（内存缓存 + 后台防抖写入 + 优雅降级）
    status.js            # 快照 + records + formatStatusReport
  locale/                # 设置标签 i18n（zh/en）
  test/                  # node:test 套件（含 webserver/client 宿主集成测试）
~/.dsh/rsi-memory/      # 数据目录（人可读的权威源；DSH_HOME 环境变量可覆盖）
  index.json  termindex.json
  lessons/<domain>.md    # 可信，可人工策展
  quarantined/<domain>.md# 未验证，日后转正
  trajectories/*.jsonl   # 原始轨迹（供日后 LoRA 蒸馏）
```

## 一键部署 / DSH 安装教程

### 本地快速体验（不需要 DSH）

```bash
git clone https://github.com/pk14742952-AD/dsh-host-rsi
cd dsh-host-rsi
node demo-serve.mjs
```

然后用浏览器打开控制台输出的回环地址，就能看到仪表板和示例记忆。

### 在 DSH 中安装

宿主专用 bundle。从 GitHub 安装：

```bash
dsh plugin add github:pk14742952-AD/dsh-host-rsi
```

如果你的 DSH 使用非默认 profile，请按需追加 `--profile <你的profile>`。
插件**尚未发布到 npm**，当前请使用上面的 GitHub 安装方式，或对本地目录执行
`plugin_manager install_bundle`。

安装完成后重启 DSH 即可生效，没有构建步骤。

### 模型适配

插件是 **模型无关的宿主侧逻辑**，不依赖具体模型参数量，本质上 DSH 能驱动的模型都可以用：

- 本地 27B 模型（如 Qwen3.8-27B）：当前默认设置按此调优，是项目重点验证对象。
- 本地轻量/Flash 模型（如 Qwen3.8 Flash）：可以运行，若上下文窗口偏小建议降低
  `inject.topK` / `inject.tokenBudget` / `capture.maxPerSession`。
- API 或云端模型：同样可用，因为它只注入文本和读取宿主事件，不改模型权重；较大的上下文模型可适当调高
  `inject.topK` / `inject.tokenBudget` 获得更完整的记忆复用。

如果你的模型参数量或上下文差异较大，只需要调整 `config.default.json` 里的注入预算，不需要改插件代码。

## 首启验证

`index.js` 里 `ctx` 事件载荷形状是"文档名 + 防御假设"（`agent/pre-step`、`turn/end`、`agent.followup`）。
首启用 `cordis_inspect_query`（Event/Service）确认：
- `turn/end` 事件暴露胶水所需的 任务 + 助手文本 + 工具结果；
- 你的 profile 里 `agent.followup` / `agent.inject` 是否存在（不存在则这些路径安全空操作）。

然后运行：

```bash
cd dsh-host-rsi
npm test             # 纯逻辑 + 数据层套件（node --test test/*.test.js，不会碰需要本地模型的 e2e）
```

## 配置（bundle 行 `config`）

见 `config.default.json`：
- `enabled`（总开关，false=完全空操作）、`dir`（数据目录）、`flushMs`（后台写入防抖 ms）；
- `inject.{topK,tokenBudget,candCap,enabled,includeQuarantined,oncePerTask,selfCheck,maxInjectsPerTask,reinjectOn,compactTopK,compactTokenBudget}`；
  `selfCheck=false` 时不再注入强制 `[VERIFY: ...]` 尾行，适合结构化输出 / schema 约束场景；
- `capture.{enabled,maxPerSession,minChars,dedupeThreshold,captureUserCorrections,captureUserInstructions}`；
- `escalate.{enabled,maxCriticsPerSession,selfConsistency,threshold}`；
- `embeddings`（预留，默认 null；规模大了可换成嵌入近邻）。

默认值对本地模型偏保守。

## 开源协议（License 合规）

- **本项目（`dsh-host-rsi`）采用 MIT 协议**，见 [LICENSE](./LICENSE)。
- **原项目 DSH（`@deepseek-ai`，MIT，Copyright 2026 DeepSeek）**：本项目是 DSH 的**宿主插件**，**不修改、不分发 DSH 源码**，仅通过 DSH 的宿主 API（`ctx.on` / `ctx.inject` / `webServer.register` / 页面注入）与其协作。MIT 为宽松许可、**支持第三方插件**与其共存并独立发布；本项目**未复制 DSH 代码**，故无随附 DSH 版权声明的强制义务（此处主动注明，以示合规）。
- **billion-context（MIT，Copyright 2026 ranxianglei）**：仅**参考**其「设置页内嵌网页」的**展示思路**并独立重写代码（非逐字复制）；按 MIT 惯例在此致谢。

> **结论**：原项目 DSH 采用 **MIT 宽松协议、支持第三方插件**，故本项目可**合规发布**；本项目同为 MIT，并显式致谢 DSH 与 billion-context。

## 可选下一步：权重级进化

`trajectories/` + trusted 教训是干净的训练集。周期性导出后在 Qwen3.8-27B 上做小 LoRA 蒸馏
（loss 只落在"前进型决策"上），把元技能烤进权重——这是运行时记忆环路的批量、安全补充。
