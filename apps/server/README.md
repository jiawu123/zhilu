# Server

本地 API、Plan Bundle 文件存储和 P0 模块组装入口。

现已提供两个默认关闭的真实研究入口：

- `POST /api/projects/:projectId/research/live/evidence` 执行一个 ResearchRequest，只返回 EvidencePack；
- `POST /api/projects/:projectId/research/live/baseline` 运行 Query Planner、多个 ResearchRequest，并把真实 EvidencePack 组装成待确认 BaselineProposal。

两个入口都不会直接修改正式 Plan。只有原有 `/baseline/apply` 在用户选择路线后写入 Plan 与 Commit；`/research/mock` 继续作为无配置演示入口。

Server 调用 `createZhihuProvider(readZhihuProviderConfig())`；配置来自 Node 的启动环境，需要绝对路径 `ZHIHU_PYTHON_BIN` / `ZHIHU_PYTHON_CWD`。`ZHIHU_LIVE_ENABLED` 必须显式为 `true` 才启用接口，默认等待上限 630000 ms。Node 不自动加载 Python `.env`；Python 使用自身现有 dotenv loader。不要将 Server 配置或凭据放进前端请求。

完整 PowerShell 启动、离线验证、受控真实 smoke 和错误码见 [模块 README](../../packages/zhihu/README.md#p0-server-真实证据接入)；Jia 的 Planner→Controller→researchOne 调用示例见 [交接文档](../../packages/zhihu/docs/P0_JIA_HANDOFF.md)。

开发时监听 `http://127.0.0.1:8787`。第一次读取 `agent-engineer-demo` 时会从 `examples/` 初始化本地 `data/`；`POST /api/projects` 可根据用户确认的访谈输出创建新项目。Plan、Goal Contract、User Context、pending Patch、Baseline Proposal 与 Commit 均从同一份本地状态读取。Mock Research 只产生待确认提案，`POST /baseline/apply` 才写入正式 Plan。
