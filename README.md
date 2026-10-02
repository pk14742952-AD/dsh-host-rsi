> 中文（默认） · [English](./README.en.md)

# DSH HOST RSI记忆

**给本地大模型做的 DSH 宿主插件，目前主要面向 Qwen3.8-27B 这类本地 27B 模型。**
针对本地大模型的**每次使用持续自进化**，以 DSH **宿主插件**形式实现。
每次使用：模型先"反问式"自检（counter-reason）自己的答案；**可信**教训被保存并在下次注入；
便宜方法没解决时，深度批评轮**自动**升级。通用模式：无需针对特定任务的评分器。

仓库地址：<https://github.com/pk14742952-AD/dsh-host-rsi>

> **想理解技术原理、或在自己环境复刻？** 读 [PRINCIPLES.md](./PRINCIPLES.md)
> （专用文档：信号阶梯 / 反思循环 / 触发与效率 / 索引机制 / 与 AREX-2 的对应 / 复刻清单，逐点标注源码行号）。

## 原理来源（致谢 / Principle Source）

本项目的**核心原理**源自并致敬以下公开研究成果：

- **AREX-2**（arXiv:2609.38288，BAAI 2026）——自我进化智能体框架。本项目把它**落地**为「本地、增量、可用即学」的 DSH 宿主插件；逐点技术对应见 [PRINCIPLES.md](./PRINCIPLES.md)。
- **递归自我改进（Recursive Self-Improvement, RSI）与持续学习（Continual Learning）**——每次运行把成功/失败经验沉淀为**可检索、可反驳、可自动升级**的经验条目；可信经验下轮注入上下文，实现「**越用越强**」。这是本项目记忆层信号阶梯与升级策略的原理基础。

> **GUI 说明**：本项目此前**缺少 GUI**，本次补齐。仪表板「设置页里点一下即开网页」的**显示方式**参考了 DSH 插件 `billion-context`（MIT）——**仅参考其展示思路，代码为独立重写，并非复制其代码**（详见 [client.js](./client.js) 与 [lib/dashboard.js](./lib/dashboard.js)）。

## 仪表板 / GUI

DSH 重启后：「设置」→「插件」→ **「DSH HOST RSI记忆」** →「打开仪表板」，即可在浏览器查看插件运行状态（启用中/降级、可信/隔离/轨迹、最近记录）。页面每 3 秒轮询 `status.json`。
也可在本机直接跑**独立 demo**（不依赖 DSH）：
```
node demo-serve.mjs                # 本机回环 + 示例记录（默认端口 8788）
RSI_DEMO_PORT=9000 node demo-serve.mjs
```

## 设计目标（本次优化重点）

- **不影响大模型 / DSH 正常工作**：所有读走**内存缓存**；磁盘 I/O 只在**后台防抖写入**时发生，
  热路径（pre-step / turn-end）**永不阻塞**。
- **只在特定时机自动触发**：注入"每轮一次"（按任务变化门控）；捕获只在 `turn/end` 且通过
  `policy.js` 门控；批评轮只在便宜方法失败或用户强制时自动开。
- **教训后台自动搜集到本地插件目录**：`addLesson/addTrajectory` 立即写内存、**批量后台落盘**
  （`flushMs` 防抖）；目录不可写时**降级为纯内存**（`store.disabled`），插件不崩、照常工作。
- **最小资源占用**：`index.json`+`termindex.json` 仅在打开时读一次，之后全内存；写入合并批处理；
  防抖计时器 `unref`，不占用事件循环 / 不拖住进程退出。
- **最大兼容性**：纯逻辑层零宿主依赖（可 `node --test`）；宿主侧每个 DSH 调用都带 `?.` 防御 +
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
    spine.js             # 轮生命周期 + 任务变更检测
    retrieve.js          # 相关度排序 + token 预算
    inject.js            # 注入文本生成
    interrogate.js       # 自检指令、[VERIFY] 标签解析、批评 prompt、自一致
    signal.js            # 信号阶梯判定（L1/L3/REFUTED/CONFIRMED + 权重）
    scorers.js           # L1 可验证检查（code/math/sql/schema 自动探测）
    capture.js           # 把一轮编排为"已分类教训 + 轨迹"
    policy.js            # 触发 + 升级 + 预算门控
    store.js             # 文件存储 + 倒排索引（内存缓存 + 后台防抖写入 + 优雅降级）
    status.js            # 快照 + records + formatStatusReport
    dashboard.js         # dashboardHtml + /rsi/* webserver handler + 本机 dashboard server
  locale/                # 设置标签 i18n（zh/en）
  test/                  # node:test 套件（含 webserver/client 宿主集成测试）
E:\DSH\.rsi-memory\      # 数据目录（人可读的权威源）
  index.json  termindex.json
  lessons/<domain>.md    # 可信，可人工策展
  quarantined/<domain>.md# 未验证，日后转正
  trajectories/*.jsonl   # 原始轨迹（供日后 LoRA 蒸馏）
```

## 安装（在 DSH 中）

宿主专用 bundle。从 GitHub 安装：

```bash
dsh plugin --profile web add github:pk14742952-AD/dsh-host-rsi
```

发布到 npm 后也可以直接安装：

```bash
dsh plugin --profile web add dsh-host-rsi
```

也可以用插件管理器对本地目录 `dsh-host-rsi/` 执行 `plugin_manager install_bundle`。
安装后重启 DSH 即可生效，无构建步骤。

## 首启验证

`index.js` 里 `ctx` 事件载荷形状是"文档名 + 防御假设"（`agent/pre-step`、`turn/end`、`agent.followup`）。
首启用 `cordis_inspect_query`（Event/Service）确认：
- `turn/end` 事件暴露胶水所需的 任务 + 助手文本 + 工具结果；
- 你的 profile 里 `agent.followup` / `agent.inject` 是否存在（不存在则这些路径安全空操作）。

然后运行：

```bash
cd E:\DSH\dsh-host-rsi
node --test          # 纯逻辑 + 数据层套件（自动发现 test/*.test.js）
```

## 配置（bundle 行 `config`）

见 `config.default.json`：
- `enabled`（总开关，false=完全空操作）、`dir`（数据目录）、`flushMs`（后台写入防抖 ms）；
- `inject.{topK,tokenBudget,candCap,enabled,includeQuarantined}`；
- `capture.{enabled,maxPerSession,minChars,dedupeThreshold}`；
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
