# dsh-host-rsi v0.2.1 严格审查报告

> 审查对象：`E:\DSH\dsh-host-rsi`（v0.2.1，HEAD `ede9dbf`）
> 方法：3 路子代理并行初筛 → 主 Agent 对每条 CRITICAL/HIGH 逐行读原文复核 → 3 个现场复现脚本（`node` 直跑，输出见 §0.3）→ 测试基线
> 基线：`node --test test/*.test.js` = **121 pass / 0 fail**——本报告所有缺陷均无测试覆盖，绿灯提供的是虚假安全感

---

## 0. 审查结论速览

### 0.1 做得好的地方（先给结论的正面）

- **源门控真实存在**：`index.js:717-721`（genuineUser + isSystemLikeText → blockedNoise）、`index.js:869-871`（importRecent 同样过 sourceKind + 系统样板过滤）——DSH 横幅/其它插件注入的用户角色内容不会进记忆。
- **去重已接两条主路径**：`index.js:730`（correction）、`index.js:746`（instruction）、`index.js:896`（importRecent）均先 `store.hasDuplicate` 再 `addLesson`。
- **事件兼容 + 去重**：`index.js:284-287` 多事件名兼容、`markSeen`（585-596）WeakSet + 2.5s Digest 防同轮双触发。
- **环回默认安全**：dashboard 默认 `127.0.0.1`（`config.default.json:43`）、`server.unref()`、bind 失败静默降级（`index.js:352`）。
- **优雅降级链路完整**：store 不可写 → 内存模式（`store.js:203-204`）；宿主缺服务 → no-op（大量 try/catch）。
- **测试基建不错**：121 条覆盖 store/retrieve/capture/guard/convergence/webserver/dashboard 主路径。

### 0.2 缺陷分布

| 严重度 | 数量 | 编号 |
|---|---|---|
| CRITICAL（数据丢失级） | 1 | C1 |
| HIGH（核心功能失效/安全面） | 3 | H1, H2, H3 |
| MEDIUM（正确性/性能/规模） | 10 | M1–M10 |
| LOW / 设计讨论 | 8 | L1–L8 |

### 0.3 现场复现实测输出（本报告证据）

```
1) looksPassed('test result: ok. 3 passed; 0 failed; 0 ignored', 'test') -> false   # 应 true（H1）
2) looksPassed('ℹ pass 121 / ℹ fail 0', 'test')                        -> true    # 自身生态不受影响
3) looksPassed('Compiled successfully', 'build')                        -> true    # 取反兜底（H1）
4) classifyCheck('grep -r tsc src') -> {family:'build'}                 # 误分类（H1）
5) looksPassed('returned 200 items', 'runtime')                         -> true    # /\b200\b/ 误配（H1）
6) isUserCorrection('今天下午我们继续把这个模块看完然后就开始休息吧')      -> true    # 中性陈述误判纠正（H3）
7) isUserCorrection('不对，这里应该用异步方式，你刚才写错了')              -> true    # 真纠正（对照组）
8) 损坏 index.json（模拟写盘中崩溃）→ openStore().ensureLayout() 后 disabled=true；
   addLesson() 不抛异常，close() 后 index.json 原样损坏、lessons/ 为空——旧数据新数据全部丢（C1）
```

复现方式：三个一次性脚本（`repro-defects*.mjs`）已删除；按 §2 各条的原文行号可随时重建。

---

## 1. CRITICAL

### C1 存储非原子写 + 损坏即永久静默失效（数据丢失）

**原文**

- `store.js:134` `fs.writeFileSync(indexFile, JSON.stringify(rows, null, 2), 'utf8');`——直接覆写权威文件，无 temp+rename、无 fsync。写盘途中进程崩溃/断电 = index.json 被截断。
- `store.js:198-204` `const arr = JSON.parse(fs.readFileSync(indexFile, 'utf8')); ... } catch { disabled = true; }`——解析失败只置 `disabled=true`，**不备份、不告警、不自愈**。
- `store.js:127-130` `if (disabled) { dirty = false; return false; }`——disabled 后连 `mirrorBuf`（144 行）、`trajBuf`（154 行）的泄放也跳过，缓冲永久滞留。
- 启动链路 `index.js:299-301`：migrateLegacyDir → openStore → ensureLayout，没有任何损坏探测/恢复 UI。

**触发链**：flush 定时器（默认 1000ms）触发全量写 → 期间崩溃 → 下次启动 ensureLayout 抛错 → disabled=true → 此后所有 `addLesson` 只进内存 → 进程退出即全丢，且用户端零提示（dashboard 只显示"已停用"）。

**复现**：§0.3 第 8 条——损坏文件加载后 `disabled=true`，`addLesson` 后 `close()` 磁盘零变化（连崩溃前的旧行也没保住）。

**影响**：这是"持续学习"插件的命根子。一次崩溃 = 永久静默丢失全部记忆 + 停止学习，且无任何恢复路径。

**修复方案**：
1. 原子写：`writeFileSync(indexFile+'.tmp')` → `fsync` → `renameSync` → 对目录 `fsync`（Windows 上 rename 本身原子，fsync 保序）。
2. ensureLayout 损坏时：`renameSync(indexFile, index.json.corrupt-<ts>)`，保留现场，从空数组重建，并向 runtime 记一条 `lastReason='store-recovered'`（dashboard 可见）。
3. `disabled` 语义收窄为"目录不可写"；内容损坏走恢复路径而非禁用。
4. disabled 时 mirrorBuf/trajBuf 改为"尽力落盘 + 计数告警"，至少不能静默滞留。

---

## 2. HIGH

### H1 convergence.looksPassed 子串误判（零失败输出被误杀 / 静默构建被误放）

**原文** `convergence.js:131-153`：

```js
if ( t.includes("error:") || ... || t.includes("failed") || t.includes("fail 1") || ... ) return false;   // 137 行
if (family === "test") return /\b\d+\s+passed\b/.test(t) || t.includes("✔") || ... ;                     // 146 行
if (family === "build") return t.includes("build succeeded") || t.includes("build success") || !t.includes("error ts");  // 148 行
if (family === "runtime") return ... || /\b200\b/.test(t);                                              // 150 行
```

**触发链**：`index.js:1021-1025`（tools/post-execute）→ `observeShell` → `looksPassed` 判负即 `return null` → `passedFamilies` 永不累积 → `convergence.js:172` `size >= 2` 永不触发 → STRONG_STEER 永不发出。**收敛引导在其依赖的"跑检查看绿灯"场景上整条失效**。

**实测**（§0.3）：
- cargo test 标准输出 `test result: ok. 3 passed; 0 failed; 0 ignored` → **false**（误杀）。
- node --test 自身输出（`ℹ pass 121`）→ true，即插件自身生态不受影响；受影响面是**任何通过输出里含 "failed" 零计数的生态**（cargo、部分 jest/vitest reporter 的汇总行、自定义脚本打印 "0 failed"）。
- build 族取反兜底：`Compiled successfully` → true，但一个什么都没打印的构建同样 true（148 行 `!t.includes("error ts")`）。
- `classifyCheck('grep -r tsc src')` → `family:'build'`（118 行 `c.includes("tsc ")` 子串误分类）。
- runtime 族 `/\b200\b/` 把 `returned 200 items` 判为通过（150 行）。

**修复方案**：
1. 计数优先解析：先提取 `/(\d+)\s+passed/` 与 `/(\d+)\s+failed/`，`failed===0 && passed>0` 才判过；无计数再退回关键词白名单。
2. 负向清单前置但排除零计数：`0 failed`、`no failures`、`0 errors` 显式加入"通过"模式，先于 `includes("failed")` 匹配。
3. build 族删除取反兜底，只认正向成功标志；无法判定时返回 null（不猜）。
4. `classifyCheck` 用命令前缀锚定（`^\s*(npm|pnpm|yarn|cargo|go|pytest|node)\b` 解析），不用裸子串；`/\b200\b/` 改为 `HTTP\/\d\.\d"?\s+200` / `"status"\s*:\s*"?200`。

### H2 guard.SHELL_LOOP 只比工具名（三条不同命令误判"死循环"）

**原文** `guard.js:71-74`：

```js
if (!text && names.length >= sameToolStreak) {
  const last = names.slice(-sameToolStreak);
  if (last.every((n) => n === last[0])) return { state: "SHELL_LOOP", ... };
}
```

`index.js:517` 传入的 `toolCalls` 只有工具名（`tools.map((t) => t?.name)`）。

**触发链**：连发 3 条不同 shell 命令（读文件 → 跑测试 → git status，均为 pwsh 工具）且当轮无正文 → names 全等 → SHELL_LOOP → `index.js:543` 回灌"你陷入循环了，立即输出完整交付物" → **正常排查被打断，且被记一条 guard trajectory**。

**同类**：`guard.js:77` finishReason=length 检查排在 SHELL_LOOP 之后（长度截断被误报循环）；`31-33` codeFenceCount 只数 ```` ``` ````（漏 `~~~`，4 反引号算两个）；`36-40` svgUnclosed 把自闭合 `<svg/>` 算未闭合。

**修复方案**：
1. 指纹 = 工具名 + command/args 摘要（`commandOf(exec.arguments)` 已有现成实现可复用），只有指纹全同才算循环。
2. 判定顺序：finishReason=length → TRUNCATED 优先于 SHELL_LOOP。
3. fence 正则统一 `/^\s*(`{3,}|~{3,})/m`；svg 正则排除 `/>` 自闭合。

### H3 用户原文逐字入库：无脱敏、无截断，且"纠正/指令"判定过宽

**原文**：

- `capture.js:131-135` `summary: \`User correction: ${text}\`` / `fix: text` / `trusted: true, weight: 1.0`；`capture.js:169` 注释明说 "Full text, deliberately untruncated"——**全文入库**。
- 全仓 grep `redact|sanitiz|mask|secret` **零命中**——没有任何脱敏。
- `policy.js:61` `return USER_CORRECTION_RE.test(c) || c.length >= 20;`——≥20 字的非寒暄消息一律算"纠正"。
- `policy.js:73` `return true;`——isUserInstruction 只拦 6 个寒暄词，其余全收。
- `index.js:726` correction 路径无 minChars 门槛（minChars=120 只作用于 turn 捕获路径）。

**实测**（§0.3 第 6/7 条）：中性陈述"今天下午我们继续把这个模块看完然后就开始休息吧"（22 字）→ 判为 correction；"明天记得把周报发给组长还有那个测试报告"（19 字）→ 不判。**阈值就是长度，与内容无关**。

**触发链与影响**：
1. **安全面**：用户消息含 token/密码/内网地址 → 逐字落盘 `index.json` + `lessons/*.md`，并经 `retrieve` 每轮注入 prompt——既是秘密泄漏也是注入面。importRecent（`index.js:890-901`）还会把最近 10 个 session 的最多 30 条用户消息在启动时灌入，同样无脱敏。
2. **记忆污染**：中性闲聊/进度陈述大量以 trusted L3 入库，稀释检索质量，且每轮注入占用 token 预算。

**修复方案**：
1. 入库前统一 `redact()`：`/(sk-[a-z0-9]{8,}|api[_-]?key\s*[:=]\s*\S+|Bearer\s+\S+|password\s*[:=]\s*\S+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+)/gi` → `[REDACTED]`，对 summary/fix/lesson/trajectory 同路径生效。
2. 截断上限：fix/lesson ≤ 500 字符（头 300 + 尾 200），超长记 `truncated:true`。
3. `isUserCorrection` 去掉裸长度 OR；补中文纠正词表（`不对|错了|不应该|应该是|别|不要|以后|请改|改成|why did you`），并要求至少一个纠正标记。
4. `isUserInstruction` 提高 minChars（≥10）并降权（weight ≤ 0.5，非 durable 一律 Q 层已有，保持）。

### H4 guard 每轮整篇回灌 REJECTED ANSWER（有上限、无截断）

**原文** `guard.js:114-127`：prompt 里 `String(rejectedAnswer ?? "")` 整篇拼入；`index.js:543` `followup(guardCorrectionPrompt(task, verdict.state, answer))` 传完整 answer。

**影响**：长交付物（>8k tokens）被拒时，每次重试都双倍灌入上下文；层内无截断。上限只存在于宿主层（`index.js:534-537` guardRetries<maxPerSession=4、attempt<maxRetries=2），故总剂量有界但单次剂量无界——本地 27B/Flash 上下文吃紧时可能把纠正轮本身撑爆。

**修复**：`guardCorrectionPrompt` 内对 rejectedAnswer 截断至 ~2000 字符（保留头尾，中间省略号），层内自带 maxChars 常量。

---

## 3. MEDIUM（正确性 / 性能 / 规模）

| # | 位置 | 问题 | 修复 |
|---|---|---|---|
| M1 | retrieve.js:50-51, 19-29, 57 | CJK 按单字切分 + 停用词仅英文 + estimateTokens≈4 chars/token（中文实际 ~1.5）→ 中文 query 靠单字噪声碰撞、token 预算系统性低估 2–3 倍（超量注入） | CJK bigram；补中文停用词；estimateTokens 按 CJK 占比折算（chars/2） |
| M2 | store.js:137 vs 198-201 | termindex.json 只写不读——ensureLayout 永远从 rows 重建（文件头注释 "loaded ONCE at open" 名不副实） | 启动时读 termindex 并校验（rows 数量一致才用），否则重建 |
| M3 | store.js:308-320 | hasDuplicate 全表扫 + 每行 `lessonTerms(r)` 重分词；每候选约重复分词 6 次 | 写时算一次 terms 缓存（Map<id, Set>）；倒排求交 |
| M4 | store.js:134, 218-242 | 无淘汰/压缩，rows 只增；每次 flush 全量 pretty-print 重写；guard 未解决时整篇 answer 也进 trajectory（index.js:551-556） | maxLessons + weight/LRU 淘汰；index 紧凑序列化或 jsonl append + 定期 compact；trajectory 截断 |
| M5 | scorers.js:9, 18-19 | TOOL_RE 匹配裸 `node`（`node script.js` 被当成测试）；`ok===undefined` 计为通过 → `definitive:true, passed:true` 假阳性 | 锚定完整前缀（`^node --test`）；ok 缺失 → definitive:false |
| M6 | capture.js:60 | failureText `/error\|fail\|exception\|.../i` 误捕正常回答（"error handling 已实现"也中） | 失败标志须在结尾/统计行，或与 `ok===false` 联合判定 |
| M7 | interrogate.js:89, 33 | 平票按插入序取第一个（不 fail-safe）；`/\[VERIFY:[^\]]*\]/` 遇 fix 内含 `]` 提前截断 | 平票 → UNCERTAIN；tag 解析改为非贪婪到行尾再 split |
| M8 | store.js:168-171 | flush() 假异步：setImmediate 后仍是同步全量写，大 store 阻塞事件循环 | 真异步（worker 或分片写），或至少拆行流式 |
| M9 | retrieve.js:131-137 | standing 规则不设上限可占满 topK；`x.s > 0` 无分数下限（噪声也进） | standing 最多 1 条 + 分数下限（如 s ≥ 0.15） |
| M10 | guard.js:18 | isFileTurn 每次 `new RegExp` 重编译 | 模块级缓存编译结果 |

---

## 4. LOW / 设计讨论

| # | 位置 | 问题 | 建议 |
|---|---|---|---|
| L1 | policy.js:105 | `toolResults.some(...)` 无 `(toolResults||[])` 保护（104 行有）。**活路径不可达**（index.js:276-279 保证返回数组），属防御性不一致；直接调用方（测试/未来代码）会 NPE | 补保护，与 104 行对齐 |
| L2 | signal.js:40-46 vs 50-52 | L3 userTap REFUTED → trusted:false（隔离）；L2 自评 REFUTED → trusted:true。同判"错"两种待遇，且 L3 注释自称 "authoritative"。**当前休眠**：userTap 无宿主来源（仅 index.js:806 透传 event.userTap，无 UI 写入） | 二选一：L3 REFUTED 也 trusted（用户否认是最强纠正信号），或把 userTap 从文档中的"权威信号"降级为实验特性 |
| L3 | dashboard.js:247 | host 可配 `0.0.0.0` 且无认证（默认 127.0.0.1 安全） | 非环回时强制 token 或拒绝启动 |
| L4 | webserver/index-inject | /rsi 无 CORS/token；同源 SOP 只挡读响应，任意网站可发请求（当前只读，风险低） | 加简单 token 查询参数校验 |
| L5 | policy.js:35-49 | projectFromText 漏正斜杠 Windows 路径（`C:/work/myproj`） | 正则兼容 `/` |
| L6 | scorers.js | mathScorer `Number("0x10")` 通过、1e-9 绝对容差；sqlScorer JSON.stringify 按位比较（键序/行序敏感） | 数值比较用解析后浮点 + 相对容差；SQL 结果按集合比较 |
| L7 | index.js:299 | migrateLegacyDir 在每次无显式 dir 启动时都 `existsSync(E:\DSH\.rsi-memory)`——对从无旧版的用户是多余 IO（可忽略） | 迁移完成后写标记文件跳过 |
| L8 | retrieve.js:57 | estimateTokens 4 chars/token 对英文代码也偏乐观（实际 ~3.3） | 统一按 3.5 折算 |

---

## 5. 测试缺口（121 全绿 ≠ 健康）

现有测试全部走在"happy path + 少量降级路径"，本报告缺陷 0 覆盖。**必须先补的回归测试**（先红后绿）：

| 测试名（建议） | 对应缺陷 | 断言 |
|---|---|---|
| `looksPassed: zero-count failure output is a PASS` | H1 | `looksPassed('3 passed; 0 failed','test')===true` |
| `looksPassed: silent build output is NOT a pass` | H1 | `looksPassed('Compiled successfully','build')===false`（按修复后语义） |
| `classifyCheck: only command prefixes classify` | H1 | `classifyCheck('grep -r tsc src')===null` |
| `outcomeSignal: tolerates missing toolResults` | L1 | `outcomeSignal({answerText:'x'})` 不抛 |
| `guard: different commands under one tool are not a loop` | H2 | 3 条不同 pwsh 命令 → state !== SHELL_LOOP |
| `guardCorrectionPrompt: rejected answer is truncated` | H4 | prompt 长度 ≤ 常量上限 |
| `capture: secrets are redacted before storage` | H3 | 含 `sk-...` 的 correction → lesson.fix 不含原文 |
| `isUserCorrection: neutral statements are not corrections` | H3 | 22 字中性句 → false |
| `store: truncated index.json recovers instead of disabling` | C1 | 损坏文件 → disabled===false 且旧数据保留在 .corrupt 文件 |
| `store: flush is atomic (no torn index.json)` | C1 | 并发 flush + 模拟崩溃 → index.json 始终可 parse |
| `retrieve: CJK query matches CJK lesson` | M1 | 中文 query 命中中文 lesson 且 token 估算误差 < 30% |
| `selfConsistencyVerdicts: tie -> UNCERTAIN` | M7 | ['REFUTED','CONFIRMED'] → UNCERTAIN |

---

## 6. 优化实施方案（按优先级，含验收标准）

### Phase 1 — 数据安全（必须最先做，1-2 天）
1. C1 原子写 + 损坏恢复（§1）
2. H3 redact + 截断 + 判定收窄（§2 H3）
3. 补 §5 中 C1/H3 两组回归测试
**验收**：`node --test test/*.test.js` 全绿且新增测试覆盖上述 12 条中的 5 条；手动制造损坏 index.json 后重启，dashboard 显示恢复提示而非"已停用"。

### Phase 2 — 核心功能正确性（2-3 天）
1. H1 looksPassed/classifyCheck 重写（计数优先 + 白名单）
2. H2 SHELL_LOOP 指纹化 + 判定顺序 + fence/svg 修复
3. H4 prompt 截断
4. 补 §5 中 H1/H2/H4 回归测试
**验收**：§0.3 复现 1-5 全部变成期望值；cargo test 零失败输出能触发 STRONG_STEER（可在测试里直接驱动 observeShell 断言）。

### Phase 3 — 性能与规模（3-5 天）
1. M1 CJK bigram + 停用词 + token 估算
2. M2/M3 termindex 真读取 + terms 缓存 + 去重走索引
3. M4 淘汰 + 紧凑写 + trajectory 截断
4. M5/M6/M7/M8/M9/M10
**验收**：造 5000 条 lesson 的 store，`hasDuplicate` 与 `search` 耗时 < 10ms；中文 query 检索命中率与英文持平（±10%）；flush 不再全量 pretty-print（index.json 增速对比）。

### Phase 4 — 体验与观测（1-2 天）
1. dashboard 展示 store 健康态（disabled/recovered/redacted 计数）
2. guard/convergence 触发原因可观测（lastReason 已有，补 state 直方图）
3. L3/L4/L5/L7 收尾
**验收**：`/rsi/status.json` 含 health 字段；非环回 host 启动被拒并给出明确错误。

---

## 7. 附：E 盘文件夹问题的代码级结论（用户原始任务 2）

- 现行默认目录已不在 E 盘：`index.js:81-84` `defaultDir()` = `DSH_HOME || os.homedir()` + `.dsh/rsi-memory`（本机即 `C:\Users\Administrator\.dsh\rsi-memory`）。
- 代码里唯一的硬编码盘符是 `index.js:89` 的迁移源 `E:\DSH\.rsi-memory`（≤0.1.11 旧版默认路径）。`migrateLegacyDir`（88-97 行）**只在旧目录存在且新目录不存在时拷贝，从不创建旧目录**。
- 本机实测：`E:\DSH\.rsi-memory` 存在（index.json 87KB + debug-session-events.jsonl 190KB，旧版遗留数据）；`C:\Users\Administrator\.dsh\rsi-memory` 不存在——说明桌面端自 0.1.14 安装后尚未重启，一次性迁移还没跑。
- **结论**：E 盘文件夹是旧版本（≤0.1.11）产生的遗留数据，不是现版本的行为。下次启动 v0.2.1 会自动把它拷贝到 C 盘新家；确认迁移完成后可手动删除 `E:\DSH\.rsi-memory`。若用户希望彻底抹掉这段历史，可在 v0.2.2 移除 `migrateLegacyDir` 的 E 盘默认值（改为仅认 `RSI_LEGACY_DIR` 环境变量）。

---

## 8. 一页结论

功能设计完整、工程底线（降级/兼容/测试数量）在线，但**存储层一个 CRITICAL（崩溃即永久静默失忆）+ 收敛判定一个 HIGH（零失败输出误杀，STRONG_STE 永不触发）+ 记忆入库一个 HIGH（逐字无脱敏且判定过宽）** 三个问题分别打在"数据持久性、核心功能、安全面"三个命门上。121 个全绿测试没有覆盖其中任何一个。建议按 Phase 1 → 4 顺序修复，每阶段以 §5 的回归测试为验收闸门。
