# Server

2026-09-12：M2 默认 Planner 已切为 `m2-initial`（首轮总计2–3 Query），研究默认 `batch-v1`，新增覆盖与缓存。`createZhihuProvider()` 还提供显式 `planSupplemental()`。Controller 接新 draft 时须传 `queryPolicy:"initial"`，Mock 兼容默认未改。完整函数、状态与回退见 [新分工交接](../../docs/M2_FOLLOWUP_STATUS_2026-09-12.md)。

本地 API、Plan Bundle 文件存储和 P0 模块组装入口。

本地一键测试：从仓库根目录运行 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-backend.ps1`。默认离线，包含 Python/Server 回归、类型检查和完整 HTTP 流程；不会使用已有项目数据。启动服务器、逐接口完整请求及显式真实联调见 [本地后端完整测试](../../docs/LOCAL_BACKEND_TESTING.md)。

现已提供两个默认关闭的真实研究入口：

- `POST /api/projects/:projectId/research/live/evidence` 执行一个 ResearchRequest，只返回 EvidencePack；
- `POST /api/projects/:projectId/research/live/baseline` 运行 Query Planner、多个 ResearchRequest，经过跨问题聚合和结构覆盖检查，再调用独立模型 Roadmapper；证据不足或有效 `partial` 也可生成带“证据不足”标签的暂定草稿，不自动追加补检索，校验后保存待确认 BaselineProposal。

两个入口都不会直接修改正式 Plan。只有原有 `/baseline/apply` 在用户选择路线后写入 Plan 与 Commit；`/research/mock` 继续作为无配置演示入口。

Server 调用 `createZhihuProvider(readZhihuProviderConfig())`；配置来自 Node 的启动环境，需要绝对路径 `ZHIHU_PYTHON_BIN` / `ZHIHU_PYTHON_CWD`。`ZHIHU_LIVE_ENABLED` 必须显式为 `true` 才启用接口，默认等待上限 630000 ms。Node 不自动加载 Python `.env`；Python 使用自身现有 dotenv loader。不要将 Server 配置或凭据放进前端请求。

完整 PowerShell 启动、离线验证、受控真实 smoke 和错误码见 [模块 README](../../packages/zhihu/README.md#p0-server-真实证据接入)；Jia 的 Planner→Controller→researchOne 调用示例见 [交接文档](../../packages/zhihu/docs/P0_JIA_HANDOFF.md)。

开发时监听 `http://127.0.0.1:8787`。第一次读取 `agent-engineer-demo` 时会从 `examples/` 初始化本地 `data/`；`POST /api/projects` 可根据用户确认的访谈输出创建新项目。Plan、Goal Contract、User Context、pending Patch、Baseline Proposal 与 Commit 均从同一份本地状态读取。Mock Research 只产生待确认提案，`POST /baseline/apply` 才写入正式 Plan。

## Roadmapper 模型配置

在 Node 启动环境配置 `ROADMAP_API_KEY`、`ROADMAP_API_URL`（完整 Chat Completions endpoint）及 `ROADMAP_MODEL`。可回落到 `LLM_API_KEY/LLM_API_URL/LLM_MODEL`；沿用现有 DeepSeek 时可设置 `DEEPSEEK_API_KEY`，默认 endpoint/model 与 Python 模块一致。仅在 `packages/zhihu/.env` 设置 Key 不会自动给 Node 配置。示例见 [.env.example](.env.example)，不要把 Key 传给浏览器。

`ROADMAP_TIMEOUT_MS` 默认 120000，`ROADMAP_MAX_TOKENS` 默认 16384。每次调用只发 JSON Context，没有工具权限，也不自动重试或回落到规则草案。HTTP 503 表示未配置，504 表示模型超时，502 表示服务/协议失败，422 表示日期、容量或生成草案未通过校验。旧提案在新提案成功保存前保留。

M3 默认允许每周已确认预算的 **10% 浮动、最多 1 小时**，取两者较小值。配置为 `ROADMAP_WEEKLY_TOLERANCE_PERCENT=10`（范围 0–50）与 `ROADMAP_WEEKLY_TOLERANCE_HOURS=1`（范围 0–8），任一设为 `0` 恢复严格上限；不足七天的末周按天折算浮动额度。任务加复盘超出原预算但在额度内时，草稿保留实际估时并明确提示；超过额度仍拒绝。不增加已确认的 `plan.weeklyHours`，不缩小模型估时，不凑满较低工时。

配置只从 Node 启动环境读取，在研究调用前验证；有效值随 `research.planningBudget` 保存到 M3 快照和草稿，`roadmapper.planningBudget` 与 `weeklyOverruns` 记录本次策略及超出原预算的各周。修改草稿和独立回放沿用已保存策略，不随新环境自动放宽；旧数据缺字段时使用固定默认值 10%/1 小时。该浮动仅适用于首次 M3 规划、草稿修订与回放；M4 时间变化的局部排期仍使用原来的严格预算。

PowerShell 从仓库根目录启动（凭据继续由已有本地配置文件加载）：

```powershell
$env:ROADMAP_WEEKLY_TOLERANCE_PERCENT = '10'
$env:ROADMAP_WEEKLY_TOLERANCE_HOURS = '1'
node --env-file=apps/server/.env.local --import tsx apps/server/src/index.ts
```

首次模型规划支持含首尾日在内 15–364 天（3–52 个周窗口）、每周 1–80 小时；不足一整周的末周按天折算容量，复盘计入预算。已有手工或进度修改的准备版暂不接受整份替换，生成期间的版本变化也会拒绝过期提案。这些条件在检索前检查。完整已确认条件进入模型；导入文档全文、Plan、History 和整篇知乎回答不进入 Context。全局证据上限与检索调度见下文；Kyle 的单请求批量筛选/缓存保留原模块边界。

2026-09-13：已修正“依赖必须指向更早一周”的过度限制。同路线中可存在同周先后任务，例如先核实信息再预订；周日期是执行窗口，任务会按依赖顺序展示，硬依赖和周工时仍保留。循环、自依赖、不存在的任务与依赖未来周分别报错。修改后需要重启 Server；无需重新配置 Python 或知乎 CLI。

界面再次点击生成仍运行整条研究链路；本地独立回放命令可以复用研究快照只测 M3，不再调用知乎，但不会直接保存可批准的提案或修改正式计划。普通测试替换网络边界，不证明真实模型质量或完整链路延迟。

## 跨问题研究 Controller

`runResearchController()` 只调用 M2 的公开 Provider，不直接导入 Kyle 的 Planner/检索/编译内部模块。

页面的 live Baseline 显式使用 `allow_insufficient`。不传该选项的旧调用方仍为严格策略；下述补检索规则仅适用于严格策略。

- 首轮全局 2–3 条 Query；结构覆盖不足时至多补一轮 1–3 条，累计最多 6 条。整批校验后才搜索，拒绝跨轮重复 Query。失败和缓存请求均占用调度预算，不自动重试。
- 聚合最多 8 张卡，同来源最多 2 张、同作者最多 3 张。同源同主张的规范化去重保留不同条件/相反观点；路线引用随 ID 重映射，引用缺失时移除整条候选。
- 结构覆盖目标是全局至少 6 张、每个研究问题有入选证据、适用条件非空、有明确限制/反例以及至少一个仍有引用的路线候选。原 pack 的明确条件/路线缺口继续保留；它们在新页面流程中用于提示而非阻断模型规划。同题补搜只有问题文本、用户条件和时效要求一致时才关联原题；不同问题不推测等价。
- `sufficient` 仅表示通过结构检查，**不等于语义充分或事实已核实**；始终 `needs_human_review`，还需人工检查证据是否真正回答问题、适合用户、支持两条有实质差异的路线。数量不足不凑卡。当前 live Baseline 在覆盖不足时仍调用 M3，明确标记为待核实的 AI 暂定路线。
- live Baseline 使用 `evidencePolicy:"allow_insufficient"`：执行原首轮请求，保留 `partial`/`no_evidence` 状态和缺口，然后调用真实 Roadmapper，不自动补搜或再次调用 Planner。进程、认证、配额、协议或整体执行失败仍报错，模型输出校验仍生效，不回落 Mock、不修改正式计划。
- 返回的 `controller` 记录轮数、覆盖缺口、问题关联、各阶段耗时和停止原因。`queriesAttempted` 是已交给 Provider 的预算数量（不等于账单），`searchCallsAttempted` 是 Provider 报告的实际搜索尝试，`cacheHits` 是请求级命中次数。成功记录随研究提案保存。
- 每个已返回且通过校验的请求立即更新统计。`partial` 报错会说明检索/编译等失败阶段及可用卡片数量；未执行或未成功返回的问题单独列为缺口，不再把已有证据显示为“尚未取得研究证据”。严格 Controller 调用仍在部分失败时停止；live Baseline 改为带不足提示继续模型规划，卡片数量不代表研究已完成。
- 失败前已通过校验的请求与原始 EvidencePack 保存到 `<数据目录>/<项目ID>/.plan/research-partials/partial-UUID.json`，`research-failure.json` 只保留摘要及 `partialArtifactId`。每次独占新建、最多 2 MiB，采用与 M3 snapshot 相同的 POSIX 权限设置（Windows ACL 未由此验证）。其中引文、CRLF、emoji 和风险标签保持原样，不在 HTTP 错误中返回；文件应仅本地保留，不提交 Git。此文件只供检查或离线复现 Controller，标记为 `partial-research`，不能作为 M3 输入、待确认提案或已完成研究应用；它不包含被拒绝的原始模型输出。历史上未保存的部分证据无法补回。
- M2 阶段默认总期限 630000 ms，到期取消运行中的默认 Python Provider，并等待子进程清理后释放项目锁；M3 另用 `ROADMAP_TIMEOUT_MS`。注入自定义 Provider 必须遵守 `AbortSignal` 并在工作停止后结束 Promise；忽略 signal 的旧 Provider 不享有此超时保证。

## M3 独立回放与验收

真实 Baseline 在初始研究结果通过协议校验后、调用 M3 前保存 `{plan, research}` 到 `<数据目录>/<项目ID>/.plan/research-snapshots/<研究RunID>.json`。模型失败也保留快照。快照最多 2 MiB，含用户确认背景和证据，不含 Provider 配置；目录 0700、文件 0600，独占新建。不得提交 Git 或作为公开分享内容；当前需手动管理保留周期。正式 Plan/History 不因保存快照而改变。

从仓库根目录运行：

```zsh
# 合成离线验收：不读取凭据，不调用知乎或模型。
node --import tsx apps/server/scripts/verify_m3.ts

# 帮助与本地快照回放（仍使用合成模型输出）。
node --import tsx apps/server/scripts/verify_m3.ts --help
node --import tsx apps/server/scripts/verify_m3.ts --snapshot "/绝对路径/研究RunID.json"

# 明确选择真实模式后，至多调用一次模型；不会调用知乎或自动重试。
# 将 env 路径替换为实际 Node 配置文件，不要把密钥写在命令行。
node --env-file=apps/server/.env.local --import tsx apps/server/scripts/verify_m3.ts --snapshot "/绝对路径/研究RunID.json" --live
```

`--live` 必须给出快照且拒绝合成证据；配置仅来自进程环境。快照只接受未手工修改的研究准备版，重算全局覆盖，不信任保存的 Controller 自报状态。模型调用前验证失败不会创建 Provider。

输出到独立的 `data/verification/m3-UUID/`：`report.json` 和通过编译时的 `preview.json`，文件 0600。这里只产出审阅材料，不写正式 Plan、History 或 pending proposal；界面仍通过原有用户选路线/确认流程落盘。`structural_pass` 表示两条预览通过结构校验，不代表真实质量验收；`needs_review` / `failed` 返回非零退出码。报告始终要求人工核对来源、引用语义、路线差异、工时和完成标准；一次耗时不能代表 P95。

## 时间变化的局部排期

`POST /api/projects/:projectId/diff/replan` 只接受 `{ "patchId": "已有待确认提案ID" }`。读取已保存的时间约束事件与正式计划，预检通过后复用 Roadmapper 传输，不初始化或调用知乎 Provider。仍需 `ZHIHU_LIVE_ENABLED=true` 和 Node 模型配置，但这个接口不需要 Python/知乎 CLI。

成功后生成新 Patch ID，替换旧 pending，返回 `processing`（模型判断、无需检索的原因、既有证据 ID、提醒）；不修改正式计划。模型执行期间禁止批准旧方案，生成期间版本变化则拒绝结果，失败保留原方案。用户通过 `/diff/apply` 确认后，处理记录随 Commit 保存。规则事件入口继续可离线运行，并明确没有自动改期。后续 M2 读取已确认的 `plan.weeklyHours`，不再使用访谈时的旧预算。

新版 Baseline Controller 显式采用 `queryPolicy: "initial"` 对齐 Kyle 的 `m2-initial`；全局结构覆盖与补检索已接入，但真证据的语义覆盖与 M3/M4 实际模型效果仍待联合验收。

### 自适应访谈与确认前调整

- `POST /api/interviews`：`{ goal }`，用现有 Roadmapper 模型配置生成首批背景题。
- `GET /api/interviews/:id`：恢复会话。会话位于数据目录 `interviews/`，与项目正式计划分开。
- `POST /api/interviews/:id/answers`：`{ answers: [{ questionId, optionIds, text?, skipped? }] }`。单选/多选/toggle 使用 `optionIds`，填空只传 `text`，跳过只传 `{ questionId, skipped: true }`；旧版单选 `optionId` 仍兼容。后端校验本轮完整答案，输入目标及累计题目、选项、答案和跳过标记；每批 1–5 题，总数最多 30。模型结束时返回 `confirmed: false` 的可编辑摘要，用户显式确认后再通过创建项目接口保存。
- `POST /api/projects/:id/baseline/revise`：`{ proposalId, routeId, message }`。只对未确认的真实知乎草稿生效，输入选中草稿、累计调整对话和缓存证据，不调用知乎检索。新草稿使用新 ID，拒绝旧草稿确认；失败保留原稿。对话持久化在提案中。
- `POST /api/projects/:id/baseline/apply`：用户确认最新草稿后才写入正式计划与版本历史；调整进行中拒绝确认。

题目 `type` 为 `single | multiple | text | toggle`，未声明类型的旧题按单选处理。选择题有 2–6 个选项，`allowsText: true` 或“其他”选项选中后必须填写补充。填空题全程最多 3 道（包括跳过），文本最多 1,000 字符。模型输入包含剩余填空题预算，后端验证上限。

研究失败按规划/检索阶段显示具体原因，例如 `rate_or_quota_limit` 对应知乎限流或额度不足；不会自动重试。安全诊断写入项目 `.plan/research-failure.json`，包含阶段、停止原因和调用计数，不保存原始日志或凭据。

问题、摘要和计划调整均调用模型，不提供固定题库回退。无需打开知乎开关即可访谈；真实研究仍需 `ZHIHU_LIVE_ENABLED=true` 和已有知乎配置。重启服务后新接口才生效。


2026-09-13：[证据不足时的模型规划](../../docs/MODEL_PLANNING_WITH_INSUFFICIENT_EVIDENCE.md) 已接入 live Baseline。严格 Controller 默认值保留给旧调用方；页面使用 `allow_insufficient`，不自动补搜。
