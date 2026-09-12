# Agent Runtime

Workflow Controller、Interview Manager 和 Roadmapper Agent。

当前实现确定性的 `decideWorkflow()`、访谈输出校验、Research Request 组装、“研究准备版”Plan，以及模型 Roadmapper 的 Context 和输出校验。`prepareRoadmapperInput()` 只包含完整确认条件和限定数量的压缩证据；`compileRoadmapperBaseline()` 将 unknown 模型 JSON 转为待确认路线和按周计划，校验引用、工时、依赖与产出，追加周复盘和显式 AI 推断。独立模型 transport 属于 Server，Runtime 不持有 Key，也不写 Plan。

真实 Baseline API 已使用模型链路；旧 `createLiveBaselineProposal()` 仅保留规则草案兼容接口，未用作失败 fallback。Mock 为独立演示入口。证据不足两张则停止，少于六张或只能形成一条路线时明确提示未满足完整 P0 证据/路线验收。普通进度或约束变化仍不触发全量检索，M4 模型局部重规划后续接入。
