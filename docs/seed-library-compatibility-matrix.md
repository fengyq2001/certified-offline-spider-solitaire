# Seed Library 兼容矩阵

这份矩阵定义认证 Seed Library 在构建时、运行时和升级时的兼容边界。运行时采用 fail-closed：任何版本、哈希、索引或数据结构不匹配都拒绝载入牌库，不回退到随机牌局。

| Library / payload | Manifest | Runtime | `dealId` / index | Tombstone / completed records | 处理方式 | 自动证据 |
|---|---|---|---|---|---|---|
| `seedLibraryVersion=1`，`payloadSchemaVersion=1` | schema 1，`ruleVersion=1.0`，`generatorVersion=1` | 当前 `0.1.x` | `dealId` 为 SHA-256；`payloadIndex` 连续且与 payload 一致 | 完成记录按 `profileId + dealId` 隔离；已完成牌局从选择池排除 | 允许载入与选择 | `tests/runtime/manifest-seed-library.test.js`、`tests/integration/manifest-release.test.js` |
| 同一 Library 的重新构建 | 哈希必须重新计算并全部匹配 | 版本范围仍须满足 `minRuntimeVersion/maxRuntimeVersion` | `libraryHash`、`payloadHash`、`certificateCatalogHash` 必须匹配 | 旧完成记录可继续按 `dealId` 去重 | 允许载入；任何单项哈希不匹配即拒绝 | `tests/runtime/manifest-seed-library.test.js` |
| 旧 payload schema、未知 runtime 或 generator | 版本字段不满足当前边界 | 不兼容 | 无法证明索引和牌局身份 | 不迁移到当前选择池 | 拒绝载入并保持当前游戏状态 | `tests/runtime/version.test.js`、`tests/integration/source-policy.test.js` |
| 缺失 bucket、重复 seed / deal、非连续 index | Manifest 与 payload 结构不一致 | 不兼容 | 身份或内容哈希不可证明 | 不写入 completed / save | 拒绝载入 | `tests/runtime/manifest-seed-library.test.js` |
| bucket 声明 enabled 但没有可发布牌局 | 发布谓词失败 | 不兼容生产选择 | 无有效候选 | 不产生随机替代 | 构建和发布校验失败 | `tests/build/build.test.js`、`scripts/verify-certified-library.js` |

升级规则：先生成新版本 manifest/payload，运行完整证书、构建和分发校验，再替换内嵌工件。已有用户 save 保留其 `seedLibraryVersion`；若新运行时不接受该版本，界面显示存档不可恢复并保留导出路径，不静默改写牌局。

