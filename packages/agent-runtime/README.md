# Agent Runtime

Workflow Controller、Interview Manager 和 Roadmapper Agent。

当前实现确定性的 `decideWorkflow()`、访谈输出校验、Research Request 组装、“研究准备版”Plan，以及模型 Roadmapper 的 Context 和输出校验。`prepareRoadmapperInput()` 只包含完整确认条件和限定数量的压缩证据；`compileRoadmapperBaseline()` 将 unknown 模型 JSON 转为待确认路线和按周计划，校验引用、工时、依赖与产出，追加周复盘和显式 AI 推断。独立模型 transport 属于 Server，Runtime 不持有 Key，也不写 Plan。

真实 Baseline API 已使用模型链路；旧 `createLiveBaselineProposal()` 仅保留规则草案兼容接口，未用作失败 fallback。Mock 为独立演示入口。底层 Roadmapper 保留至少两张的兼容输入检查；真实 HTTP Controller 和 M3 回放均先要求全局 6–8 张及结构覆盖通过。只能形成一条路线时明确提示未满足完整 P0 路线验收。

`aggregateResearchEvidence()` 是纯函数：跨问题规范化去重、全局最多 8 卡/每来源 2 卡/每作者 3 卡，保留不同主张和条件，重映射研究路线引用，并输出逐题关联和全局结构 coverage。同题补搜只有问题、用户条件、时效完全一致时共享关联；不推断跨问题语义等价。`sufficient` 不是事实或适用性验证，`reviewStatus` 始终 `needs_human_review`。调度与取消属于 Server 的 `runResearchController()`，最多一轮补检索、共 6 条 Query；完整边界和 M3 快照回放命令见 [Server 说明](../../apps/server/README.md)。Roadmapper Context 已包含聚合后仍有完整引用的研究路线候选，仍视作待审阅建议。

`prepareEventReplanInput()` / `compileEventReplan()` 支持确认后的每周时间变化，不检索。模型只能提出受影响未完成任务的日期，Controller 生成预算变更及必要的父里程碑日期变更；目标、内容、工时、状态、依赖、来源及手工字段保持保护。预算包含固定任务/复盘，未完成工时从事件日起保守分摊；明确延期及复盘未延展提醒。错误或无实际变化不生成 Patch，正式应用仍交给 Engine 与用户确认。详见 [M4 范围](../../docs/progress-2026-09-13.md)。
