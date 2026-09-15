# Agent Runtime

Workflow Controller、Interview Manager 和 Roadmapper Agent。

当前实现确定性的 `decideWorkflow()`、访谈输出校验、Research Request 组装、“研究准备版”Plan，以及模型 Roadmapper 的 Context 和输出校验。`prepareRoadmapperInput()` 只包含完整确认条件和限定数量的压缩证据；`compileRoadmapperBaseline()` 将 unknown 模型 JSON 转为待确认路线和按周计划，校验引用、工时、依赖与产出，追加周复盘和显式 AI 推断。独立模型 transport 属于 Server，Runtime 不持有 Key，也不写 Plan。

任务的每周日期表示执行窗口。同路线内可依赖同周或更早周的任务；Runtime 按依赖顺序排列任务，保留原始工时、周次、引用及硬依赖。不存在的任务、自依赖、依赖未来周、循环依赖分别拒绝。不通过删除关系或移动日期使模型输出蒙混过关；正式任务启动仍由 Engine 检查前置是否完成。

M3 首次规划、草稿修订和研究回放默认允许每周额外 `min(原周预算 × 10%, 1 小时)`，最后不足一周时按实际天数折算并向下保留两位小数；任务与系统复盘共同计入总量。低于预算正常，超过弹性上限仍拒绝，不改用户确认的 `weeklyHours` 或模型实际估时。`validateRoadmapperPlanningBudget()` 校验 Server 传入的策略；策略随 `researchRun.planningBudget` 保存，修订与重放沿用，旧记录缺省为上述固定默认值。`RoadmapperRun.weeklyOverruns` 记录每条路线的超额周，提示词、运行时校验、草稿风险与页面提醒使用同一计算结果。Server 的 `ROADMAP_WEEKLY_TOLERANCE_PERCENT` / `ROADMAP_WEEKLY_TOLERANCE_HOURS` 可覆盖新研究默认值，任一设为 0 恢复严格模式。M4 时间变更的重排仍使用其原有严格容量规则。

真实 Baseline API 使用模型链路；旧 `createLiveBaselineProposal()` 仅保留规则草案兼容接口，未用作失败 fallback。Mock 为独立演示入口。`prepareRoadmapperInput()` 依据聚合后的实际覆盖与 Controller 部分失败记录设置 `evidenceStatus`。证据不足（包括零张）时仍调用真实模型，生成一条标有“证据不足”的暂定 AI 路线；引用可为空或使用已提供的用户事实，所有非空引用仍必须属于输入。原有工时、日期、依赖和验收校验保持生效，正式应用仍需用户确认。

未采纳资料保存在 `EvidencePack.insufficientSources`，聚合时保留原始片段、检索时间和风险，草稿写入 `PlanResearchState.insufficientSources` 时只去掉完全相同的记录。它们不是 EvidenceCard，不进入模型上下文、有效证据数量或引用 ID 集合。`RoadmapperRun.evidenceStatus`、警告、路线风险与 AI 推断卡明确标出“证据不足”，不把推断改称已验证证据。活动时间、票价等现时事实需要查验，不能凭模型推测写成已确定安排。

`aggregateResearchEvidence()` 是纯函数：跨问题规范化去重、全局最多 8 卡/每来源 2 卡/每作者 3 卡，保留不同主张和条件，重映射研究路线引用，并输出逐题关联和全局结构 coverage。同题补搜只有问题、用户条件、时效完全一致时共享关联；不推断跨问题语义等价。`sufficient` 不是事实或适用性验证，`reviewStatus` 始终 `needs_human_review`。调度与取消属于 Server 的 `runResearchController()`，最多一轮补检索、共 6 条 Query；完整边界和 M3 快照回放命令见 [Server 说明](../../apps/server/README.md)。Roadmapper Context 已包含聚合后仍有完整引用的研究路线候选，仍视作待审阅建议。

`prepareEventReplanInput()` / `compileEventReplan()` 支持确认后的每周时间变化，不检索。模型只能提出受影响未完成任务的日期，Controller 生成预算变更及必要的父里程碑日期变更；目标、内容、工时、状态、依赖、来源及手工字段保持保护。预算包含固定任务/复盘，未完成工时从事件日起保守分摊；明确延期及复盘未延展提醒。错误或无实际变化不生成 Patch，正式应用仍交给 Engine 与用户确认。详见 [M4 范围](../../docs/progress-2026-09-13.md)。
