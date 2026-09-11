# Core 实现决策（P0 第一版）

状态：用于开工；后续 Schema 变更需同步更新 Fixture、调用方和测试。

PRD 已足够确定产品闭环和模块边界，但字段级契约、影响传播和并发规则仍不够精确。本文件冻结第一版行为，避免各模块自行猜测。

## 1. 正式状态与版本

- `PlanState.version` 是从 1 开始递增的整数，也是 Patch 的乐观锁版本。
- Patch 必须携带 `baseVersion`；版本不一致时拒绝应用，不做自动合并。
- `plan.json` 只保存已批准状态；Event 和 Patch 在批准前只进入 pending。
- Commit ID 由 Server 生成，格式为六位递增数字；Engine 不读取时钟或文件系统。

## 2. 节点与关系

- P0 正式节点只实现 `milestone`、`task`、`decision`、`assumption`、`checkpoint`。
- `depends_on` 的方向为 `sourceId` 依赖 `targetId`；影响传播从被改变节点沿“谁依赖它”向后查找。
- 删除在 P0 中使用 `status = archived`，不物理删除节点。
- 用户直接编辑的字段写入 `manualFields`；来源为 Agent 的 Patch 不得覆盖这些字段。

## 3. Impact Diff

- `constraint_changed`：影响全部未完成、未归档任务及其所属里程碑。
- 节点事件：从 `targetNodeIds` 开始，沿反向依赖图传播到下游节点。
- 输出固定六组：直接受影响、失效假设、需重评决策、需排期任务、被阻塞节点、未受影响节点。
- 第一版只做确定性定位；新日期和工时由 Roadmapper 或用户形成 Patch，Engine 不自行推测。

## 4. Patch

- P0 操作只有：新增节点、更新节点、归档节点、添加关系、删除关系。
- Patch 先完整校验，再一次性应用；任一操作失败则正式计划保持不变。
- Agent Patch 必须关联已确认 Event；用户直接编辑可以使用 `reason` 关联操作原因。

## 5. API 错误

- `400`：Schema 或业务校验失败，返回 `{ error, issues }`。
- `404`：项目或节点不存在。
- `409`：Patch 的 `baseVersion` 与正式计划不一致。
- 所有成功写操作返回新的 `PlanState` 和当前 Commit ID。

## 6. 暂未冻结

- 知乎官方接口字段、缓存期限与引用长度；
- Roadmapper 使用的模型和结构化输出方式；
- 拖动排期时是否自动顺延下游节点；
- 多窗口同时编辑时的冲突解决 UI；
- `.planbundle.zip` 的正式清单与校验和。

## 7. 与知乎模块的当前接口

- 已按 `origin/kylee-zhihu-agent` 的 `evidence_compiler.py` 冻结 `ZhihuCompiledEvidenceCard` 输入类型。
- 共享 `EvidenceCard` 分开保存 `sourceType`、`contentType` 和 `verificationStatus`，不把“知乎来源”“经验/观点”“是否已验证”混成一个枚举。
- Python 的 snake_case 编译结果进入 Server 后再映射为前端使用的 camelCase `EvidenceCard`；知乎模块仍无权写 Plan 或创建 Commit。
- Query Planner 输出 `ResearchQuestionDraft`，包含问题、生成理由和已经去重的知乎检索 Query；它属于 Research Subagent 内部能力。
- Workflow Controller 只校验问题数量、Query 总数、重复项和隐私边界，再分配 ID、补充时效与 Evidence 上限，组装为 `ResearchRequest`；Controller 不生成或静默改写问题内容。
