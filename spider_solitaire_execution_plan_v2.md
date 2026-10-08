# 离线蜘蛛纸牌项目执行计划书 V2.1

> 修订日期：2026-10-05

## 1. 执行目标

按“先核心正确性，再 Solver，再 Pilot Seed，再 UI，再扩大 Seed Library”的顺序推进。

避免在以下基础设施未稳定前投入大量 UI 精修：

```text
Rule Engine
Deterministic Generator
Solver
Validator
Seed Reproduction
```

### Seed Pool 规模原则

文中的 `200–500`、`900–1,200`、`1,000`、`5,000`、`10,000`、`31,000` 均为示例预设，不是产品常量。实际数量按 `Suit × Difficulty` 分桶配置；生成器、运行时、测试、构建与发布流程不得硬编码这些示例数字。

扫描量、认证目标和最终内嵌量必须分开：

```text
candidateScanBudget     最多扫描的候选 Seed 数（非节点、时间或成本预算）
certifiedTarget         希望获得的 Certified Seed 数
embeddedTarget          希望写入发行包的 Seed Pool 数量
rawCertifiedCount       Solver + Validator 初步通过的原始数量（Manifest 实际值）
actualCount             去重、撤销及版本过滤后唯一有效的 Certified dealId 数（Manifest 实际值）
embeddedCount           当前构建实际内嵌的数量
minimumPublishableCount 分桶可发布的最低数量
maximumEmbeddedCount    整个发行包允许内嵌的最大 Seed 数
maximumEmbeddedBytes    整个 Seed Library 允许内嵌的最大字节数
allowEmptyBucket        该分桶是否允许为空
```

### 唯一源配置与解析后 Manifest 契约

`SeedPoolConfig` 只保存目标、门槛和上限；扫描结果不得写回源配置。构建过程把它和实际认证结果解析为 `resolved-seed-manifest.json`。里程碑、回归测试、Runtime 和发布门槛必须读取解析后的 Manifest，不得各自维护数量表。

```json
{
  "configVersion": 1,
  "buckets": {
    "1s.easy": {
      "enabled": true,
      "candidateScanBudget": 100000,
      "certifiedTarget": 1000,
      "embeddedTarget": 800,
      "minimumPublishableCount": 500,
      "allowEmptyBucket": false
    }
  },
  "maximumEmbeddedCount": 50000,
  "maximumEmbeddedBytes": 8388608
}
```

解析后 Manifest 另行记录 `schemaVersion`、`seedLibraryVersion`、`parentLibraryVersion`、`minRuntimeVersion`、`maxRuntimeVersion`、规则/生成器/求解器/验证器/分类器版本、`configHash`、各分桶 `rawCertifiedCount`、`actualCount`、`embeddedCount`、`encodedBytes` 及总计。`actualCount` 固定定义为：去重并排除 disabled、superseded、分类无效、证书版本不匹配和版本不兼容条目后，唯一且有效的 Certified `dealId` 数。

静态配置与解析结果必须满足：

```text
0 <= minimumPublishableCount <= embeddedTarget <= certifiedTarget
embeddedCount <= min(actualCount, embeddedTarget)
sum(embeddedTarget for enabled buckets) <= maximumEmbeddedCount
sum(embeddedCount) <= maximumEmbeddedCount
totalEmbeddedCount == sum(bucket.embeddedCount)
totalEncodedBytes == sum(bucket.encodedBytes)
enabled == false => certifiedTarget == 0 AND embeddedTarget == 0 AND minimumPublishableCount == 0 AND embeddedCount == 0
```

统一发布谓词为：禁用桶不含条目；启用桶只有在 `allowEmptyBucket = true && embeddedCount = 0` 时可空发布，否则必须 `embeddedCount > 0 && embeddedCount >= minimumPublishableCount`。任一静态约束、发布谓词、总量/字节上限或总计等式失败时，构建必须失败，不能静默截断。

Manifest 还必须定义 Runtime Seed Payload 的关系：

```text
payloadSchemaVersion
payloadHash
payloadIndex[bucketId]: startOffset + entryCount
deals[]: dealId + canonicalSeed + initialDealHash + suitMode + difficulty + status
certificateCatalogHash
libraryHash
```

紧凑 payload 可嵌入单文件，但 offset、count、schema 和 hash 均由 Manifest 锁定。完整证书及逐局 `certificateHash` 只保留在开发侧证书目录和构建审计工件中。

### GitHub 技术候选矩阵

核验日期：2026-10-05。许可证与能力以对应仓库当日公开首页和许可证文件为准，后续采用前应重新核验。

| 项目 | 核验结论 | 本项目用途 | 边界 |
|---|---|---|---|
| [tomwillow/Credible-Spider](https://github.com/tomwillow/Credible-Spider) | 首页声明“保证每一把可解”，含多线程寻找可解牌局；披露约 1 花色 >90%、2 花色约 20%、4 花色无法有效求解；仓库根目录未见明确 LICENSE | 研究搜索、估值和多线程扫描思路 | 仅作思路研究；不得复制代码或牌局数据，除非后续取得明确授权 |
| [jsgrrchg/SolverLab](https://github.com/jsgrrchg/SolverLab) | Apache-2.0；支持 Spider 1/2/4 suits、确定性求解、批量模拟、replay、metrics、CSV；报告约 1 花色 95%、2 花色 60%，4 花色仍不可用 | 第一版 Seed Factory Solver 的主要技术实验候选 | 不能单独承担四花色大规模困难/恶魔池生产；采用前固定版本，并履行许可证、归属、修改说明及 NOTICE（若上游提供）要求 |
| [thecharlieblake/Solvitaire](https://github.com/thecharlieblake/Solvitaire) | GPL-2.0；具有随机牌局、求解和 benchmark 工具链 | 开发阶段 benchmark 与 Solver 对照组 | 默认不集成其代码进入产品、Runtime 或本项目 Solver；包括进程隔离在内的任何发布使用都需单独复核 GPL 义务 |
| [skeeto/solitaire](https://github.com/skeeto/solitaire) | Unlicense；非 Spider，但采用 native solver 预计算可解 Seed、compact bitmap pool、Web 端复现牌局 | 验证 Build-time Solver + Runtime Seed Pool 与紧凑编码架构 | 只迁移通用架构思想；其规则、Seed Pool 与牌局数据不能作为 Spider 认证来源 |
| [lklynet/spider-solitaire](https://github.com/lklynet/spider-solitaire) | MIT；含本地状态、Undo、Hint、自动 run detection；当前为随机牌局 | 前端状态、交互与本地持久化参考 | 不作为 Certified Seed 来源；复用代码时保留 MIT 声明并做规则一致性验证 |

### 里程碑依赖契约

| 里程碑 | 必须先满足 |
|---|---|
| M1 Rule Engine | M0 规则无未决项 |
| M2 Generator | M0；生成器规范完成；golden fixtures 通过后才冻结版本 |
| M3 UI Test Harness | M1、M2；只使用测试 Seed |
| M4 Solver | M1、M2、冻结的 Benchmark Manifest |
| M5 Validator | M0、M2；实现与 Solver 状态转移相互独立 |
| M6–M8 Seed / Difficulty | M4、M5；所有收录条目先通过认证 |
| M9 Runtime Selection | M6；稳定 `profileId` 与存储接口先可用，首期可只有 Guest profile |
| M11 Autosave | M1、M2、稳定 `profileId`、版本化存储接口与 M11A 能力探测 |
| M12 Local User System | M11 的 Guest profile 基础层；本阶段增加用户管理 UI 与隔离测试 |
| M16 Formal Alpha | M1–M15 对应的启用功能和内容门槛全部通过 |
| M17–M23 | 各阶段所需的前置 Manifest、证书、回归与容量报告通过后再扩容 |
| M24 Final Build | M20 UI 定稿、M23 全量 Seed Regression 和许可证清单通过 |
| M25 Final Artifact Test | M24；对最终 `index.html` 重新执行 M21 浏览器矩阵和离线测试 |

若依赖未满足，后续 Milestone 只能做隔离原型，不能宣称完成验收。

---

## 2. Milestone 0：规则与版本基线

### 目标

建立版本基线：

```text
Rule Version 1.0
Save Version 1
Seed Library Version 1
```

Generator Version 在本阶段只登记候选版本，不冻结；必须等 Milestone 2 的跨平台 golden fixtures 全部通过后才能冻结。

### 任务

- 明确 104 张牌结构
- 明确 10 列初始发牌
- 明确 5 轮库存牌
- 明确空列发牌限制
- 明确整体移动规则
- 明确自动翻牌
- 明确 K–A 自动收组
- 明确胜利条件

### 交付物

```text
rules.md
version-spec.md
```

### 验收

规则文档没有未决项。

---

## 3. Milestone 1：纯 Rule Engine

### 目标

实现完全独立于 UI 的 Spider Rule Engine。

### 核心对象

```text
Card
Column
Stock
CompletedSet
Move
GameState
```

### 核心函数

```text
createGame(seed, suitMode)
getLegalMoves(state)
applyMove(state, move)
dealStock(state)
autoFlip(state)
autoComplete(state)
undo(state)
isWin(state)
serialize(state)
deserialize(state)
```

### 自动测试

覆盖：

- 单牌移动
- 多牌整体移动
- 混花色禁止整体移动
- 空列
- 自动翻牌
- 自动收组
- 库存牌
- 8 组胜利
- 104 张牌守恒
- Undo 状态恢复

另外使用属性测试或模糊测试生成合法与非法动作序列，持续检查 104 张牌守恒、状态序列化往返、Undo 可逆性和非法动作不改变状态。覆盖率与 mutation score 的批准阈值写入测试配置，不能只以“已有测试全部通过”代替测试充分性。

### 验收门槛

```text
Rule Tests = 100% PASS
```

---

## 4. Milestone 2：Deterministic Generator

### 目标

建立跨平台稳定的：

```text
Seed → Deal
```

### 建议实现

```text
SplitMix64
+
xoshiro256**
+
Fisher-Yates
```

### 测试

同一组固定 Seed：

```text
Node.js
Chrome
Firefox
Safari
Edge
```

必须得到相同初始牌序。

Golden fixtures 必须冻结以下规范：

- Seed 的规范化字符串表示，禁止用 JavaScript `Number` 承载完整 64 位 Seed
- 初始牌组构造顺序与花色映射
- SplitMix64 / xoshiro256** 的 64 位溢出、掩码与字节序
- 无偏 Fisher–Yates 索引映射
- 初始 54 张牌与 5 轮 Stock 的遍历、发牌顺序
- 每个 fixture 的稳定 `dealId` 与牌面内容 `initialDealHash`

### 交付物

```text
generator.ts/js
generator-tests
known-seed-fixtures.json
```

### 验收

```text
Same Seed = Same Deal
```

Node.js、Chrome、Firefox、Safari、Edge 的 golden fixtures、`dealId` 与 `initialDealHash` 全部一致后，才冻结 `generatorVersion = 1`。任何改变牌局映射的修改必须提升 Generator Version。

`dealId` 是对规则/生成器/花色/规范 Seed 输入的稳定身份 hash；`initialDealHash` 是对初始 104 张牌序、face-up mask 与 Stock 边界的内容 hash。Golden fixture 必须分别比较两者，不得用一个术语代替另一个。

---

## 5. Milestone 3：基础 UI Test Harness

### 目标

在 Rule Engine 与已通过 golden fixtures 的 Generator 之上，建立供规则、复现和交互测试使用的最小 UI 壳。

### 功能

- 10 列显示
- Stock
- 点击移动
- Drag & Drop
- Auto Flip
- Auto Complete
- Undo
- Restart
- Win

### Seed

只使用 golden fixtures 与开发测试 Seed，不要求 Certified，也不构成 Alpha 发布内容。

### 交付物

```text
prototype.html
```

### 验收

1 花色标准牌局可以完整游玩。

本 Milestone 不启动正式 UI 精修。面向用户的 Alpha UI 必须等待 Solver、Independent Validator 与 Pilot Seed Pool 完成后再接入。

---

## 6. Milestone 4：Solver 候选技术实验

### 目标

以 SolverLab 为第一实验候选，Credible-Spider 仅研究思路，Solvitaire 作为外部 benchmark 对照。先做隔离的技术实验，再决定是否复用 Apache-2.0 代码或自行实现。

### 重点研究

- State Representation
- Move Ordering
- Search
- Hashing
- Transposition Table
- Pruning
- Solution Replay
- Batch Simulation
- Metrics

### 第一阶段 Solver 门槛

#### 1 Suit

```text
Solve Rate > 90%
```

#### 2 Suit

```text
Solve Rate > 50%
```

#### 4 Suit

```text
Not Blocking
```

这里只表示四花色求解率不阻塞 M4 技术实验。任何正式启用的四花色分桶仍必须达到其配置门槛，且每一局都必须通过独立 Validator；不得把“best effort”解释为可收录未认证牌局。

### 验收测试

每次 Solve Rate 报告必须绑定不可变 `benchmark-manifest.json`，至少固定：

```text
benchmarkId
ruleVersion
generatorVersion
solverVersion
solverConfigHash
suitMode
canonicalSeedRange / seedListHash
sampleSize
perDealTimeout
perDealNodeBudget
hardwareProfile
threadCount
memoryLimitBytes
stopReasonPolicy
```

所有 Solve Rate 必须在同一 Manifest 下比较，并同时输出成功数、超时数、资源耗尽数、未解数和置信区间。仓库 README 中的公开求解率只作为实验假设，不直接作为本项目验收证据。

### 资源与产能模型

Seed Factory 必须按分桶估算并实测：

```text
scanRate = candidates / machineHour
certificationYield = actualCount / scannedCandidates
certifiedRate = actualCount / machineHour
peakMemoryPerWorker
average / p95 / p99 solve time
replayValidationRate
estimatedMachineHours = remainingCertifiedTarget / certifiedRate
```

`candidateScanBudget` 的单位固定为候选 Seed 数。节点、时间和成本使用独立字段，例如 `perDealNodeBudget`、`perDealTimeoutMs`、`machineHourBudget`、`costBudget`。调度器同时读取这些字段、并发数和内存上限；四花色不得根据 1/2 花色的成功率外推产能。任一 Solver 都只是候选生产者，Manifest 必须记录每个 Certified Deal 的 Solver 与配置来源。

---

## 7. Milestone 5：Independent Validator

### 目标

Solver 与认证分离。

### Validator 功能

逐步重放 Solution：

```text
Initial State
↓
Move 1
↓
Move 2
↓
...
↓
Final Win
```

检查：

- 每步是否合法
- 自动翻牌是否正确
- Deal 是否正确
- Auto Complete 是否正确
- 卡牌是否守恒
- 是否重复
- 是否丢牌
- 最终是否 8 组完成

Validator 必须独立解析原始 Deal 与 Solution，不调用 Solver 的状态转移或“已求解”判定实现。

### 反向与 Mutation 测试

每类 Certified fixture 都应自动生成并确认拒绝：

- 删除、重复、交换或篡改单步 Move
- 非法多牌移动与跨花色整体移动
- 错误自动翻牌、错误 Auto Complete、空列违规 Deal
- 初始牌局重复牌、漏牌、牌面篡改、`dealId` 输入身份不匹配和 `initialDealHash` 内容不匹配
- 截断 Solution、伪造 Final Win、错误版本号或校验和
- 超出允许范围的序列化数值与未知操作类型

### Certified 条件

```text
Solver = SOLVED
AND
Validator = PASS
```

### 验收

所有 Solver 输出的 Certified 样本都必须能被 Validator 独立重放；所有 mutation corpus 必须被拒绝，且 Validator 输出稳定错误码与失败步骤。

---

## 8. Milestone 6：Pilot Seed Pool

### 目标

快速获得一批已验证可解牌局，不等待生产规模目标全部完成。

### Pilot 配置

Pilot 的扫描预算、认证目标和最低可发布数直接读取 `SeedPoolConfig`。以下只是一组可替换的示例预设：

| 模式 | 示例 certifiedTarget |
|---|---:|
| 1 Suit | 200–500 |
| 2 Suit | 100–300 |
| 4 Suit | 0–50 |
| 合计 | 300–850 |

第二批“扩至 900–1,200”同样只作历史示例。实际扩容由各分桶的 `actualCount / certifiedTarget` 和资源产能报告驱动。

### 获取策略

优先：

```text
SolverLab-style Batch Scan
```

流程：

```text
Seed Range
↓
Generate Deal
↓
Solve
↓
Solved?
↓
Validator Replay
↓
Certified
```

### 第三方 Seed

可作为：

- 测试样本
- Benchmark
- Rule Engine Regression

但正式加入 Seed Library 前必须转换成项目自己的 Seed / Deal 体系并重新验证。

---

## 9. Milestone 7：Easy Seed Pool V0

### 目标

优先做出“简单难度”开发池。

### 临时筛选条件

```text
Solved
AND
Solution Length relatively short
AND
Low Backtracking
AND
High Initial Legal Moves
```

### 目标

先建立：

```text
Easy Seed Pool V0
```

不等待完整 Difficulty Model。

### 验收

人工试玩抽样后，应明显属于低难度体验。

Easy Pool 的 `certifiedTarget` 与抽样量均来自配置；未达到完整 Difficulty Model 前，Manifest 必须标记 `classificationStatus = provisional`。

---

## 10. Milestone 8：Difficulty Analyzer

### 目标

建立统一难度分数。

### 指标

```text
solutionLength
initialLegalMoves
initialSafeMoves
hiddenCardDepth
sameSuitConnectivity
crossSuitFragmentation
emptyColumnDepth
temporaryBreakCount
branchingFactor
solverBacktracks
solverNodes
criticalMoveCount
recoveryOptions
```

### 输出

```text
Difficulty Score = 0–100
```

### 初步区间

- Easy：`[0, 25)`
- Medium：`[25, 55)`
- Hard：`[55, 80)`
- Demon：`[80, 100]`

区间只是初始默认值，必须按 1/2/4 花色分别校准，不得假设同一分数跨花色代表相同体感。

### 版本化校准

每条分类记录必须保存：

```text
solverVersion
solverConfigHash
classifierVersion
calibrationDatasetHash
suitMode
difficultyScore
difficultyBucket
```

分类器或校准集变化时提升 `classifierVersion`，重跑受影响分桶；不得静默覆盖旧分类。旧牌局可通过 tombstone 的 `classificationOverride` 追加修正。

### 人工校准

每档至少抽样：

```text
100 局
```

`100 局` 为示例抽样预设；实际样本量写入校准 Manifest，并报告每档、每花色的样本数和不确定性。检查真实玩家体验排序。

校准集必须与训练/调参数据分离。每个受测分桶至少由两名评测者盲测，并在校准 Manifest 中预先定义相邻等级容许误差、等级一致率门槛和分歧处理规则；未达门槛时保持 `classificationStatus = provisional`。

---

## 11. Milestone 9：Runtime Seed Selection

### 目标

实现正式新局逻辑。

### 流程

```text
All Seeds in Suit × Difficulty
-
Completed Seeds
=
Available Seeds
```

从中随机抽取。

Runtime 只读取 `resolved-seed-manifest.json` 中 `enabled = true` 且 `embeddedCount > 0` 的分桶，并用稳定 `dealId` 关联完成记录。

本 Milestone 开始前必须已有稳定 `profileId` 与存储接口；首期可以只实现 Guest profile。Completed 集合使用 `(profileId, dealId)` 作为身份键，M12 只在该基础上增加创建、切换、重命名和删除用户的界面与策略。

### RNG

使用：

```js
crypto.getRandomValues()
```

### 规则

- Completed Seed：不再正常随机出现
- Incomplete Seed：可以再次出现
- Restart：保持当前 Seed
- Disabled Bucket：UI 不可选择，并显示“当前版本未提供”
- Empty Bucket：仅当 `allowEmptyBucket = true` 时允许构建；Runtime 将其显示为“暂无牌局”并禁止开始
- Exhausted Bucket：全部完成后显示“本池已完成”，允许用户明确选择重玩，禁止静默回退到其他难度
- Disabled / Superseded Deal：不得进入随机池；已有完成记录仍可按 `dealId` 展示

### 验收

随机抽取测试次数由 Runtime 测试配置决定（例如 1,000 次）；不得选择 Completed、Disabled 或 Superseded Deal，并覆盖正常、空、耗尽和禁用分桶。

---

## 12. Milestone 10：Undo / Timer / Score

### Undo

- 连续 Undo
- 恢复 Tableau
- 恢复 Stock
- 恢复 Face-up
- 恢复 Completed Sets
- 恢复 Auto Flip
- 恢复 Auto Complete
- Undo 本身 +1 step

### Timer

状态：

```text
WAITING
RUNNING
PAUSED
FINISHED
```

规则：

- 打开页面不启动
- 首次成功 Move / Deal 启动
- 后台暂停
- Restart 清零
- Win 停止

### Score

```text
Score = Completed Set Reward - Scoring Moves
```

### 验收

自动测试覆盖所有状态转换。

---

## 13. Milestone 11：Autosave + IndexedDB

### Milestone 11A：`file://` 能力探测

单文件双击运行是正式约束，不能假设所有浏览器对 `file://` 使用稳定、可迁移的 IndexedDB origin。M11 开始前先在目标浏览器完成能力实验：

- `file://` 下能否创建、读写、升级和删除 IndexedDB
- 同一路径重开、移动文件、重命名文件、替换新版 HTML 后数据是否仍可访问
- Safari / Chrome / Firefox / Edge 的行为差异与隐私模式失败路径
- 存储被清理、配额不足、事务中断和 Schema Upgrade 失败
- Capability probe 失败时是否能明确提示并继续使用内存模式与 JSON 导入/导出

测试结果写入 `storage-capability-matrix.md`，并据此决定正式持久化策略。未经目标浏览器实测，不声明“移动单文件后数据自动延续”。

### 保存内容

```text
profileId
dealId
canonicalSeed
Suit
Difficulty
Board
Stock
Completed Sets
Undo History
Elapsed Time
Scoring Moves
Hint Count
Undo Count
Win State
Versions
```

### 触发

每次合法动作后 Autosave。

### 恢复

重新打开后：

```text
Continue Previous Game
New Game
```

Schema Upgrade 必须提供旧版本 fixture，验证升级成功、升级中断后的原子性和不可识别版本的 fail-closed 行为。

### 验收

在支持的 `file://` 浏览器路径下，关闭页面再打开状态完全一致；移动、重命名与版本升级行为必须符合能力矩阵。任何不可保证的数据连续性都通过启动提示与 JSON 备份恢复明确告知用户。

---

## 14. Milestone 12：Local User System

### 功能

- Create User
- Switch User
- Rename User
- Delete User
- Guest

### 隔离

不同用户独立：

- Completed Seeds
- Stats
- Save
- Preferences

### 验收

User A 通关 Seed 不影响 User B。

---

## 15. Milestone 13：Hint Engine

### 原则

Runtime 不使用完整 Solver。

### Heuristic Priority

1. 翻隐藏牌
2. 延长同花色
3. 完成 K–A
4. 创建空列
5. 减少异花色阻塞
6. 避免封死空列
7. 避免 Undo 循环

### 后续增强

如果 Demon Hint 不够好：

```text
Critical Checkpoints
```

而不是加入完整 Solution。

---

## 16. Milestone 14：Statistics

按：

```text
Suit × Difficulty
```

记录：

- Games Started
- Games Won
- Win Rate
- Highest Score
- Fastest Time
- Minimum Moves
- Average Score
- Average Time
- Completed Seed Count
- Undo Count
- Hint Count
- Recent Games

### 验收

自动构造测试记录验证统计结果。

---

## 17. Milestone 15：Import / Export

### 导出

```text
spider-backup.json
```

### 内容

- Users
- Stats
- Completed Seeds
- Save Games
- Preferences

Completed、Save、Stats 与 Game History 均使用 `(profileId, dealId)` 关联；`canonicalSeed` 只用于显示和按冻结生成器重建牌局。

### 导入

检查：

```text
Save Version
Rule Version
Generator Version
```

### 验收

导出后清空本地数据，再导入，应恢复完整状态。

---

## 18. Milestone 16：Feature Complete Alpha

### 前置依赖

正式 Alpha UI 只能在以下条件满足后进入：

```text
Rule Engine PASS
Generator Golden Fixtures PASS
Solver Baseline Measured
Independent Validator + Mutation Tests PASS
Pilot Seed Pool 达到各启用分桶的 minimumPublishableCount
```

其中 Seed Pool 条件使用统一发布谓词：禁用桶不参与；允许空且 `embeddedCount = 0` 的启用桶可通过；其他启用桶必须 `embeddedCount > 0 && embeddedCount >= minimumPublishableCount`。

### 功能范围

- 1 / 2 / 4 Suit UI
- Difficulty UI
- Seed display
- Undo
- Restart
- Hint
- Timer
- Score
- User
- Autosave
- Resume
- Stats
- Import / Export
- Settings

### Seed Pool

Alpha 目标读取 `resolved-seed-manifest.json`。历史示例“约 900–1,200 Certified Seeds”只可作为一个预设模板，不是 Alpha 常量。

四花色是否阻塞由该分桶的 `enabled`、`minimumPublishableCount` 与 `allowEmptyBucket` 决定；不得在代码中永久豁免四花色。

---

## 19. Milestone 17：Seed Factory Scale-Up

### 配置驱动的阶段目标

Scale-Up 阶段是 `SeedPoolConfig` 的命名快照。以下数字仅为示例预设，可替换、跳过或按花色与难度独立推进：

#### Stage A

```text
1,000 Certified Seeds
```

#### Stage B

```text
5,000
```

#### Stage C

```text
10,000
```

#### Stage D

```text
31,000
```

每个阶段都输出：

```text
Resolved Seed Manifest
Certificate Snapshot
Checksum
Metrics Summary
Capacity Report
```

每个阶段的完成条件为：禁用桶满足零内嵌约束；允许空的启用桶只有在 `embeddedTarget = 0 && embeddedCount = 0` 时可跳过产量目标；其他启用桶必须 `actualCount >= certifiedTarget`、`embeddedTarget > 0`、`embeddedCount == embeddedTarget`。总数量、实际字节数和总计等式同时满足配置约束；阶段名本身不得参与业务判断。

---

## 20. Milestone 18：正式 V1 Seed 配置

以下是历史示例预设，不是 V1 固定承诺：

| 难度 | 示例 certifiedTarget |
|---|---:|
| Easy | 1,000 |
| Medium | 10,000 |
| Hard | 10,000 |
| Demon | 10,000 |
| Total | 31,000 |

正式 V1 实际目标由批准的 `SeedPoolConfig` 按 `Suit × Difficulty` 决定。每个分桶独立声明 `enabled`、`minimumPublishableCount` 与 `allowEmptyBucket`。

如果四花色产能不足：

- 不阻塞前期 Alpha / Beta
- V1 是否启用全部 12 组合由发布配置明确决定，禁止构建时临时静默降级
- 但所有正式收录牌局必须 Certified

---

## 21. Milestone 19：Seed Library Versioning

### Version 1

```text
seedLibraryVersion = 1
```

### 更新规则

```text
Append Only
```

V1 使用“重新发布完整 `index.html`”更新 Seed Library，不导入未定义格式的外部 Seed Pack。未来若增加独立离线 Pack，必须先冻结 pack schema、完整性 hash 或签名、版本兼容、去重、tombstone 合并与原子回滚协议。

Manifest 必须携带：

```text
schemaVersion
seedLibraryVersion
parentLibraryVersion
minRuntimeVersion
maxRuntimeVersion
```

Runtime 只加载明确兼容的库；可迁移旧版本必须原子迁移并通过 fixture，未知新版本只允许导出或只读恢复，规则/生成器不兼容或完整性失败时拒绝载入且保留原数据。发布时签入兼容矩阵。

### 稳定身份

每局使用不可变身份：

```text
dealId = SHA-256(canonicalSerialize(ruleVersion, generatorVersion, suitMode, canonicalSeed))
```

`canonicalSerialize` 的字段顺序、UTF-8 编码和分隔规则与 M2 golden fixtures 一同冻结。`dealId` 必须在构建时检查全局唯一；Completed History、Save、Stats 与证书只通过 `dealId` 关联，显示用 Seed 不作为唯一键。

### Tombstone

Append Only 允许追加状态记录，但不覆写旧记录：

```text
disabled
disabledReason
supersededBy
classificationOverride
effectiveLibraryVersion
```

错误或过期牌局通过 tombstone 从 Runtime 随机池移除；历史完成记录继续可解释。`supersededBy` 必须指向存在且 Certified 的新 `dealId`，不得形成循环。

### 禁止

- 修改旧 Seed
- 复用旧 Seed ID 给新 Deal
- 更改 V1 Generator 导致旧 Seed 变化
- 删除旧记录来掩盖错误；必须追加 tombstone

### 验收

Library V2 加入后，V1 Completed Seeds 仍被 `dealId` 正确识别；disabled / superseded / classificationOverride 的升级 fixture 全部通过。

---

## 22. Milestone 20：UI Polish

### 内容

- Light
- Dark
- High Contrast
- Card Animation
- Victory Animation
- Sound
- Reduce Motion
- 1024×650 优化
- Retina
- Windows 125% / 150%

---

## 23. Milestone 21：Pre-build Cross-browser Test

测试：

```text
macOS Safari
macOS Chrome
macOS Firefox
Windows Edge
Windows Chrome
Windows Firefox
```

检查：

- Drag & Drop
- `file://` IndexedDB capability / schema upgrade / failure fallback
- Audio
- Animation
- Resume
- Seed Reproduction
- 空、耗尽、禁用分桶

本阶段用于在构建前清除平台问题，不替代 M24 之后对最终压缩、内嵌后的 `index.html` 做同矩阵复测。

---

## 24. Milestone 22：Stress Test

自动执行大量动作：

```text
100,000+ Engine Actions
```

检查：

- Card Loss
- Card Duplication
- Undo Corruption
- Save Corruption
- Memory Leak
- Invalid State

动作序列由合法状态生成器、非法动作变异器和历史回归 fixture 共同产生；每批动作持续断言牌守恒、状态哈希、Undo 往返和序列化往返。测试配置必须给出峰值内存、增长斜率、单动作 p95 延迟和允许失败数，超过任一阈值即失败。

---

## 25. Milestone 23：Seed Regression

对于正式 Seed Library：

```text
Generate
↓
Initial Hash Check
↓
Certificate Replay
↓
Final Win
```

必须全部通过。

回归数量必须从 `resolved-seed-manifest.json` 计算：

```text
expectedRegressionCount = sum(embeddedCount for every enabled bucket)
PASS 条件 = passedCount / expectedRegressionCount
```

例如某个已批准预设解析为 31,000 个内嵌 Deal，报告才可写 `31,000 / 31,000 PASS`。任何跳过、缺失、tombstone 状态不一致或证书版本不匹配都使回归失败。

---

## 26. Milestone 24：Final Build

Build：

```text
Source
+
Seed Library
+
SVG
+
Audio
+
CSS
+
JavaScript
↓
Bundle
↓
Minify
↓
Integrity Test
↓
index.html
```

### 配置与完整性门槛

- 内嵌 Seed 只来自批准的 `resolved-seed-manifest.json`
- 每个启用分桶满足 `embeddedCount <= min(actualCount, embeddedTarget)`
- 总内嵌数量不超过 `maximumEmbeddedCount`
- Seed Library 的总内嵌字节数不超过 `maximumEmbeddedBytes`
- `totalEmbeddedCount`、`totalEncodedBytes` 分别严格等于分桶求和；禁用桶的目标、最低量和实际内嵌数均为 0
- 每个启用分桶满足统一发布谓词，不能用 `minimumPublishableCount = 0` 绕过非空要求
- `dealId` 唯一，所有证书、checksum 和 tombstone 引用可解析
- Bundle 内的 Manifest checksum 与构建报告一致
- `THIRD_PARTY_LICENSES`、锁定 commit、许可证文本、NOTICE/归属要求及实际复制/修改文件清单完整；无许可证来源没有进入代码、资源或 Seed 数据

单局 `certificateHash` 只存在于开发侧证书目录和构建审计报告。Runtime 不携带完整 Solution Certificate，内嵌库完整性由 Manifest 的 `libraryHash` 校验。

### 大小与性能门槛

构建报告必须输出并与批准预算比较：

```text
totalBundleBytes
runtimeBytes
assetBytes
manifestBytes
seedPayloadBytes
encodedBytesPerSeed
parseTimeMs (p50 / p95)
startupTimeMs (p50 / p95)
peakMemoryBytes
selectionLatencyMs (p50 / p95)
```

预算值由发布配置按目标设备与浏览器设定。任一超过预算即构建失败；不得用“Seed 数尚未达到示例 31,000”代替实际体积和性能测量。

---

## 27. Milestone 25：Final Artifact Cross-browser + Offline Test

对 M24 产出的最终 `index.html` 重新执行 M21 的全部浏览器矩阵，并在每个声明支持的部署路径上做物理断网测试：

- New Game
- Undo
- Restart
- Hint
- Save
- Resume
- Stats
- Import
- Export
- Audio
- Animation

全部正常。

---

## 28. V1 发布门槛

### Rule Engine

```text
100% Rule Tests PASS
```

### Generator

```text
Same Seed = Same Deal
```

所有 M2 golden fixtures 跨目标浏览器通过，`generatorVersion` 已冻结。

### Solver

```text
1 Suit > 90%
2 Suit > 50%
4 Suit best effort
```

### Certified Seed

```text
Solver SOLVED
+
Validator PASS
```

独立 Validator 的 mutation / negative corpus 全部通过。

### Seed Pool 配置

```text
所有 enabled bucket：
embeddedCount <= min(actualCount, embeddedTarget)
sum(embeddedCount) <= maximumEmbeddedCount
totalEncodedBytes <= maximumEmbeddedBytes
(embeddedCount == 0 AND allowEmptyBucket)
OR (embeddedCount > 0 AND actualCount >= minimumPublishableCount AND embeddedCount >= minimumPublishableCount)
```

`10,000`、`31,000` 或其他示例数量不构成独立发布门槛；唯一数量依据是已批准并随构建签入的 `resolved-seed-manifest.json`。

### Runtime

```text
No Full Solver Required
```

### Offline

```text
Core Features Fully Functional Offline
```

### Save

在已声明支持的浏览器与 `file://` 路径下，刷新、关闭、重开及 Schema Upgrade 后状态正确恢复；能力不足时 fallback 与 JSON 恢复路径通过测试。

### Completed Seed

不再正常随机出现。

### Incomplete Seed

允许再次出现。

### Library Update

旧完成记录按稳定 `dealId` 保持有效，tombstone 与分类覆盖正确生效。

### Build

Bundle 完整性、大小、启动、解析、选局延迟和峰值内存均在发布配置预算内。

`THIRD_PARTY_LICENSES` 与来源锁定清单完整，最终 artifact 已通过 M25 浏览器矩阵与物理断网复测。

---

## 29. 优先级

### P0

- Rule Engine
- Rule Tests
- Deterministic Generator
- Solver Reference
- Validator

### P1

- Pilot Seed Pool
- UI Test Harness
- Formal Alpha UI
- Undo
- Timer
- Score
- Autosave

### P2

- User
- Statistics
- Hint
- Import / Export

### P3

- Animation
- Audio
- Themes
- Visual Polish

---

## 30. 推荐实际开发顺序

```text
01 Baseline Rules / Versions
02 Rule Engine
03 Rule Tests
04 Deterministic RNG
05 Golden Fixtures / Cross-browser Seed Reproduction
06 Freeze Generator Version
07 UI Test Harness
08 Solver Candidate Experiments + Benchmark Manifest
09 1-Suit Solver Baseline
10 2-Suit Solver Baseline
11 4-Suit Capacity Experiment
12 Independent Validator + Mutation Tests
13 Config-driven Pilot Seed Scan
14 Easy Seed Pool V0
15 Versioned Difficulty Calibration
16 Runtime Seed Selection
17 Formal Alpha UI
18 Undo / Timer / Score
19 file:// Storage Capability Test + IndexedDB
20 User System
21 Hint
22 Statistics
23 Import / Export
24 Feature Complete Alpha
25 Config-driven Seed Expansion
26 Full Regression from Resolved Manifest
27 Single HTML Build + Size / Performance Gates
28 Cross-browser / Offline Test
29 V1 Release
```

---

## 31. 近期第一阶段具体任务

建议立即执行：

### Task 1

建立 Rule Engine。

### Task 2

确定 PRNG + Shuffle，建立跨平台 golden fixtures；全部通过后再冻结 Generator V1。

### Task 3

以 SolverLab 为主要候选做隔离实验，同时建立固定 Benchmark Manifest；Credible-Spider 仅研究思路，Solvitaire 仅作对照。

### Task 4

跑固定 Seed Range：

```text
1 Suit
```

验证是否达到：

```text
>90%
```

### Task 5

跑：

```text
2 Suit
```

验证是否达到：

```text
>50%
```

### Task 6

按 Pilot `SeedPoolConfig` 生成第一批。以下数字只是示例预设：

```text
200–500 1S Certified Seeds
100–300 2S Certified Seeds
```

### Task 7

完成 Independent Validator mutation tests，并使 Pilot 的启用分桶达到 `minimumPublishableCount`。

### Task 8

将 Certified Pilot Pool 接入正式 Alpha UI；此前的 UI 仅作为测试壳。

### Task 9

确认：

```text
Seed
→ Deal
→ Restart
→ Resume
```

全部稳定一致。

完成以上任务后，项目即进入真正可扩展阶段。
