# 对照测试报告 — dsh-host-rsi 0.2.2（修复前后行为对比）

日期：2026-10-11
方式：`scripts/compare-baseline.mjs` 对同一批场景分别跑 **旧基线（ede9dbf / v0.2.1 未修补）**、**工作区修复后代码**、**已安装 profile**，输出对比表。
结论：**10/10 项修复场景在新代码与已安装 profile 中行为一致且符合设计；旧基线在全部修复项上表现出缺陷行为。**

## 对比表（1=旧基线 v0.2.1，2=工作区，3=已安装 profile）

| 场景 | 旧基线 | 工作区 | 已安装 |
|---|---|---|---|
| F1 `<goal_round>` 系统文本被门控 | false（污染） | **true** | **true** |
| F6 outcomeSignal 缺 toolResults 不抛 | THROW TypeError | **不抛** | **不抛** |
| F2 同文本跨 kind 判重 | false（漏判） | **true** | **true** |
| F5 损坏 index.json 自愈（disabled 保持 false） | disabled=true 永不自愈 | **自愈** | **自愈** |
| F4 looksPassed "3 passed; 0 failed" | false（误判失败） | **true** | **true** |
| F4 looksPassed "BUILD FAILED" | false | false（正确判负） | false |
| F7 estimateTokens 20 中文字符 | 5（低估~3倍） | **12** | **12** |
| F3/F7 任务回声过滤 + 非L1注入fix | 回声注入+fix丢失 | **回声丢弃+fix注入** | **同** |
| SHELL_LOOP 三条不同命令 | 误判 SHELL_LOOP | **EMPTY（正确）** | **EMPTY** |
| SHELL_LOOP 同命令×3 | SHELL_LOOP | SHELL_LOOP | SHELL_LOOP |
| signal 用户 REFUTED | trusted=false（丢弃最强纠正） | **trusted=true** | **trusted=true** |
| scorers 裸 node 算测试 | definitive=true（误判） | **definitive=false** | **definitive=false** |
| scorers pytest ok:false | passed=false | passed=false | passed=false |
| guard 被拒答案截断 | 10k 单段 | 头6000+尾800 双段 | 同 |

## 已安装 profile 同步确认

4 个本轮修复文件（signal.js / guard.js / scorers.js / store.js）已 byte-copy 到
`C:\Users\Administrator\.dsh\profiles\desktop\node_modules\dsh-host-rsi\lib`，
SHA-256 逐一比对一致（retrieve/convergence/policy 上轮已同步，全库 11 个 lib 文件无一差异）。
重启 DSH 桌面端后生效。

## 用途

- 回归护栏：以后每次改 lib 重新跑 `node scripts/compare-baseline.mjs <旧基线lib> <新lib> <已安装lib>`，
  三列应一致且符合设计。
- 对照测试是"修复确实生效"的实证，不是纸面声明。
