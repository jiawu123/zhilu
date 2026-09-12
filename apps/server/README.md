# Server

2026-09-12：M2 默认 Planner 已切为 `m2-initial`（首轮总计2–3 Query），研究默认 `batch-v1`，新增覆盖与缓存。`createZhihuProvider()` 还提供显式 `planSupplemental()`。Controller 接新 draft 时须传 `queryPolicy:"initial"`，Mock 兼容默认未改。完整函数、状态与回退见 [新分工交接](../../docs/M2_FOLLOWUP_STATUS_2026-09-12.md)。

本地 API、Plan Bundle 文件存储和 P0 模块组装入口。

本地一键测试：从仓库根目录运行 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-backend.ps1`。默认离线，包含 Python/Server 回归、类型检查和完整 HTTP 流程；不会使用已有项目数据。启动服务器、逐接口完整请求及显式真实联调见 [本地后端完整测试](../../docs/LOCAL_BACKEND_TESTING.md)。

现已提供两个默认关闭的真实研究入口：

- `POST /api/projects/:projectId/research/live/evidence` 执行一个 ResearchRequest，只返回 EvidencePack；
- `POST /api/projects/:projectId/research/live/baseline` 运行 Query Planner、多个 ResearchRequest，再调用独立模型 Roadmapper，校验后保存待确认 BaselineProposal。

两个入口都不会直接修改正式 Plan。只有原有 `/baseline/apply` 在用户选择路线后写入 Plan 与 Commit；`/research/mock` 继续作为无配置演示入口。

Server 调用 `createZhihuProvider(readZhihuProviderConfig())`；配置来自 Node 的启动环境，需要绝对路径 `ZHIHU_PYTHON_BIN` / `ZHIHU_PYTHON_CWD`。`ZHIHU_LIVE_ENABLED` 必须显式为 `true` 才启用接口，默认等待上限 630000 ms。Node 不自动加载 Python `.env`；Python 使用自身现有 dotenv loader。不要将 Server 配置或凭据放进前端请求。

完整 PowerShell 启动、离线验证、受控真实 smoke 和错误码见 [模块 README](../../packages/zhihu/README.md#p0-server-真实证据接入)；Jia 的 Planner→Controller→researchOne 调用示例见 [交接文档](../../packages/zhihu/docs/P0_JIA_HANDOFF.md)。

开发时监听 `http://127.0.0.1:8787`。第一次读取 `agent-engineer-demo` 时会从 `examples/` 初始化本地 `data/`；`POST /api/projects` 可根据用户确认的访谈输出创建新项目。Plan、Goal Contract、User Context、pending Patch、Baseline Proposal 与 Commit 均从同一份本地状态读取。Mock Research 只产生待确认提案，`POST /baseline/apply` 才写入正式 Plan。

## Roadmapper 模型配置

在 Node 启动环境配置 `ROADMAP_API_KEY`、`ROADMAP_API_URL`（完整 Chat Completions endpoint）及 `ROADMAP_MODEL`。可回落到 `LLM_API_KEY/LLM_API_URL/LLM_MODEL`；沿用现有 DeepSeek 时可设置 `DEEPSEEK_API_KEY`，默认 endpoint/model 与 Python 模块一致。仅在 `packages/zhihu/.env` 设置 Key 不会自动给 Node 配置。示例见 [.env.example](.env.example)，不要把 Key 传给浏览器。

`ROADMAP_TIMEOUT_MS` 默认 120000，`ROADMAP_MAX_TOKENS` 默认 16384。每次调用只发 JSON Context，没有工具权限，也不自动重试或回落到规则草案。HTTP 503 表示未配置，504 表示模型超时，502 表示服务/协议失败，422 表示日期、容量或生成草案未通过校验。旧提案在新提案成功保存前保留。

首次模型规划支持含首尾日在内 15–364 天（3–52 个周窗口）、每周 1–80 小时；不足一整周的末周按天折算容量，复盘计入预算。已有手工或进度修改的准备版暂不接受整份替换，生成期间的版本变化也会拒绝过期提案。这些条件在检索前检查。完整已确认条件进入模型；导入文档全文、Plan、History 和整篇知乎回答不进入 Context。最多 8 张证据、同来源最多 2 张、同作者最多 3 张只是 Roadmapper 输入保护，检索层缓存/批量筛选仍需 M2 收尾。

当前模型失败后再次运行会重新检索，尚未实现按版本缓存 EvidencePack 后单独重试规划。普通测试替换网络边界，不证明真实模型质量或完整链路延迟。
