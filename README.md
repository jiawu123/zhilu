# 知路（Zhilu）

知乎知识驱动的目标规划 Agent。产品通过目标访谈、知乎知识检索和可编辑 Roadmap，生成并持续维护结构化 Plan Bundle。

## P0 产品形态

- 本地 Web：React/Vite 前端 + 本地 TypeScript Server；
- 知乎 Research Subagent：按需生成 EvidencePack；
- Roadmapper Agent：生成 Route、Draft Plan 和 Patch Proposal；
- Plan Engine：校验、影响分析、应用用户批准的修改并创建 Commit；
- Plan Bundle：保存正式计划、待确认修改和历史版本。

## 仓库结构

```text
apps/web                 Roadmap Web 前端
apps/server              本地 API 与模块组装
packages/contracts       共享数据 Schema
packages/plan-engine     确定性计划函数
packages/agent-runtime   Workflow Controller 与 Roadmapper
packages/zhihu           知乎检索与 EvidencePack
examples                 可提交的演示数据
docs                     PRD、分工与架构文档
```

团队分工、模块边界和 Git 规则见 [`docs/team-and-repo-plan.md`](docs/team-and-repo-plan.md)。

## 当前可运行纵切

Jia / Core 第一版已经跑通：

```text
Demo Fixture → Plan Engine → 本地 API → Roadmap → Event → pending Diff → Commit
```

当前支持本周焦点、节点编辑/改期/完成/新增/归档、节点级与时间约束事件、依据检查、确定性影响定位、Patch 审批、本地持久化、History，以及 JSON、Markdown、`.planbundle.zip` 导出。自动新排期与真实知乎检索尚未接入，页面中会明确显示此边界。

## 本地运行

```bash
pnpm install
pnpm dev
```

- Roadmap：`http://127.0.0.1:5173`
- Local API：`http://127.0.0.1:8787`
- Demo project：`agent-engineer-demo`

验证命令：

```bash
pnpm typecheck
pnpm test
pnpm build
```

PRD 到代码之间已冻结的第一版规则见 [`docs/core-implementation-decisions.md`](docs/core-implementation-decisions.md)。
