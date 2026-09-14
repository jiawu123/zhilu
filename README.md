# 知路（Zhilu）

知乎知识驱动的目标规划 Agent。产品通过目标访谈、知乎知识检索和可编辑 Roadmap，生成并持续维护结构化 Plan Bundle。

## P0 产品形态

- 本地 Web：React/Vite 前端 + 本地 TypeScript Server；
- 知乎 Research Subagent：按需生成 EvidencePack；
- Roadmapper Agent：生成 Route、Draft Plan 和 Patch Proposal；
- Plan Engine：校验、影响分析、应用用户批准的修改并创建 Commit；
- Plan Bundle：保存正式计划、待确认修改和历史版本。

### 知乎直答计划体验

开启真实调用后，新计划默认使用知乎 `zhida-agent` 整理研究回答，再由现有 Roadmapper 安排行动与时间。当前保留原有前端，用户仍在查看和调整草稿后确认生成路线图。后端同时支持 JSON 响应和 SSE 流式响应，并保留直答正文与参考来源数据；当前页面尚未展示直答正文、引用卡片或来源列表。没有来源链接也可以生成计划，来源摘要仅用于阅读参考，不计为已核验的 EvidenceCard。

这条默认路径需要知乎 CLI 已登录和 Roadmapper 模型配置，不再需要 Python 研究环境。CLI 路径优先读取 `ZHIHU_CLI_BIN` 或 `ZHIHU_CLI_PATH`；Windows 自动查找当前用户安装目录，其余情况使用 PATH 中的 `zhihu-cli`。保留各自本机的 `.env.local`，不要复制其他系统的绝对路径。旧证据研究路径可通过服务端环境变量 `ZHIHU_RESEARCH_MODE=evidence` 选择；知识缺口事件仍使用原有搜索接口。

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

当前支持创建任意目标项目、由模型按目标和累计回答分批生成的多题型背景访谈（每批 1–5 题，总数最多 30 题；支持单选、多选、程度按钮和最多 3 道填空题，可逐题跳过）、User Context Card / Goal Contract 确认、Markdown/TXT 背景导入、本周焦点、节点编辑/改期/完成/新增/归档、节点级与时间约束事件、依据检查、确定性影响定位、Patch 审批、本地持久化、History，以及 JSON、Markdown、`.planbundle.zip` 导出。访谈页确认背景后进入独立计划页；候选计划在旁边的对话框中调整，用户确认后才进入 Roadmap 并保存正式 Plan Bundle。后端先保存“研究准备版”；随后可运行 `Query Planner → 多个 ResearchRequest → EvidencePack → 模型 Roadmapper → 用户确认 Baseline`。Roadmapper 使用独立 Run ID 与压缩证据，生成 1–2 条有引用的路线、3–5 个里程碑、按周任务、复盘与待验证假设；草案经日期、工时、依赖与来源校验后才可确认。证据不足时明确提示，不强行制造两种观点。

真实研究默认关闭，需要本机配置知乎 CLI、Python 与模型；Roadmapper 配置见 [Server 说明](apps/server/README.md)。Mock 保留为无配置演示。新模型链路已用离线模型/检索边界覆盖集成测试，真实模型输出质量与全链路耗时仍待现场验收。M4 已接入每周时间变化的模型局部排期：只改受影响任务日期，预览真实字段差异，确认后写入带处理依据的 Commit。其余事件、剩余工时估算和复盘延展仍有边界，见 [当前进度与 M4 范围](docs/progress-2026-09-13.md)。Kyle 新版 M2 的代码、配额阻塞和联合接入要求见 [新版 M2 交接](docs/M2_FOLLOWUP_STATUS_2026-09-12.md)。

M2 配置与 PowerShell 命令见 [知乎模块说明](packages/zhihu/README.md#p0-server-真实证据接入)，实际验证记录见 [P0 状态](packages/zhihu/docs/P0_INTEGRATION_STATUS.md)，调用签名见 [Jia 交接](packages/zhihu/docs/P0_JIA_HANDOFF.md)。

2026-09-13：已接入跨问题证据聚合、全局结构覆盖检查及至多一轮补检索（累计最多 6 条 Query）。研究通过后先保存私有快照，再调用 M3。可用 `node --import tsx apps/server/scripts/verify_m3.ts` 运行独立离线回放；显式真实模式只测试一次 Roadmapper、不重复知乎检索、不写正式计划。命令、报告含义和人工验收边界见 [Server 说明](apps/server/README.md#m3-独立回放与验收)。这些实现与离线测试不代表真实 M3/M4 已验收。

## 本地运行

以下命令均从**仓库根目录**执行。需要 Node.js 24 和 pnpm 10.30.2；首次拉取代码后安装依赖：

```bash
node --version
pnpm --version
pnpm install
```

如果没有 pnpm，可先执行 `npm install -g pnpm@10.30.2`。

### 1. 准备后端配置

首次运行时，将 `apps/server/.env.example` 复制为 `apps/server/.env.local`；已有文件时保留原配置，不要覆盖。在 macOS / Linux 下可执行：

```bash
test -f apps/server/.env.local || cp apps/server/.env.example apps/server/.env.local
```

- **只看演示 Roadmap**：无需模型、Python 或知乎凭据，保持 `ZHIHU_LIVE_ENABLED=false`。
- **测试目标访谈、生成背景问题**：填写 `ROADMAP_API_KEY`、`ROADMAP_API_URL` 和 `ROADMAP_MODEL`。URL 必须是完整的 Chat Completions 地址；没有模型配置时，访谈会提示错误，不回退固定题库。
- **测试直答与计划生成**：另外配置 `ZHIHU_LIVE_ENABLED=true`，准备已登录的知乎 CLI；默认使用 `zhida-agent`，可用 `ZHIDA_TIMEOUT_MS` 调整客户端等待上限（默认 95000 毫秒）。模型配置见 [后端模型配置](apps/server/README.md#roadmapper-模型配置)。
- **使用旧证据研究或知识缺口搜索**：还需准备 Python 依赖，以及本机绝对路径 `ZHIHU_PYTHON_BIN` 和 `ZHIHU_PYTHON_CWD`。配置方式见 [知乎模块配置](packages/zhihu/README.md#p0-server-真实证据接入)。Python 的 `packages/zhihu/.env` 与 Node 配置分开。

密钥只放本地环境文件，不写入 `VITE_*` 或提交 Git。

### 2. 启动后端（终端一）

显式加载后端环境文件，并监听代码变化：

```bash
node --env-file=apps/server/.env.local --watch --import tsx apps/server/src/index.ts
```

后端地址为 `http://127.0.0.1:8787`。修改 `.env.local` 后，需在该终端按 `Ctrl+C`，重新运行启动命令。

**已配置 OAuth、但还没有公网回调时**：任何非空 OAuth 配置都会要求登录，`ZHILU_AUTH_MODE=local` 单独设置不能覆盖它。只测试本地访谈与 Roadmap 时，用下面的命令替代上面的后端启动命令（macOS / Linux）；它仅对当前进程清空 OAuth 配置，保留文件中的凭据和模型配置：

```bash
NODE_ENV=development ZHILU_AUTH_MODE=local \
ZHIHU_OAUTH_APP_ID= ZHIHU_OAUTH_APP_KEY= ZHIHU_OAUTH_REDIRECT_URI= \
node --env-file=apps/server/.env.local --watch --import tsx apps/server/src/index.ts
```

真实 OAuth 登录需部署后配置已登记的公网 HTTPS 回调地址，路径为 `/api/auth/callback`；本地预览不等于授权联调通过。

### 3. 启动前端（终端二）

在另一个终端进入同一仓库根目录，执行：

```bash
pnpm --filter @zhilu/web dev
```

打开 `http://127.0.0.1:5173`。前端通过 Vite 将 `/api` 请求代理到 `127.0.0.1:8787`，无需给前端配置后端密钥。

- 目标访谈：`http://127.0.0.1:5173/?page=interview`
- 无模型演示：`http://127.0.0.1:5173/?project=agent-engineer-demo&page=roadmap`（本地工作区模式）
- 后端健康检查：`http://127.0.0.1:8787/api/health`，正常返回 `{"ok":true}`。
- 登录配置检查：`http://127.0.0.1:8787/api/auth/status`，可查看当前模式和缺失配置，不返回密钥。

首次打开演示项目会初始化本地 `data/`。访谈、答案和计划历史保存在后端数据目录；重启不会删除这些记录。开启 OAuth 后，账号数据与原本地工作区分开。

### 快捷启动与排查

只需无配置演示，或已在终端设置好环境变量时，也可用 `pnpm dev` 同时启动前后端。**当前 `pnpm dev` 和 `pnpm --filter @zhilu/server dev` 不会自动读取 `apps/server/.env.local`**；需要模型配置时，优先使用上面的双终端方式。

- 页面打不开：检查前端终端实际显示的地址；5173 被占用时 Vite 可能改用其他端口。
- 页面提示网络错误或代理连接失败：检查后端是否启动，以及 `/api/health` 是否正常。
- 提示缺少模型配置：确认后端使用了 `--env-file`，并在修改配置后重启。
- 提示知乎登录缺少回调：本地测试使用上面的临时关闭 OAuth 命令。
- 后端提示 `EADDRINUSE`：已有进程占用 8787，先在原终端停止旧服务；不要重复启动多个后端。

结束开发时，在前后端各自终端按 `Ctrl+C`。代码验证命令：

```bash
pnpm typecheck
pnpm test
pnpm build
```

PRD 到代码之间已冻结的第一版规则见 [`docs/core-implementation-decisions.md`](docs/core-implementation-decisions.md)。
