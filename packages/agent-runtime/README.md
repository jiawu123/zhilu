# Agent Runtime

Workflow Controller、Interview Manager 和 Roadmapper Agent。

当前实现确定性的 `decideWorkflow()`、访谈输出校验、Research Request 组装、“研究准备版”Plan，以及 Mock/真实 EvidencePack 到两条待确认 Route 与 Roadmap 预览的生成。真实模式保留知乎来源并明确标记未验证；路线目前是可解释的确定性草案，不冒充模型生成。普通进度或约束变化不触发全量检索；模型驱动的 Roadmapper 仍待接入。
