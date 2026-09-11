# Agent Runtime

Workflow Controller、Interview Manager 和 Roadmapper Agent。

当前实现确定性的 `decideWorkflow()`、访谈输出校验、Research Request 组装、“研究准备版”Plan，以及 Mock Research / 两条 Route / Roadmapper 预览生成。普通进度或约束变化不触发全量检索；Mock Evidence 明确标记为未验证 AI 推断且没有虚构 URL。真实知乎调用和模型驱动的 Roadmapper 仍待接入。
