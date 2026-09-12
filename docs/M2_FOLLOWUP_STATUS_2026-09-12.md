# M2 新分工实施与交接 · 2026-09-12

本轮以 Kyle 提供的 `Downloads/m2-followup-2026-09-12.md` 为准。当前仓库中的 PRD §6.3/6.5 仍是旧查询数量和权重公式快照，不能用来覆盖新分工。没有拉取、切换或合并 Jia 的分支。

开始分支：`kylee-zhihu-agent`；HEAD：`2b3cacfbad6ef2f7eb0bcdf86e439dfbec43212b`；工作区干净，未找到适用 AGENTS.md。根包位置为 `packages/zhihu/zhihu_m2`，Python 工作目录仍为 `packages/zhihu`。

## 已落地的代码

| 范围 | 实现 | 边界 |
| --- | --- | --- |
| 首轮规划 | `m2-initial`：1–3 个有意义的问题，全轮总计 2–3 条独立 Query，每题 1–2 条 | 不凑题；信息不足继续 clarification；一次模型调用 |
| 补充规划 | `plan_supplemental` / `pipeline --action supplement` / `provider.planSupplemental` | 调用方明确提交缺口和余量；建议 1–3 个新 Query；无缺口或预算为零则零调用停止；不自动搜索 |
| 批量研究 | 默认 `batch-v1`，安全搜索与 normalization → 原始 occurrence/variant → RRF 限定候选集合 → 一次模型批量分级及编译 | 不调用旧加权 ranker，也不逐篇调用模型；使用现有 DeepSeek 模型、endpoint、JSON transport |
| 证据选择 | 相关性、适用条件、支撑、时效的分级；优先保留可用限制；根据已接受来源/作者做多样性选择 | 最多 8 卡、同 source ID 和 URL 各最多 2 卡、同已知作者最多 3 卡；不凑满 |
| 引文 | 重用 `validate_evidence_response` 与原 `adaptZhihuCompilerOutput` | 不拼接、裁剪或修补原文；原始来源、检索时间、CRLF、emoji、风险标签保留 |
| 研究候选 | 有合法 evidenceIds 的主张与适用条件分组 | 沿用现有 RouteCandidate 六字段；强制 `model_inferred_needs_human_review`；无任务、里程碑、推荐路线或自动批准 |
| 覆盖报告 | 可选 `EvidencePack.coverage` | `sufficient` 只代表结构数量、限制和有引用候选齐备；始终 `needs_human_review`，不证明真实语义分歧 |
| 缓存 | 本地原子读写、24 小时 TTL、限长、完整性及 compiler 校验 | 仅完整 ok/no_evidence；不复用 partial/error；新请求只重绑外部 requestId |
| Provider | 默认新 profile、显式补充方法；允许的 stderr 错误类别和计数回传 | stdout 优先；仅失败且无 stdout 时使用完整诊断行；不保存/输出原始日志或异常 |

批量最多接收 24 个完整 variant，同时将候选输入限制在 192 KiB，给 256 KiB 总提示词上限留空间。超过预算返回 `candidate_batch_truncated`/partial，绝不为了容纳更多内容而截断原文。RRF 使用各 Query 的原始名次，只负责批量召回顺序；最终选择使用模型分级而非加权分数，任何分数/标签均不代表事实可信度。

`compiler_calls_attempted` 继续表示旧逐篇编译调用；新路径为 0。`batch_model_calls_attempted` 和 `model_calls_attempted` 表示新批量模型尝试；正常一次请求最多 1 次。缓存命中时全部实际搜索/模型计数为 0，另给 `saved_search_calls`、`saved_model_calls`。计数是调用尝试，不是收费账单或 token 使用量。

## Jia 应接入的函数

```ts
import { randomUUID } from "node:crypto";
import { assembleResearchRequests } from "@zhilu/agent-runtime";
import { buildM2Context } from "../apps/server/src/m2-context";
import { createZhihuProvider, readZhihuProviderConfig } from "../apps/server/src/zhihu-provider";

// 放在 Jia 的 Controller 中，plan 来自已保存且确认的项目。
const provider = createZhihuProvider(readZhihuProviderConfig());
const context = buildM2Context(plan);
const planning = await provider.planForBaseline(context);
if (planning.status === "needs_clarification") return planning;
const requests = assembleResearchRequests({
  questions: planning.questions,
  queryPolicy: "initial", // 新规格必须显式传入；旧 Mock 默认 legacy 未改
  relevantUserConditions: [plan.userContext!.currentSituation, ...plan.userContext!.constraints],
  evidenceLimitPerQuestion: 8,
  idFactory: () => `rq-${randomUUID()}`,
});
// Controller 选择请求并扣减全局预算；M2 不会自动执行其他请求。
const result = await provider.researchOne({ ...context, request: requests[0]! });
// result.pack 的研究候选交给 M3；不要直接写成已批准的 Baseline。
```

`validateResearchQuestionDrafts(drafts, "initial")` 与 `assembleResearchRequests({queryPolicy:"initial", ...})` 已同步。原无 policy 调用继续采用 legacy 规则供 Mock 回归；Jia 应显式选择新 policy，不能把 Python 内部 question_id 当作外部 request.id。

Controller 汇总全部请求后，需要对全轮卡片去重、落实全局 6–8 卡与来源/作者上限，再判断剩余缺口。Python 的 `assess_coverage(compiler_outputs, route_candidates)` 可评估已合并且完成上限选择的研究结果，但不负责 Controller 调度。每题的 coverage 不等于全轮 coverage。

明确缺口后的补充调用：

```ts
const next = await provider.planSupplemental({
  ...context,
  gaps: [{ kind: "counterevidence", reason: "已接受证据尚无明确限制或反例。" }],
  executed_queries: requests.flatMap(request => request.searchQueries),
  remaining_query_budget: 1,
});
// next.status: ready_for_review | stop
// next: {status,questions,stopReason,gaps,plannerCallsAttempted}
// ready_for_review 后由 Controller 决定是否 assemble(queryPolicy:"supplemental")。
```

`stopReason` 为 `coverage_sufficient` / `query_budget_exhausted` / `no_useful_queries`。这里的 coverage_sufficient 仅表示调用方没有报告缺口，不是模型或人工认证。输入字段由可信 Controller 提供，不能将 HTTP body 原样转交补充规划器。新方法没有新增 HTTP 端点。

## 保留的接口、输入输出

HTTP 仍为 `POST /api/projects/:projectId/research/live/evidence`，body 仍只包含：

```json
{
  "request": {
    "id": "controller-request-001",
    "question": "初学者怎样验证一个小程序的结果？",
    "searchQueries": ["小程序 固定样例 测试方法", "初学者 程序测试 常见限制"],
    "relevantUserConditions": ["已掌握函数和列表"],
    "evidenceLimit": 8
  }
}
```

Server 从保存的确认资料取得 goal/user_context，交给 Python 的完整包装为：

```json
{
  "goal": "8周完成可运行且有基本测试的小程序",
  "user_context": {"weekly_hours": 10, "python_level": "beginner"},
  "request": {
    "id": "controller-request-001",
    "question": "初学者怎样验证一个小程序的结果？",
    "searchQueries": ["小程序 固定样例 测试方法", "初学者 程序测试 常见限制"],
    "relevantUserConditions": ["已掌握函数和列表"],
    "evidenceLimit": 8
  }
}
```

共享 EvidenceCard 字段和旧 adapter 均不变。新增可选 coverage 完整示例：

```json
{
  "status": "insufficient",
  "evidenceCount": 1,
  "targetMin": 6,
  "targetMax": 8,
  "hasCaveat": true,
  "gaps": [{"kind": "evidence_count", "reason": "可用证据少于6张。"}],
  "reviewStatus": "needs_human_review"
}
```

研究层 RouteCandidate 完整示例（合成说明，不是线上结论）：

```json
{
  "id": "research-hypothesis-example",
  "title": "先用固定样例检查",
  "summary": "所引作者建议用固定输入核对预期输出。",
  "applicableWhen": ["已经明确预期输出的初学者练习"],
  "evidenceIds": ["必须是本包实际存在的卡片ID"],
  "risks": ["model_inferred_needs_human_review"]
}
```

完整可运行的成功 Python envelope 和对应 Server 返回，不靠手写示例：运行 `tests.fixtures.batch_boundary_offline`，以及下方双领域验收脚本；脚本保存 `offline-programming.json` / `offline-writing.json`，含全部 8 张卡、2 个研究候选、状态与计数。这些是合成回归，不是真实知乎证据。

| 结果 | HTTP / Provider | 含义 |
| --- | --- | --- |
| 有卡且执行正常 | HTTP 200，`ok:true`，`result.status:"ok"` | coverage 可以不足；不意味着已经形成完整路线 |
| 正常无卡 | HTTP 200，`result.status:"no_evidence"` | 搜索/模型正常得出没有适用证据；保留无证据 reason |
| 部分失败 | HTTP 200，`result.status:"partial"` + issues | 例如部分搜索/编译项失败、批量截取预算、无法强制时效范围；不缓存 |
| 执行失败 | HTTP 502（超时 504） | 安全错误码，无成功空数组，无 Mock 回退 |
| 默认禁用 | HTTP 503 | `ZHIHU_LIVE_ENABLED` 未显式启用 |

Python 保留 `compilerOutputs`（包括 source、reason、evidence_cards）；Server 仅通过现有 adapter 映射共享卡片。`/research/mock`、`/baseline/apply`、Plan、version、currentCommitId、History 和 pending 流程均未改。

## 配置与 Windows 命令

Node 从启动环境读取解释器、工作目录、profile；Python 使用继承环境，并通过现有 loader 读取固定的 `packages/zhihu/.env`（override=false，不插值）。两个 venv 均 Python 3.12.7，M2/httpx/dotenv/pytest 导入成功，版本一致；保留根 venv 作为默认，没有改 cwd/PYTHONPATH 或更换模型服务。配置/凭据不能进入 argv、HTTP JSON、VITE_* 或前端。

```powershell
Set-Location 'C:\Users\Kylee\Desktop\zhilu'
# 一键离线：Python、TS、类型检查、36步HTTP、双领域批量跨语言验收
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-backend.ps1

# 只跑新 M2 双领域离线链路
node .\node_modules\tsx\dist\cli.mjs .\apps\server\scripts\test_m2_followup.ts

# 本地启动真实证据接口（明确启用；不会自动发请求）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-backend.ps1 -Mode Serve -Live -Profile batch-v1
```

仅在确认配额恢复后再执行有上限的真实验收：

```powershell
node .\node_modules\tsx\dist\cli.mjs .\apps\server\scripts\test_m2_followup.ts --live
```

脚本最多 1 次 Planner、3 次搜索、3 次批量模型调用；仅用明确标记的合成演示背景。首次失败/partial 停止，无自动补检索。冷运行使用新的缓存目录；只在写成功后用 `ZHIHU_EVIDENCE_CACHE_ONLY=true` 复测，新 requestId 以外整包须一致。仅缓存读取的模式未命中便安全失败，不能悄悄转为付费搜索。

缓存键包括 goal、完整相关上下文、question、queries、conditions、evidenceLimit、freshness、profile 与版本；只排除 request.id。任一条件变化产生新键；过期、损坏或不兼容缓存均不复用。不改变原 retrievedAt 来延长新鲜度。默认目录 `packages/zhihu/artifacts/evidence-cache`，可由可信环境 `ZHIHU_EVIDENCE_CACHE_DIR` 指定；`ZHIHU_EVIDENCE_CACHE_ENABLED=false` 关闭。缓存包含证据和相关条件，应留在本地；目录已被现有 artifacts ignore 规则覆盖。

回退只改 Server 启动环境并重启，不删除或覆盖源码：

```powershell
$env:ZHIHU_RETRIEVAL_PROFILE = 'legacy' # 或 v3，仅回到既有实验策略
$env:ZHIHU_PLANNING_PROFILE = 'jia-p0-baseline' # 旧3题×2Query，仅兼容回归
$env:ZHIHU_EVIDENCE_CACHE_ENABLED = 'false'
```

回到新分工配置：`ZHIHU_RETRIEVAL_PROFILE=batch-v1`、`ZHIHU_PLANNING_PROFILE=m2-initial`、`ZHIHU_EVIDENCE_CACHE_ENABLED=true`。旧 v3 额外第二次 LLM 重排仍未添加；本轮的一次批量调用替换逐篇编译。

## 本轮真实运行与未验收部分

2026-09-12 15:11:32–15:11:40 UTC，真实 Server Provider → Python：

- Planner 1 次成功，run ID `entry_5cede294f24843a69f72bcc79c5e4f51`，2 个问题、总计 3 条 Query，5219 ms。
- 第一次知乎搜索返回 `rate_or_quota_limit`，立即停止；搜索尝试 1，批量模型 0，旧编译 0，卡片 0。
- 总耗时 7775 ms；此轮无 cold EvidencePack、无真实缓存重放。失败研究子进程的 run ID/独立耗时当时未持久化，不能事后补造；后续脚本补上失败阶段/外部请求 ID 记录。
- 完整安全报告：`packages/zhihu/artifacts/m2-followup-live-20260912/report.json`。不含凭据/原始异常，未将私有 artifacts 提交到 Git。

编程/写作合成输入的批量链路、超时/no_evidence/partial/error、缓存与回退是工程验证。真实问题尚未采集并人工标注，真实来源分歧和质量对照均 `needs_human_review`。不能用合成 8 卡/2 假设宣称质量提升，也不能将一次 7.8 秒失败 smoke 当作稳定性或 P95。

**已有 M2／Server 单请求真实证据接入得到保留，新分工所需的 M2 代码与离线接入已实现；新版真实证据与缓存验收受配额阻塞。真实证据驱动完整 Roadmap 尚未完成。** 当前 checkout 没有 Jia 文档所述新增 M3 Provider/roadmapper 文件；联合验收需 Jia 的最终演示环境，包含全局预算、跨问题证据合并、M3、预览、用户批准与正式写入。没有修改 Mock mode 冒充这些功能。

## 验证记录

主要新行为按先失败测试、最小实现、回归执行。统一命令实际执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-backend.ps1
```

| 验证 | 实际结果 |
| --- | --- |
| `python -B -m pytest -q`，cwd=packages/zhihu | 888 passed，0 failed，0 skipped |
| Vitest：Server src、新验收脚本测试、agent-runtime、plan-engine | 186 passed，0 failed，0 skipped；13 个测试文件 |
| `tsc --noEmit -p apps/server/tsconfig.json` | 通过 |
| `test_backend_http.ts` | 36/36 步通过，使用隔离测试项目；真实接口默认关闭，状态保护通过 |
| `test_m2_followup.ts` 默认离线 | 编程、写作各 8 卡和 2 个研究假设通过；真实服务调用 0 |
| `git diff --check` | 通过；仅现有 Windows LF/CRLF 提示，无空白错误 |

统一脚本报告目录：`packages/zhihu/artifacts/local-backend-20260912T151435Z-50509a3e`。最后修正了合成 batch fixture 的计数名称（逐篇0、批量1），随后定向回归 Python 44 项、TS 22 项全通过，并重跑双领域离线验收。最后的完整双领域输出：`packages/zhihu/artifacts/m2-followup-offline-final-20260912/`。这些重复测试不累计增加独立测试总数。

新测试覆盖首轮/补充数量和停止、外部ID、bool限制、批量一次调用、不同 Query 的原文变体、调用/字节预算、卡片/作者上限、引用碰撞、CRLF/emoji偏移、无证据/partial/失败、缓存失效及只读防付费、stderr分块与日志、超时/非法JSON/清理、安全错误、真实Python与TS边界和旧Mock/批准/历史回归。

## 实际修改文件及最终 Git 状态

- `query_planner.py` / `pipeline.py`：新首轮、显式补充入口与安全错误/尝试计数。
- `batch_screening.py` / `research_runner.py` / `retrieval_options.py`：批量路径、证据与覆盖选择、预算和回退。
- `evidence_cache.py`：本地缓存、原始 compiler 复验和失效。
- `zhihu-provider.ts` / `zhihu-boundary.ts`：子进程、规划/研究/补充协议与共享输出校验。
- `contracts/src/index.ts` / `agent-runtime/src/index.ts`：可选覆盖类型与显式查询 policy；没有改 Controller 调度或 Mock 行为。
- 两套验收脚本、对应 tests/fixtures 与中文 README/交接文档：可重复本地验证与移交。

最终分支和 HEAD 未变；暂存区为空，17 个已跟踪文件修改、13 个新增文件未跟踪：

```text
 M apps/server/README.md
 M apps/server/src/fixtures/provider-child.cjs
 M apps/server/src/zhihu-boundary.ts
 M apps/server/src/zhihu-provider.test.ts
 M apps/server/src/zhihu-provider.ts
 M docs/LOCAL_BACKEND_TESTING.md
 M packages/agent-runtime/src/index.ts
 M packages/contracts/src/index.ts
 M packages/zhihu/README.md
 M packages/zhihu/docs/P0_INTEGRATION_STATUS.md
 M packages/zhihu/docs/P0_JIA_HANDOFF.md
 M packages/zhihu/tests/test_retrieval_options.py
 M packages/zhihu/zhihu_m2/pipeline.py
 M packages/zhihu/zhihu_m2/query_planner.py
 M packages/zhihu/zhihu_m2/research_runner.py
 M packages/zhihu/zhihu_m2/retrieval_options.py
 M scripts/test-backend.ps1
?? apps/server/scripts/test_m2_followup.test.ts
?? apps/server/scripts/test_m2_followup.ts
?? apps/server/src/zhihu-followup.test.ts
?? docs/M2_FOLLOWUP_STATUS_2026-09-12.md
?? packages/agent-runtime/src/research-query-policy.test.ts
?? packages/zhihu/tests/fixtures/batch_boundary_offline.py
?? packages/zhihu/tests/test_batch_screening.py
?? packages/zhihu/tests/test_evidence_cache.py
?? packages/zhihu/tests/test_followup_entry.py
?? packages/zhihu/tests/test_followup_planner.py
?? packages/zhihu/tests/test_research_runner_batch.py
?? packages/zhihu/zhihu_m2/batch_screening.py
?? packages/zhihu/zhihu_m2/evidence_cache.py
```

未执行 merge、stash、reset、clean、commit 或 push。
