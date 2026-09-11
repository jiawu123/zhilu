# Plan Engine

确定性的计划校验、影响分析、Patch Apply 和 Commit functions，不调用模型。

核心函数位于 `src/index.ts`。Engine 是纯逻辑层：不读取文件、不调用模型、不生成时间和 ID。
