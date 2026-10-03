# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.4] - 2026-10-03

### Added

- 用户指令 / 长期偏好记忆：
  - 新增 `captureUserInstructions` 配置项，默认开启。
  - 当用户给出明确的长期约束或偏好（例如“以后都用 httpx”“请记住输出用简洁列表”）时，自动记录为可信 `L3 user-instruction` 教训。
  - 普通一次性任务请求不会写入记忆，避免噪音。
- 触发与诊断：
  - `rsi_events` 返回值、仪表板和 DSH 设置页新增 `instructions` 与 `lastInstruction` 诊断字段。
  - 更清楚地展示“纠正”与“指令”两类用户信号的累计计数。
- README 补充插件简介、更新日志链接、一键部署 / DSH 安装教程，并明确支持 Qwen3.8 Flash。

### Changed

- 记忆触发策略参考成熟记忆插件的写入门控：纠正立即落库，长期偏好 / 规则按显式关键词落库。
- `isUserInstruction` 改为更严格的长期指令识别，避免把普通任务请求当记忆。

## [0.1.3] - 2026-10-02

### Added

- 初版 DSH host RSI 插件：
  - 本地大模型每次使用后的持续自进化。
  - L1 可验证检查、L2 自判、L3 用户纠正信号阶梯。
  - 可信教训自动注入类似任务上下文。
  - 设置页、仪表板、`rsi_events` / `rsi_records` / `rsi_demo_capture` 工具。

