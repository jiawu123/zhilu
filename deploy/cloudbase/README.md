# CloudBase 测试部署

当前分支可以直接构建和部署，无需先合并 `main`。朋友完成前端后重新构建同一服务，保留域名、OAuth 回调和持久存储。

## 2026-09-15 交接状态

- 分支：`codex/p0-core-roadmap`。部署改动不改变后端业务逻辑。
- 云环境：`roadmapper-d6gu1l83m7e7c557e`，上海，体验版。
- 已完成本地 Linux amd64 镜像构建、网关/前端/OAuth 共 22 项针对性测试、全仓类型检查，以及容器账号隔离、重启后读取持久数据的检查。
- 云端已部署：`zhilu-staging`、端口 `8080`、1 核 2 GB、持续运行 1 实例，私有读写 COS 挂载到 `/mnt/zhilu`。当前正常版本为 `003`。
- 测试入口：<https://zhilu-staging-313947-12-1413459042.sh.run.tcloudbase.com/>。腾讯云默认域名首次访问会显示测试提示，不作为正式自定义域名的替代。
- OAuth App ID 为 `431`，知乎项目草稿和 CloudBase 均已保存回调 `https://zhilu-staging-313947-12-1413459042.sh.run.tcloudbase.com/api/auth/callback`。用户已亲自确认授权，成功回到线上目标输入页，并能打开路线图。没有发布知乎赛事项目。
- 模型密钥、OAuth App Key 和已验证的知乎 Access Secret 已配置到云端服务端环境变量，不写入本文件或代码包。
- 线上检查：健康接口 200、未登录历史接口 401、`.env` 和数据文件路径 404。COS 私有读写权限已在腾讯云控制台核实。
- 首轮 `001` 在腾讯云构建器导出镜像时发生存储锁冲突；同一代码包重试 `002` 成功。之后更新回调环境变量生成 `003`，真实 OAuth 验证通过。
- 剩余验收：真实超过 60 秒的生成请求、完整计划保存、云端重新部署后的数据恢复、云端跨账号隔离。实际用量和费用以腾讯云账单为准。
- 首版建议手工部署，暂不开自动部署。当前选择“本地代码上传部署”，没有绑定 Git 推送触发器。

队友只开发前端时无需腾讯云权限。在自己的开发分支同步本分支后，保留 `request-progress.ts` 与 `stream-response.ts` 的共享请求封装；继续使用 `/api/...`，不要把模型密钥、OAuth App Key 或本机地址写进前端。等首版上线稳定，再决定是否为指定发布分支开启自动部署。

若队友需要独立部署，给其自己的腾讯云账号配置协作者身份并限定权限；无需共享主账号扫码登录。不要让两个人同时修改同一个云服务配置。

## 部署形态

- 一个云托管容器：Node 24、React 构建产物、现有 Node API、Linux 知乎 CLI、旧检索路径使用的 Python 环境。
- 公网入口 `8080`；容器内 API 继续监听 `127.0.0.1:8787`。前端和 `/api` 共用 HTTPS 域名。
- `deploy/cloudbase/gateway.mjs` 只公开 `apps/web/dist`。OAuth 请求原样转发，保留 Cookie 与重定向。
- 云端前端构建设置 `VITE_CLOUDBASE_TRANSPORT=sse`。非认证写请求由网关每 10 秒发送 SSE 心跳，最终包装后端状态码和原始响应；前端共享请求函数还原为原接口的 Response。业务逻辑和本地开发请求方式不变。
- 该 SSE 通道仅防止等待时连接空闲，不显示模型正文，也不自动重试操作。原生研究 SSE 仍独立存在。

## 1. 构建与本地验收

从仓库根目录运行：

```bash
docker build --platform linux/amd64 -t zhilu-cloudbase:staging .
docker run --rm --name zhilu-cloudbase-check \
  -p 127.0.0.1:8080:8080 \
  --mount type=volume,source=zhilu-cloudbase-check,target=/mnt/zhilu \
  zhilu-cloudbase:staging
```

没有配置 OAuth 时仍可读取 `/api/health` 和 `/api/auth/status`，其余 API 拒绝未登录访问。页面显示缺少登录配置属于预期结果，不代表真实 OAuth 通过。

Docker 构建上下文采用允许清单，排除 `.env*`、本地 `data/`、研究产物、私人文档和依赖缓存。镜像中不包含本机 OAuth、模型密钥或 Keychain。不要把 `apps/server/.env.local` 整份上传，它含本机路径。

## 2. CloudBase 配置

先开通环境并确认计费，再创建云托管服务（建议名称 `zhilu-staging`）。代码目录为仓库根，Dockerfile 为根目录 `Dockerfile`；也可以直接部署从当前分支构建的镜像。

| 配置 | 值 |
| --- | --- |
| 对外端口 | `8080` |
| 健康检查 | `GET /api/health` |
| 实例数 | 持续运行，固定 1 个实例；不缩容到 0 |
| 流量 | 只指向一个版本，不拆分到多个版本 |
| 持久数据 | 私有 COS 挂载到 `/mnt/zhilu` |
| 环境变量 | 按本目录 `.env.example` 在服务端填写 |

启动程序检查数据目录位于挂载点，并测试写入、rename、删除；未挂载时拒绝启动，避免把账号历史保存在临时磁盘。COS 权限必须为私有，不允许匿名读取账号计划。正式验收要检查新建访谈、生成计划和重新部署后的恢复；启动探针不证明 COS 在所有情况下都具备本地磁盘的原子性。

当前会话、任务进度和并发锁仍在单进程内存中，重启需要重新登录。更新时应先停止用户操作并等待生成任务完成，再将流量切换至新版本；不把多个版本同时作为可写服务。多实例不是本次部署范围。

默认域名是否能作为持续使用的浏览器 HTTPS 入口，需在所选环境核验。确认访问限制、有效期和 OAuth 回调可达性后再登记地址，不把临时预览地址当作稳定域名。

## 3. OAuth 与模型

从知乎赛事项目页取得 `ZHIHU_OAUTH_APP_ID` 和 `ZHIHU_OAUTH_APP_KEY`。确定公网地址后，赛事页面登记值与云端 `ZHIHU_OAUTH_REDIRECT_URI` 必须完全一致：

```text
https://你的公网地址/api/auth/callback
```

模型沿用现有 `ROADMAP_API_URL`、`ROADMAP_MODEL`、`DEEPSEEK_API_KEY`（或 `ROADMAP_API_KEY`）。CLI 在容器中使用 `ZHIHU_ACCESS_SECRET`，不会继承 macOS Keychain。仅登录所需 App Key 与 CLI 所需 Access Secret 是不同凭证。

## 4. 线上验收

1. 访问首页和健康检查；未登录时账号数据 API 返回 401。
2. `/api/auth/status` 显示 `configured: true`，由用户完成知乎授权；回到同一站点后显示正确账号。
3. 创建访谈并执行一次超过 60 秒的请求，确认实际 CloudBase 网关持续传递心跳、最终响应和错误状态，不仅在本地通过。
4. 完成计划保存，重新部署并重新登录，确认访谈和计划仍在。
5. 退出后不能访问原账号数据；另一账号不能读取原账号计划。

## 验证命令

```bash
node --test deploy/cloudbase/gateway.test.mjs
pnpm --filter @zhilu/web exec vitest run src/stream-response.test.ts src/request-progress.test.tsx src/interview-api.test.ts
pnpm --filter @zhilu/server exec vitest run src/auth.test.ts
pnpm typecheck
```

## 官方依据

- [云托管及 Docker 部署](https://docs.cloudbase.net/run/introduction)
- [普通请求使用限制](https://docs.cloudbase.net/run/limitation)
- [WebSocket / SSE 空闲超时与心跳](https://docs.cloudbase.net/run/develop/access/websocket)
- [COS 挂载](https://docs.cloudbase.net/run/deploy/configuring/storage/cos)
- [临时存储会随实例销毁](https://docs.cloudbase.net/run/deploy/configuring/storage/local)

代码和模拟授权测试通过不等于公网部署、真实授权或 COS 持久化验收完成。
