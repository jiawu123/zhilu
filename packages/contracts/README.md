# Contracts

前端、Server、Plan Engine 和 Agent 模块共享的数据 Schema。

第一版类型定义位于 `src/index.ts`，包括 User Context Card、Goal Contract、Research Request、EvidencePack、Route Candidate、Baseline Proposal 和 Plan Bundle。任何字段调整必须同步更新 `examples/` Fixture、Plan Engine 测试和 API 调用方。
