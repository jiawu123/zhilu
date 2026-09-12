# Server

本地 API、Plan Bundle 文件存储和 P0 模块组装入口。

本地一键测试：从仓库根目录运行 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-backend.ps1`。默认离线，包含 Python/Server 回归、类型检查和完整 HTTP 流程；不会使用已有项目数据。启动服务器、逐接口完整请求及显式真实联调见 [本地后端完整测试](../../docs/LOCAL_BACKEND_TESTING.md)。

现已提供默认关闭的 `POST /api/projects/:projectId/research/live/evidence`。它执行一个 ResearchRequest，返回 `{ok:true,result:{runId,status,pack,issues,metrics}}`，不创建 BaselineProposal、不写 Plan/History/pending。原 `/research/mock` 与 `/baseline/apply` 保留。

Server 调用 `createZhihuProvider(readZhihuProviderConfig())`；配置来自 Node 的启动环境，需要绝对路径 `ZHIHU_PYTHON_BIN` / `ZHIHU_PYTHON_CWD`。`ZHIHU_LIVE_ENABLED` 必须显式为 `true` 才启用接口，默认等待上限 630000 ms。Node 不自动加载 Python `.env`；Python 使用自身现有 dotenv loader。不要将 Server 配置或凭据放进前端请求。

完整 PowerShell 启动、离线验证、受控真实 smoke 和错误码见 [模块 README](../../packages/zhihu/README.md#p0-server-真实证据接入)；Jia 的 Planner→Controller→researchOne 调用示例见 [交接文档](../../packages/zhihu/docs/P0_JIA_HANDOFF.md)。

开发时监听 `http://127.0.0.1:8787`。第一次读取 `agent-engineer-demo` 时会从 `examples/` 初始化本地 `data/`；`POST /api/projects` 可根据用户确认的访谈输出创建新项目。Plan、Goal Contract、User Context、pending Patch、Baseline Proposal 与 Commit 均从同一份本地状态读取。Mock Research 只产生待确认提案，`POST /baseline/apply` 才写入正式 Plan。
