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

当前支持创建任意目标项目、6 个核心问题与 1 个条件化追问、User Context Card / Goal Contract 确认、Markdown/TXT 背景导入、本周焦点、节点编辑/改期/完成/新增/归档、节点级与时间约束事件、依据检查、确定性影响定位、Patch 审批、本地持久化、History，以及 JSON、Markdown、`.planbundle.zip` 导出。确认目标后先生成“研究准备版”；随后可运行 `Query Planner → 多个 ResearchRequest → EvidencePack → 模型 Roadmapper → 用户确认 Baseline`。Roadmapper 使用独立 Run ID 与压缩证据，生成 1–2 条有引用的路线、3–5 个里程碑、按周任务、复盘与待验证假设；草案经日期、工时、依赖与来源校验后才可确认。证据不足时明确提示，不强行制造两种观点。

真实研究默认关闭，需要本机配置知乎 CLI、Python 与模型；Roadmapper 配置见 [Server 说明](apps/server/README.md)。Mock 保留为无配置演示。新模型链路已用离线模型/检索边界覆盖集成测试，真实模型输出质量与全链路耗时仍待现场验收；M4 模型局部重规划尚未接入。最新 PRD 与 Kyle 现有检索实现的差距见 [M2 收尾交接](docs/m2-followup-2026-09-12.md)。

M2 配置与 PowerShell 命令见 [知乎模块说明](packages/zhihu/README.md#p0-server-真实证据接入)，实际验证记录见 [P0 状态](packages/zhihu/docs/P0_INTEGRATION_STATUS.md)，调用签名见 [Jia 交接](packages/zhihu/docs/P0_JIA_HANDOFF.md)。

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
