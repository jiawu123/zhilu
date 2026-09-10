# 团队分工与 GitHub Monorepo 方案

状态：P0 执行方案

适用范围：知乎黑客松三人团队

## 1. 决策

P0 只使用一个 GitHub Repository：`zhilu`。

前端、Server、Agent Runtime、Plan Engine 和知乎知识模块在目录和接口上隔离，但不拆成多个 Repository，也不拆成多个独立服务。原因是 P0 的数据 Schema 会频繁变化，单仓库可以在同一个 Pull Request 中同步修改类型、实现和调用方，减少三人团队的联调成本。

GitHub Project 只用于管理 Issue 和进度，不用于替代代码仓库。

## 2. 团队分工

### 2.1 技术负责人 / Core Integrator

负责人：Jia

负责：

- 冻结共享 Schema 和模块接口；
- `packages/contracts`；
- `packages/plan-engine`；
- `packages/agent-runtime`；
- `apps/server` 的模块组装和本地 API；
- Roadmap 的关键状态管理、保存、Diff 和批准流程；
- 端到端集成、代码 Review 和最终 Demo。

验收：即使真实知乎接口和视觉组件尚未完成，也能使用 Mock EvidencePack 跑通“目标 → Evidence → Plan → Roadmap → Event → Diff → Commit”。

### 2.2 知乎知识模块负责人

负责人：当前负责知乎知识库的成员

负责：

- `packages/zhihu`；
- Query 规划、知乎检索和回答读取；
- 内容去重、分类、风险标注与重排；
- Evidence Cache；
- `ResearchRequest → EvidencePack`；
- Mock Provider 和真实 Provider；
- Evidence/Source Inspector 所需的数据和来源展示支持。

验收：同一个 `ResearchRequest` 可以通过 Mock 或真实 Provider 返回符合 Schema 的 EvidencePack；每张 Evidence Card 包含来源、摘要、类型、适用条件和风险信息。该模块无权写入正式 Plan 或创建 Commit。

### 2.3 Roadmap 视觉组件与 Demo 支持

负责人：当前时间有限的成员

负责范围必须是可以通过固定 JSON 独立开发的任务：

- `RoadmapNode` 任务节点；
- `EventDialog` 突发事件表单；
- `DiffPanel` 修改前后差异；
- Loading、空状态和基础视觉样式；
- Demo 数据检查、演示脚本、截图和回归测试。

验收：组件可使用 `examples/` 中的 Fixture 独立渲染；组件通过 props 和 callback 交互，不直接访问文件系统、模型或知乎接口。

Roadmap 主流程不能只依赖该成员。技术负责人必须保留一套可运行的基础界面，视觉组件延期时仍可完成 Demo。

## 3. Monorepo 结构

```text
zhilu/
├── apps/
│   ├── web/                   # React/Vite Roadmap 前端
│   └── server/                # 本地 API、文件存储和模块组装
├── packages/
│   ├── contracts/             # ResearchRequest、EvidencePack 等 Schema
│   ├── plan-engine/           # 纯函数；不调用模型
│   ├── agent-runtime/         # Controller、访谈和 Roadmapper
│   └── zhihu/                 # 检索、筛选和 EvidencePack
├── examples/
│   └── agent-engineer/        # 标准 Demo Plan Bundle 和 Fixture
├── docs/
├── pnpm-workspace.yaml
└── README.md
```

## 4. 依赖方向

```text
apps/web ─────────────────────→ contracts

apps/server ──────────────────→ contracts
             ├────────────────→ plan-engine
             ├────────────────→ agent-runtime
             └────────────────→ zhihu

plan-engine ──────────────────→ contracts
agent-runtime ────────────────→ contracts
zhihu ────────────────────────→ contracts
```

`apps/server` 是组合入口。`plan-engine`、`agent-runtime` 和 `zhihu` 不互相直接写状态，避免循环依赖。用户项目数据写入本地 `data/` 并忽略提交；可复现的脱敏 Demo Bundle 放在 `examples/` 并提交 Git。

## 5. 开工前冻结的接口

第一批 Schema：

1. `ResearchRequest`：Research Subagent 的最小研究任务；
2. `EvidencePack`：筛选后的证据、路线、分歧和未解决问题；
3. `PlanState`：当前正式计划；
4. `PlanEvent`：用户进度、约束变化和突发事件；
5. `PatchProposal`：Agent 建议的计划修改；
6. `ImpactDiff`：修改前后差异和受影响节点。

Schema 修改必须同时更新 Fixture、调用方和测试。

## 6. 集成顺序

1. 建立 Workspace、共享 Schema 和一套完整 Fixture；
2. 使用 Mock EvidencePack 跑通最小端到端闭环；
3. 三个工作流并行：Core、知乎知识模块、独立 UI 组件；
4. 使用真实知乎 Provider 替换 Mock Provider；
5. 完成异常兜底、回归测试和演示脚本；
6. CLI、MCP、分享页、App 和多视图均不进入 P0。

## 7. Git 协作规则

- `main` 必须始终可以运行 Demo；
- 不建立长期 `develop` 分支；
- 使用短分支，例如 `feature/zhihu-retrieval`、`feature/roadmap-node`；
- 所有改动通过 Pull Request 合并；
- `contracts` 和 `plan-engine` 的修改必须由技术负责人 Review；
- Pull Request 应关联一个明确 Issue，并写明验收方法；
- CI 最小检查为 `typecheck + test + build`；
- API Key 只放本地环境变量，不提交 Git；
- 不提交私人材料、原始用户档案或未经脱敏的知乎缓存。

## 8. GitHub Project 看板

列：

```text
Backlog → Ready → In Progress → Review → Demo Ready
```

标签：

```text
area/web
area/runtime
area/knowledge
area/contracts
priority/P0
priority/P1
blocked
```

Issue 应按可验收产物拆分，不使用“完成前端”“完成后端”这类无法在一天内关闭的任务。
