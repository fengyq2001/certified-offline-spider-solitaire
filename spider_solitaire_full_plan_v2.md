# 离线蜘蛛纸牌项目完整方案 V2.1

## 1. 项目定位

开发一款参考 Microsoft Solitaire 视觉体验、但不直接复制其商标、图标或受保护素材的离线蜘蛛纸牌游戏。

最终优先交付：

```text
index.html
```

用户可在 macOS 或 Windows 的现代浏览器中直接打开运行，不依赖服务器、不依赖远程数据库、不依赖联网 CDN，也不要求网络账号登录。

核心目标：

- 完全离线运行
- 标准 Spider Solitaire 规则
- Rule Engine 与 UI 架构支持单花色、双花色、四花色
- 每种花色可配置简单、中等、困难、恶魔四档难度
- 架构共支持 12 种游戏组合；具体发行版提供哪些组合以 Manifest 的启用分桶为准
- 正式 Seed 均经过开发阶段 Solver 求解和独立验证
- 最终用户版不内置完整 Solver
- 使用预认证 Seed 库提供牌局
- 已完整通关的 Seed 不再正常随机出现
- 未完成 Seed 可以再次出现
- 支持 Seed Library 后续扩充
- 所有用户记录仅保存在当前电脑
- 支持本地用户、统计、自动保存、提示、撤销、重试
- 最终优先打包为单个自包含 `index.html`

数量口径：

> 本文出现的 300、1,000、10,000、31,000、100,000 等 Seed 数量均为容量规划示例，不是写死的产品常量。实际 Seed Pool 按 `Suit × Difficulty` 分桶配置；生成器、构建脚本、Runtime、测试和发布门槛必须读取同一份 `SeedPoolConfig` 与构建后 Manifest。

---

## 2. 标准游戏规则

### 2.1 牌组

共 104 张牌，即两副扑克牌，不使用 Joker。

三种花色模式：

- 单花色
- 双花色
- 四花色

### 2.2 初始发牌

牌桌共 10 列。

初始发放 54 张：

- 前 4 列各 6 张
- 后 6 列各 5 张
- 每列仅最上方一张牌翻开

剩余 50 张进入库存牌区，共分 5 轮发放。

每次向 10 列各发一张。

默认规则：

> 发新一轮库存牌时，10 列均必须非空。

### 2.3 移动规则

任意花色均可按照点数降序衔接。

例如：

```text
9 → 8
K → Q
5 → 4
```

只有同花色、连续降序的牌组才允许整体移动。

例如：

```text
♠9
♠8
♠7
```

可以整体移动。

但：

```text
♠9
♥8
♠7
```

不能作为整体移动。

### 2.4 完成牌组

同一花色形成完整：

```text
K Q J 10 9 8 7 6 5 4 3 2 A
```

后自动收走。

总共完成 8 组即获胜。

---

## 3. 操作方式

首版支持：

- 鼠标拖放
- 点击选择
- 点击目标列移动
- 双击智能移动
- 触控板
- 键盘快捷键

不依赖右键。

建议快捷键：

- `Ctrl/Cmd + Z`：撤销
- `H`：提示
- `R`：重试当前牌局，需要确认
- `N`：新一局，需要确认
- `Space`：发下一轮牌
- `Esc`：取消当前选择

---

## 4. 难度体系

总共：

```text
3 种花色 × 4 档难度 = 12 种组合
```

| 花色 | 简单 | 中等 | 困难 | 恶魔 |
|---|---|---|---|---|
| 单花色 | ✓ | ✓ | ✓ | ✓ |
| 双花色 | ✓ | ✓ | ✓ | ✓ |
| 四花色 | ✓ | ✓ | ✓ | ✓ |

该表表示规则与界面能力矩阵。某一发行版是否实际提供全部 12 个分桶，由其解析后 Manifest 决定；未启用或空分桶不能显示为已有可玩内容。

难度不通过制造死局实现。

正式进入 Seed Library 的牌局必须是已验证可解牌局。

主要难度指标：

- 求解步数
- 初始合法移动数
- 初始安全移动数
- 隐藏牌解锁深度
- 同花色连续结构
- 异花色交错程度
- 空列获得难度
- 临时拆开同花色序列次数
- Solver 搜索分支
- Solver 回退深度
- Solution Length
- Solver Nodes
- 关键动作数量
- 对空列依赖程度

---

## 5. Solver 能力目标

前期参考 SolverLab 的求解思路和工程设计。

第一阶段 Solver 通过条件调整为：

### 单花色

固定时间 / 节点预算下：

```text
求解率 > 90%
```

目标区间：

```text
90%–95%+
```

### 双花色

固定时间 / 节点预算下：

```text
求解率 > 50%
```

目标区间：

```text
50%–65%+
```

### 四花色

首版前期：

```text
不作为阶段通过硬条件
```

要求调整为：

- 尽量支持
- 能稳定产出一定数量的 Certified Seeds 即可
- 在批准配置将相关分桶设为 `enabled = false`，或显式设为允许空且 `embeddedTarget = 0` 时，不阻塞 Alpha / Beta
- 一旦发行配置要求非空四花色分桶，该分桶必须满足与其他分桶相同的认证和发布门槛
- 后续继续优化 Solver

以上求解率只在本项目冻结的 Benchmark Manifest 上判定。报告必须同时记录样本量、牌局来源、rule/generator/solver 版本、Solver 配置哈希、单局时间与节点预算、并行度、硬件、Timeout 计法和置信区间；外部仓库 README 的数字不能代替该报告。

---

## 6. 外部项目参考与使用边界

来源核验日期：`2026-10-05`。下表中的求解率是各仓库 README 的作者声明，测试牌局、硬件、预算和版本并不统一，因此只能用于技术选型，不能作为本项目 Solver 达标或 Seed 认证的 benchmark 证据。

| 项目 | 已核对信息 | 本项目用途 | 边界 |
|---|---|---|---|
| [tomwillow/Credible-Spider](https://github.com/tomwillow/Credible-Spider) | 目标是保证每把牌局可解；支持多线程寻找可解牌局；README 报告单花色 `>90%`、双花色约 `20%`，四花色当时无法解出 | 研究状态表示、搜索、多线程 Seed 筛选思路 | 仓库首页未显示明确 LICENSE 文件；只研究思想，不复制代码、资源或牌局数据 |
| [jsgrrchg/SolverLab](https://github.com/jsgrrchg/SolverLab) | Apache-2.0；支持 Spider 1/2/4 suits、确定性求解、可配置并行批量模拟、solution replay、metrics 和 CSV；README 报告单花色约 `95%`、双花色约 `60%`，四花色仍“not usable yet” | 第一版 Seed Factory Solver 候选之一，优先做适配和基准实验 | 不单独承担四花色大规模困难/恶魔牌局生产；使用代码时履行 Apache-2.0 的许可证、归属、修改说明及 NOTICE（若上游提供）要求 |
| [thecharlieblake/Solvitaire](https://github.com/thecharlieblake/Solvitaire) | GPL-2.0；具备随机 seed、deal、solver、solvability/benchmark 工具链 | 开发阶段 benchmark 与 differential testing 对照组 | 默认不集成其代码进入产品、Runtime 或本项目 Solver；进程隔离也需在发布前完成许可证复核 |
| [skeeto/solitaire](https://github.com/skeeto/solitaire) | Unlicense；不是 Spider；采用 native solver 预计算可解 seeds、compact bitmap、Web Runtime，并用 SplitMix64、xoshiro256**、整数 Fisher–Yates 保证跨平台精确复现 | 验证“Build-time Solver + Compact Pool + Runtime”架构和压缩方向 | 只迁移通用架构经验；其规则、Seed Pool 与牌局数据不能作为 Spider 认证来源 |
| [lklynet/spider-solitaire](https://github.com/lklynet/spider-solitaire) | MIT；包含浏览器本地状态、Undo、Hint、自动 run detection；README 明确使用 random boards | UI、交互与本地状态结构参考 | 不是 Certified Seed Library 或可解性证明来源；复用代码时保留 MIT 许可证与归属 |

SolverLab 可优先用于实验以下能力：

- Spider 状态表示
- Move Ordering、State Hash 与 Transposition Table
- Dead-State Pruning 与 Branch Search
- Replayable Solution
- Batch Simulation、Metrics 与 CSV

正式项目仍必须拥有并冻结自己的 Rule Engine、Seed Namespace、Deterministic Generator、Independent Validator、Difficulty Analyzer 和 Seed Library Versioning。任何外部 Solver 的输出都必须通过本项目 Validator 重放，才能进入 Certified Seed Library。

---

## 7. Seed 核心架构

正式游戏不采用“随机洗牌后实时求解”。

使用：

```text
Build-time Solver
+
Certified Seed Library
+
Runtime Lightweight Game Engine
```

开发阶段：

```text
Random Seed
↓
Deterministic Generator
↓
Spider Deal
↓
Solver
↓
Solution Found
↓
Independent Validator Replay
↓
Difficulty Metrics
↓
Classification
↓
Certified Seed Library
```

最终用户电脑：

```text
Certified Seed
↓
Generate Deal
↓
Play
```

不运行完整 Solver。

---

## 8. 前期 Pilot Seed Pool

前期不等待正式池目标全部生成后才做游戏。Pilot 数量也由配置决定。

以下仅是开发用 Pilot Pool 示例预设：

建议第一批：

| 模式 | 数量 |
|---|---:|
| 1 Suit | 200–500 |
| 2 Suit | 100–300 |
| 4 Suit | 0–50，尽量 |
| 合计 | 约 300–850 |

之后扩充到：

```text
约 900–1,200
```

用于完整 Alpha 功能测试。

如果团队把 Pilot 目标改为其他数量，里程碑、测试样本和 UI 不需要修改代码，只需要更换配置并生成新的 Manifest。

---

## 9. 可复用 Seed 原则

前期可以使用第三方已知可解 deal / seed 作为开发样本，但不能只复制 seed 数字。

必须同时确认：

```text
Seed
PRNG
Shuffle Algorithm
Deck Ordering
Suit Mapping
Initial Deal Order
Rule Variant
```

原因：

同一个 seed 数字如果 PRNG 或 Shuffle 不同，会生成完全不同的牌局。

因此第三方 Seed 的定位是：

```text
External Test Sample
```

而不是直接成为正式项目 Seed Namespace。

---

## 10. 前期 Seed 获取策略

按优先级：

### 方式 1：SolverLab 批量生成并筛选

首选。

流程：

```text
Seed Range
↓
Generate Deal
↓
SolverLab
↓
Solved?
↓
Yes → Save
No → Skip
```

优点：

- 规则可控
- 可直接拿到 Solution
- 可获取 Nodes / Time / Length 等难度指标
- 最适合建立 Pilot Pool

### 方式 2：第三方可解牌局

可用于：

- Rule Engine 测试
- Solver Benchmark
- Difficulty Calibration

但必须重新映射并验证。

### 方式 3：其他 Solver 交叉样本

例如 Solvitaire 等项目可以作为 Benchmark 或辅助验证。

---

## 11. Seed Pool 配置、Manifest 与数量语义

每个 `Suit × Difficulty` 分桶独立配置，不要求等量。必须区分：

- `candidateScanBudget`：本次构建最多扫描的候选 Seed 数；它是计算预算，不是产量承诺。
- `certifiedTarget`：希望得到的已认证 Seed 目标数；达到后可提前停止扫描。
- `embeddedTarget`：希望写入发行包的 Seed Pool 数量；这是用户可自定义的最终池目标。
- `rawCertifiedCount`：Solver 与 Validator 初步通过的原始数量，用于产能统计。
- `actualCount`：去重并排除 disabled、superseded、分类无效、证书版本不匹配和版本不兼容条目后，唯一且有效的 Certified `dealId` 数；只出现在解析后 Manifest，不写回源配置。
- `embeddedCount`：构建后实际写入发行包的有效 Seed 数；只出现在解析后 Manifest，由去重、撤销、目标数、体积上限和发布策略共同决定。

建议配置结构：

```json
{
  "configVersion": 1,
  "buckets": {
    "1s.easy": {
      "enabled": true,
      "candidateScanBudget": 200000,
      "certifiedTarget": 1000,
      "embeddedTarget": 800,
      "minimumPublishableCount": 300,
      "allowEmptyBucket": false
    }
  },
  "maximumEmbeddedCount": 50000,
  "maximumEmbeddedBytes": 8388608
}
```

上例中的数字只是示例。约束为：

```text
0 <= minimumPublishableCount <= embeddedTarget <= certifiedTarget
0 <= embeddedCount <= min(actualCount, embeddedTarget)
sum(embeddedTarget for enabled buckets) <= maximumEmbeddedCount
sum(embeddedCount) <= maximumEmbeddedCount
totalEncodedBytes <= maximumEmbeddedBytes
enabled == false => certifiedTarget == 0 AND embeddedTarget == 0 AND minimumPublishableCount == 0 AND embeddedCount == 0
totalEmbeddedCount == sum(bucket.embeddedCount)
totalEncodedBytes == sum(bucket.encodedBytes)
```

统一发布谓词为：`enabled = false` 时不得内嵌条目；`enabled = true` 时，只有 `allowEmptyBucket = true && embeddedCount = 0` 可作为空桶发布，否则必须 `embeddedCount > 0 && embeddedCount >= minimumPublishableCount`。`enabled = false` 表示本版本不提供该组合，不得与“已完成全部牌局”混淆。

规则引擎可以支持全部 12 种组合，但只有 Manifest 中启用的分桶属于该发行版的可玩内容。若发行说明宣称“提供 12 种组合”，12 个分桶都必须启用并分别满足发布门槛。

每次构建生成不可手改的 `resolved-seed-manifest.json`，至少包含：

```text
schemaVersion
seedLibraryVersion
parentLibraryVersion
minRuntimeVersion
maxRuntimeVersion
configVersion
configHash
ruleVersion
generatorVersion
solverVersion
solverConfigHash
validatorVersion
classifierVersion
createdAt
buckets[suitMode][difficulty]:
  enabled
  allowEmptyBucket
  candidateScanBudget
  candidatesScanned
  certifiedTarget
  rawCertifiedCount
  actualCount
  embeddedTarget
  minimumPublishableCount
  embeddedCount
  encodedBytes
maximumEmbeddedCount
maximumEmbeddedBytes
totalEmbeddedCount
totalEncodedBytes
libraryHash
payloadSchemaVersion
payloadHash
payloadIndex:
  bucketId
  startOffset
  entryCount
deals[]:
  dealId
  canonicalSeed
  initialDealHash
  suitMode
  difficulty
  status
certificateCatalogHash
```

`deals[]` 是 Runtime 所需的逐局索引；紧凑二进制或文本 payload 可以与索引分区存放，但其 schema、offset、count 与 hash 必须由 Manifest 锁定。开发侧证书目录由 `certificateCatalogHash` 锁定，逐局证书映射保留在构建审计工件中。构建必须在目标总和或实际总和超出任一全局上限、总计与分桶求和不一致、禁用桶仍含条目时失败，不能静默截断。

---

## 12. Seed 数量示例预设

团队可以提供命名预设方便估算，但预设不是产品协议。例如一个“大型 V1”预设可按难度给出：

| 难度 | `certifiedTarget` 示例 |
|---|---:|
| 简单 | 1,000 |
| 中等 | 10,000 |
| 困难 | 10,000 |
| 恶魔 | 10,000 |
| 合计 | 31,000 |

每个难度再按单、双、四花色拆成独立分桶。表中数值可同时用作 `certifiedTarget` 与 `embeddedTarget`，也可分别配置；分配可以均衡，也可以因四花色求解成本而不同。最终事实只以 Manifest 中各分桶的 `embeddedCount` 为准。更换预设或手工配置不得改变 Seed 身份和已完成记录。

---

## 13. Seed 唯一性

每个牌局保存：

```text
dealId
canonicalSeed
initialDealHash
seedLibraryVersion
suitMode
difficulty
ruleVersion
generatorVersion
solverVersion
solverConfigHash
validatorVersion
classifierVersion
certificateHash
```

`certificateHash` 只用于开发环境的证书目录、审计和全量回归。发行版 Runtime 不包含完整 Solution Certificate，也不声称能用单条 hash 在客户端证明可解；Runtime 对内嵌 Seed Library 的完整性检查使用 Manifest 的 `libraryHash`。

`canonicalSeed` 使用明确命名空间的规范字符串，例如固定为：

```text
u64:0123456789abcdef
```

即 `u64:` 加 16 位小写十六进制，不允许把 64-bit Seed 写成 JavaScript `Number` 或无类型 JSON 数字。Runtime 使用 `BigInt` 或两个 `uint32` 解析。

稳定身份：

```text
dealId = SHA-256(
  canonicalSerialize(ruleVersion, generatorVersion, suitMode, canonicalSeed)
)
```

`canonicalSerialize` 的字段顺序、UTF-8 编码和分隔规则必须冻结并由 golden fixtures 覆盖。`difficulty`、Solver 版本、Classifier 版本和 Seed Library 版本不参与 `dealId`，因此重新分类或重新打包不会破坏用户的 Completed History。

`initialDealHash = SHA-256(canonicalSerialize(initial 104-card order, initial face-up mask, stock boundaries))`，用于跨实现牌面一致性检查和发现不同 Seed 生成相同初始牌局。`dealId` 是稳定用户身份，`initialDealHash` 是牌面内容 hash，两者不得混用；跨 Seed 的重复牌面在构建时按发布策略去重并记录原因。

要求：

```text
Same Seed
+
Same Suit Mode
+
Same Rule Version
+
Same Generator Version
=
Same Initial Deal
```

跨浏览器、跨操作系统必须一致。

---

## 14. Deterministic Generator

禁止使用 `Math.random()` 决定牌局。

建议：

- SplitMix64 作为 Seed Expansion
- xoshiro256** 或同等级确定性 PRNG
- Fisher-Yates Shuffle

V1 生成规范必须同时冻结：

- 104 张牌的初始牌组构造顺序和重复副本编号
- suit mode 到实体花色的映射
- `canonicalSeed` 的解析、字节序和非法输入处理
- SplitMix64、xoshiro256** 的每一步 64-bit 无符号溢出语义
- Fisher–Yates 的遍历方向，以及用 rejection sampling 做无偏索引映射
- 洗牌结果到 10 列 Tableau、Stock 五轮的遍历和发牌顺序
- 初始 face-up 状态、自动翻牌和完成组处理的触发顺序

每个版本保留跨语言、跨浏览器 golden fixtures：输入规范 Seed，比较完整 104 张洗牌序列、初始牌桌、Stock、`dealId` 和 `initialDealHash` 的逐字节结果。

一旦 V1 发布：

```text
Generator Version 1
```

必须永久冻结。

未来算法改变必须升级：

```text
Generator Version 2
```

---

## 15. Seed 抽取规则

用户点击“新一局”：

```text
当前 Suit + Difficulty 全部 Seed
-
当前用户 Completed Seed
=
Candidate Seed Pool
```

从 Candidate Pool 随机抽取。

推荐：

```js
crypto.getRandomValues()
```

用于运行时选局。

Runtime 只读取当前 Manifest 中 `enabled = true` 且有效、未撤销的条目。为避免大池每次做全量集合差，按分桶建立索引与 Completed bitset；随机索引同样采用 rejection sampling，避免取模偏差。可增加近期牌局回避或 shuffle-bag，减少未完成牌局短期重复。

分桶状态必须明确显示：

- `enabled = false`：本版本未提供。
- `enabled = true, embeddedCount = 0, allowEmptyBucket = true`：当前认证池为空。
- 存在未完成条目：正常抽取。
- 所有有效条目均完成：显示“已完成当前池全部认证牌局”。

---

## 16. 已完成 Seed 规则

确认采用：

> 未完成的局仍然可能再次出现；已完整通关的局不再正常随机出现。

例如：

```text
Seed #1058
```

未完成：

```text
仍可能再次抽到
```

已完成：

```text
以后不再正常随机抽到
```

重试始终使用当前 Seed。

---

## 17. Seed Library 后续更新

必须支持版本化：

```text
Seed Library V1
Seed Library V2
Seed Library V3
```

正常条目原则：

```text
Append Only
```

旧牌局：

- `dealId` 不改变
- Seed 不改变
- Rule Version 不改变
- Generator Version 不改变

用户升级 Seed Library 后：

```text
Completed Seed History 继续有效
```

V1 默认更新方式是发布新的完整 `index.html`，不把未定义格式的外部 Seed Pack 直接合并进 Runtime。独立离线 Seed Pack 若以后启用，必须先另行冻结 pack schema、签名或 hash、版本兼容、去重、tombstone 合并和失败回滚规则。

Manifest 必须记录 `schemaVersion`、`minRuntimeVersion`、`maxRuntimeVersion` 与 `parentLibraryVersion`。Runtime 只加载明确落入支持区间的库：可无损迁移的旧版本先原子迁移，较新但未知的版本只允许导出或只读恢复，规则/生成器不兼容或完整性校验失败时拒绝载入并保留原数据。兼容矩阵和迁移 fixture 属于发布工件。

若发现错误认证、重复条目或规则安全问题，不删除历史记录，而是追加 tombstone：

```text
dealId
status: disabled | superseded
reasonCode
disabledAt
supersededBy: dealId | null
```

Runtime 不再随机抽取 `disabled` 或 `superseded` 条目；历史记录仍按原 `dealId` 可解释。`supersededBy` 仅建立迁移关系，不能把旧牌局的完成状态自动计入不同牌面的新 `dealId`。

---

## 18. Seed 耗尽

如果某用户完成某一 Suit × Difficulty 下全部 Seed：

显示：

```text
你已经完成当前模式的全部认证牌局。
```

提供：

- 重新开放已完成牌局
- 重置该分类 Completed 记录
- 如果存在新版 Seed Library，则加入新增 Seed

---

## 19. Solver 与 Validator

完整 Solver 只存在于开发环境。

Solver 输出至少包括：

```text
Solved / Unsolved / Timeout
Solution Moves
Solution Length
Nodes Expanded
Max Depth
Backtracks
Elapsed Time
Metrics
```

独立 Validator 不进行搜索，只负责：

```text
Initial State
+
Solution Certificate
↓
Replay Every Move
↓
Final Win
```

“独立”表示 Validator 不调用 Solver 的状态转移或胜负判断实现；它可以共享序列化协议，但必须独立检查牌总数、重复/漏牌、每步合法性、翻牌、发牌、自动收组和终局条件。测试集必须包含被篡改证书、非法移动、重复牌、漏牌、错误翻牌和伪造终局等反例。

正式 Certified 条件：

```text
Solver = SOLVED
AND
Validator = PASS
```

---

## 20. Difficulty Analyzer

每局至少计算：

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

再输出：

```text
Difficulty Score: 0–100
```

每个认证条目必须记录：

```text
solverVersion
solverConfigHash
classifierVersion
difficultyScore
classifiedDifficulty
```

单、双、四花色应分别校准，避免同一分数掩盖模式差异。初步区间采用不重叠的半开区间：

- Easy：`[0, 25)`
- Medium：`[25, 55)`
- Hard：`[55, 80)`
- Demon：`[80, 100]`

正式阈值必须通过冻结数据集、固定 Solver 预算、统计分析和人工试玩校准。Solver、配置或分类器升级后必须生成对比报告；允许用 tombstone/override 重新分类，但不能改写原认证记录或 `dealId`。

人工校准使用与训练/调参数据分离的验证集。每个受测分桶至少由两名评测者盲测，记录评测者数量、样本量、相邻等级容许误差、等级一致率和分歧处理规则；未达到预先批准的一致率门槛时，不得将临时阈值标记为正式分类器。

---

## 21. 简单难度快速建立策略

前期 Easy 不必等完整 Difficulty Analyzer 成熟。

可先定义：

```text
Solved
AND
Short Solution
AND
Low Backtracking
AND
High Initial Legal Moves
```

从单花色 / 双花色已解牌局中筛选相对容易的一批，形成：

```text
Easy Seed Pool V0
```

用于前端开发。

---

## 22. 提示系统

最终用户版不运行完整 Solver。

Hint 使用轻量 heuristic。

优先级：

1. 翻开隐藏牌
2. 延长同花色序列
3. 完成或接近 K–A
4. 创建空列
5. 把异花色连接转成同花色
6. 减少阻塞
7. 避免封死空列
8. 避免刚撤销动作造成循环

必要时后续可以为 Demon 牌局存少量：

```text
Critical Checkpoints
```

但不存完整 Solution Path。

---

## 23. 计分方案

采用：

```text
Score
=
Completed Set Rewards
-
Scoring Moves
```

奖励表：

| 难度 | 单花色 | 双花色 | 四花色 |
|---|---:|---:|---:|
| 简单 | 100 | 200 | 400 |
| 中等 | 150 | 300 | 600 |
| 困难 | 200 | 400 | 800 |
| 恶魔 | 300 | 600 | 1200 |

计步规则：

- 成功移动：+1
- 发一轮牌：+1
- Undo：额外 +1，原步数不退
- Redo（未来）：+1
- Hint：不计步
- 自动翻牌：不计步
- 自动收组：不计步
- 无效拖放：不计步

---

## 24. 计时规则

状态：

```text
WAITING
RUNNING
PAUSED
FINISHED
```

规则：

- 打开页面不开始
- 第一次成功 Move / Deal 后开始
- Hint 不开始
- 选择牌不开始
- 页面进入后台暂停
- 返回前台继续
- Restart 清零
- Win 立即停止
- 内部保存毫秒
- UI 显示秒

---

## 25. Undo

必须支持连续 Undo。

Undo 需要精确恢复：

- Tableau
- Stock
- Face-up
- Auto Flip
- Completed Sets
- Auto Complete
- 当前牌桌状态

Undo 自身计入一步。

---

## 26. 本地用户系统

属于本机免密档案，不是安全账号。

功能：

- 创建用户
- 切换用户
- 重命名
- 删除用户
- Guest 模式
- 本地排行榜
- JSON 导入 / 导出

所有数据只保存在当前电脑。

---

## 27. 本地存储

主要使用：

```text
IndexedDB
```

保存：

- Users
- Current Games
- Completed Seeds
- Statistics
- Game History
- Settings
- Seed Library State

`localStorage` 只保存少量 UI 设置。

### `file://` 能力与升级测试门槛

“双击单个 `index.html`”必须作为真实部署形态验证，不能仅在开发服务器上推断。进入 Alpha 前建立 Safari、Chrome、Edge、Firefox 的能力探测与实机矩阵，至少覆盖：

- `file://` 直接打开时 IndexedDB 能否创建、读写、关闭后重开并持久化
- 文件重命名、移动目录、替换升级版 `index.html` 后数据是否仍可访问
- 浏览器版本升级、隐私模式、配额不足和存储被清理时的行为
- IndexedDB schema migration 的成功、失败回滚和旧存档恢复
- JSON 导出后在新路径或新浏览器导入恢复

应用启动时先执行 Storage Capability Probe。若 IndexedDB 不可用或不可持久化，应明确提示并允许继续临时游玩，同时突出 JSON 导出；不得显示“已安全保存”。单文件发布门槛是目标浏览器矩阵通过，若个别浏览器无法满足，则为该浏览器提供本地静态服务器/PWA 发行方式并在支持矩阵中说明。

---

## 28. 自动保存

每次合法动作后自动保存。

至少保存：

```text
Rule Version
Generator Version
Seed Library Version
Save Version
User ID
Deal ID
Canonical Seed
Suit Mode
Difficulty
Current Board
Stock
Completed Sets
Move History
Undo History
Elapsed Game Time
Scoring Moves
Hint Count
Undo Count
Win State
```

---

## 29. 数据导入导出

支持：

```text
spider-backup.json
```

导出：

- 用户
- 统计
- Completed Seeds
- 当前存档
- 偏好设置

导入时校验版本。

---

## 30. 用户统计

按：

```text
Suit × Difficulty
```

分别统计：

- 已开始局数
- 通关局数
- 胜率
- 累计得分
- 最高得分
- 最快时间
- 最少步数
- 平均完成时间
- 平均得分
- Undo 次数
- Hint 次数
- 已完成 Seed 数
- 剩余 Seed 数
- 最近牌局

---

## 31. UI 设计

整体：

- 现代
- 简洁
- 类似 Microsoft Solitaire 的桌面体验
- 不直接复制 Microsoft 素材

布局：

### 顶栏

- 用户
- 花色
- 难度
- Seed
- 时间
- 得分

### 中央

- 10 列牌桌

### 库存区

- Stock
- 剩余发牌次数

### 完成区

- 8 个完成牌组

### 底部工具栏

- 新一局
- Undo
- Restart
- Hint
- Stats
- Settings

---

## 32. 响应式目标

最低目标窗口：

```text
约 1024 × 650
```

支持：

- macOS Retina
- Windows 100%
- Windows 125%
- Windows 150%

窗口缩小时：

- 缩小牌面
- 增加纵向重叠
- 尽量避免横向滚动

---

## 33. 主题和无障碍

支持：

- Light
- Dark
- High Contrast
- Reduce Motion
- Animation On/Off
- Sound On/Off

---

## 34. 技术结构

```text
Application
├── Game Controller
├── Rule Engine
├── Deterministic Generator
├── Certified Seed Library
├── Board Renderer
├── Input Controller
├── Move Validator
├── Undo Manager
├── Hint Engine
├── Score Manager
├── Timer
├── User Manager
├── Statistics Manager
├── IndexedDB Storage
├── Import / Export
├── Animation Layer
└── Audio Manager
```

开发环境额外：

```text
Developer Tools
├── Seed Generator
├── Full Solver
├── Solution Validator
├── Difficulty Analyzer
├── Difficulty Classifier
├── Seed Deduplicator
├── Certificate Builder
└── Batch Test Runner
```

---

## 35. 技术栈

最终 Runtime 优先：

- 原生 HTML
- 原生 CSS
- 原生 JavaScript
- 内嵌 SVG
- IndexedDB
- Web Audio API

开发阶段允许：

- TypeScript
- Node.js
- Build Tools
- Test Runner

最终全部打包进自包含 `index.html`。

---

## 36. GitHub 开源代码原则

允许参考 GitHub 项目。

优先：

- MIT
- BSD
- Apache-2.0
- Public Domain

GPL 项目可以研究算法思想和做 Benchmark，但不默认直接把代码合并进最终 Runtime。

必须维护：

```text
THIRD_PARTY_LICENSES
```

同时记录来源仓库、锁定 commit、许可证文本、NOTICE/归属要求、实际复制或修改的文件。没有明确许可证的公开仓库不等于允许复制；只能在不复制表达形式、代码、资源和牌局数据的前提下研究思想。

---

## 37. 项目体积估算

体积随实际嵌入数量和编码方式变化，不与某个固定 Seed 总数绑定。构建时计算：

```text
totalBytes
= runtimeBytes
 + manifestBytes
 + sum(bucketIndexBytes)
 + sum(embeddedCount[bucket] * encodedBytesPerSeed[bucket])
 + tombstoneBytes
```

并强制：

```text
totalEmbeddedCount <= maximumEmbeddedCount
totalEncodedBytes <= maximumEmbeddedBytes
```

发行包不包含完整 Solver 和完整 Solution Certificate。构建报告必须输出每个分桶及总计的 `embeddedCount`、压缩前后字节数、单 Seed 平均字节数、`index.html` 总大小、解析耗时和峰值内存。31,000 或 100,000 Seed 可以作为压测场景，但不能写入 Runtime 逻辑或发布断言。

---

## 38. Alpha / Beta / V1 分层目标

### Alpha

- 核心 Rule Engine
- Deterministic Generator
- 1S / 2S Solver
- Independent Validator
- Pilot Pool
- 基本 UI
- Undo
- Timer
- Score
- Save

Seed 示例预设：

```text
约 300–1,200
```

四花色仅在批准配置将相应分桶关闭，或显式设为允许空且 `embeddedTarget = 0` 时不阻塞；要求非空的四花色分桶必须达到发布门槛。

### Beta

- 完整用户系统
- Stats
- Hint
- Import / Export
- 动画
- Seed Library 扩大

Seed 示例预设：

```text
5,000–10,000
```

### V1

使用批准的 V1 `SeedPoolConfig` 构建。每个启用分桶必须满足“实际为空且 `allowEmptyBucket = true`”或达到各自 `minimumPublishableCount`；总数量和字节数不超过配置上限，并完成跨浏览器和离线测试。31,000 仅保留为可选大型预设示例。

---

## 39. 最终验收标准

### Rule Engine

标准 Spider 规则全部通过。

### Generator

同 Seed 跨平台生成完全相同 Deal。

### Solver

- 1 Suit >90%
- 2 Suit >50%
- 4 Suit 尽量，不作为前期硬门槛

### Certified Seed

必须：

```text
Solver SOLVED
+
Independent Validator PASS
```

对构建后的有效条目做全量回归：

```text
validatedCount == totalEmbeddedCount
failedCount == 0
duplicateDealIdCount == 0
tombstonedEntrySelectedCount == 0
totalEmbeddedCount == sum(bucket.embeddedCount)
totalEncodedBytes == sum(bucket.encodedBytes)
disabledBucketEmbeddedCount == 0
```

每个启用分桶的发布检查为：

```text
(enabled == false AND embeddedCount == 0)
OR (enabled == true AND allowEmptyBucket == true AND embeddedCount == 0)
OR (enabled == true AND embeddedCount > 0 AND embeddedCount >= minimumPublishableCount)
```

回归报告显示 `validatedCount / totalEmbeddedCount PASS`，不能使用 `31,000 / 31,000` 等固定断言。

### Seed Reuse

- Completed Seed 不再正常随机出现
- Incomplete Seed 仍可能再次出现
- Restart 保留原 Seed
- Seed Library 可追加更新

### Runtime

- 不依赖完整 Solver
- 完全离线
- 本地存储
- 自动保存
- 可恢复未完成牌局

### Cross-platform

至少测试：

- macOS Safari
- macOS Chrome
- macOS Firefox
- Windows Edge
- Windows Chrome
- Windows Firefox

---

## 40. 核心技术不变量

```text
1. Same Seed = Same Deal
2. Certified Seed = Replayable Win
3. Runtime Does Not Need Full Solver
4. User Data Never Needs Remote Database
5. Seed Library Must Be Appendable
6. Completed Seeds Must Stay Completed Across Library Updates
7. Pool Size Comes From Config And Manifest
8. User History Is Keyed By Stable dealId
```

以上原则在后续版本中不得破坏。
