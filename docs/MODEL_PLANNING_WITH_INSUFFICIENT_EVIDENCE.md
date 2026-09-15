# 知乎证据不足时继续模型规划（2026-09-13）

本次按新的产品要求调整：知乎内容不足、单请求正常无证据或部分编译未通过时，仍使用现有 DeepSeek / Roadmapper 配置生成待确认计划。证据充分不是调用模型的硬门槛；来源、引文、身份、协议、工时及依赖校验继续生效。

## 页面和状态

- `POST /api/projects/:projectId/research/live/baseline` 无需新增请求参数。Server 从已确认项目读取目标与背景，执行原首轮研究，然后调用一次真实 Roadmapper。
- 不足时生成一条暂定路线，显示“证据不足”，说明路线安排属于 AI 推断。0 张有效证据也支持规划；允许空引用或引用已给定用户事实，不得捏造知乎依据。
- 原始检索帖子单独显示为“未作为计划依据的知乎原帖”，每篇带“证据不足”标签、原因、原始片段、来源链接和检索时间。它们不计入有效证据数，不进入 Roadmapper 事实输入，不作为任务采用的证据。
- 未检索到可展示帖子时明确显示缺失，不伪造帖子。此前没有保存的被拒绝内容不能恢复；旧缓存仅能恢复其中已保存的 `no_evidence` 原始来源。
- 用户确认前仅保存草稿；确认后标签和帖子保存在 `plan.research`，在路线背包继续展示。模型失败保留旧草稿与正式计划。

`roadmapper.mode` 仍为 `model`，`researchRun.mode` 仍为 `live`。新增 `roadmapper.evidenceStatus: "sufficient" | "insufficient"`，由实际证据覆盖及部分失败情况决定；`sufficient` 仅表示结构检查通过，不表示事实或语义已核实。

不足时 Controller 的 `stopReason` 为 `model_planning_with_insufficient_evidence`，覆盖报告仍为 `insufficient` / `needs_human_review`。请求级 `ok`、`no_evidence`、`partial` 状态继续保留，不能把编译失败改名为正常空结果。

## 原帖数据契约

Python research 输出和共享 `EvidencePack` 新增可选 `insufficientSources`。复用 compiler 的 source 结构及 Server 原有来源校验，不增加第二个 EvidenceCard adapter：

```json
{
  "requestId": "controller-assigned-request-id",
  "evidence": [],
  "routeCandidates": [],
  "unresolvedQuestions": ["尚无活动官方开票时间依据"],
  "insufficientSources": [{
    "source": {
      "id": "zhihu:answer:123",
      "provider": "zhihu",
      "title": "示例：作者的一次旅行经历",
      "url": "https://www.zhihu.com/answer/123",
      "author": "示例作者",
      "snippet": "示例原始片段。\r\n旅行 🚆 经验没有说明当前活动的售票时间。",
      "retrievedAt": "2026-09-13T10:00:00Z",
      "source_scope": "search_snippet"
    },
    "reasonCode": "no_evidence",
    "riskTags": ["证据不足", "search_snippet_only", "not_independently_verified", "semantic_support_not_checked"]
  }]
}
```

上面是契约示例，不是真实证据。`reasonCode` 仅允许 `no_evidence`（未形成证据）、`compiler_rejected`（未通过编译校验）、`not_selected`（本轮未采用）。不得传入被拒绝的模型主张或虚构引文。每请求最多 24 项、192 KiB，保留完整片段，不拼接或截断；同源不同片段继续独立保留。原本合法但未入选的卡片风险标签一并保留。

`POST /research/live/evidence`、`/research/mock`、`/baseline/revise`、`/baseline/apply` 原接口保留。`researchOne()` 仍只执行传入 Query，没有新增检索、Planner 或模型重排。live Baseline 不自动补搜；旧调用方直接使用 `runResearchController()` 时仍为严格策略，需要新行为则显式传 `{ evidencePolicy: "allow_insufficient" }`。

## 执行错误与回放

Python 启动、认证、配额、超时、非法 JSON、请求 ID 不匹配、所有编译项均无法校验、模型调用失败仍报告执行错误，不自动回退 Mock。部分结果协议合法但证据不足时才进入暂定规划。

保存的正常研究快照可通过现有 M3 replay 继续规划；缺口会重新计算。只提取 Controller 的安全负面阶段标记，不信任其“已充分”声明。`partial-research` 错误诊断文件仍不作为可执行快照。证据不足的回放返回 `needs_review`，不视为完整质量验收。

## Windows 本地运行

后端和前端使用两个独立终端。现有环境配置不变；Node 读取 `apps/server/.env.local`，Python 沿用自身安全配置加载。不要把密钥放进命令、前端或请求。

```powershell
# 终端 1：先 Ctrl+C 停止旧后端，再运行
Set-Location 'C:\Users\Kylee\Desktop\zhilu'
node --env-file=apps/server/.env.local --import tsx apps/server/src/index.ts
```

```powershell
# 终端 2
Set-Location 'C:\Users\Kylee\Desktop\zhilu'
pnpm --filter @zhilu/web dev
```

刷新页面，在原研究准备版再次点击“用知乎证据规划路线”。只有确认计划才写正式版本。后端启动命令没有 watch，必须重启才加载修改。

离线验证（无真实凭据、无网络）：

```powershell
Set-Location 'C:\Users\Kylee\Desktop\zhilu'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-backend.ps1
node node_modules/vitest/vitest.mjs run apps/web/src
node node_modules/typescript/bin/tsc --noEmit -p apps/web/tsconfig.json
```

## 证据不足接入阶段的真实验证（同周依赖修复前）

使用此前真实检索、编译明确标为 `no_evidence` 的 9 篇来源，构造 0 有效证据的隔离接口验证；这属于既有材料重放，不是一次新的线上研究。真实 DeepSeek Roadmapper 调用 1 次，新增知乎搜索、Planner、compiler 调用均为 0。

请求已越过旧的证据门槛进入模型，但模型输出含不符合“依赖指向更早一周任务”规则的安排，返回 HTTP 422 `invalid_roadmap`。未自动重试、未放宽排期校验；真实和隔离正式 Plan 均未改变，History 为 0。此次不能宣称真实完整 Roadmap 验收通过。

本地诊断：`packages/zhihu/artifacts/soft-roadmapper-live-9AkFWs/summary.json`。原始回复及保存研究快照仅在忽略目录中，不提交。仍需人工审查事实、行程可行性与模型排期质量。

## 改动与交接

| 文件 | 用途 |
| --- | --- |
| `packages/contracts/src/index.ts` | 共享不足来源、规划证据状态字段 |
| `packages/zhihu/zhihu_m2/research_runner.py`、`evidence_cache.py` | 保留原帖、原因、风险；兼容旧缓存 |
| `apps/server/src/zhihu-boundary.ts` | 校验新来源字段，复用原 compiler 来源约束 |
| `apps/server/src/research-controller.ts`、`index.ts` | live Baseline 允许不足结果继续规划，保留严格旧策略 |
| `packages/agent-runtime/src/research-evidence.ts`、`roadmapper.ts` | 保留原帖，支持 0/1 卡暂定规划，添加不足标签 |
| `apps/server/src/m3-replay.ts` | 不足快照可重放，兼容真实 Planner 阶段状态 |
| `apps/server/src/baseline-revision.ts` | 修改草稿时过滤旧 AI 运行引用，保留真正来源和用户事实 |
| `apps/web/src/App.tsx`、`ResearchEvidence.tsx`、`styles.css` | 提案和确认后页面展示不足提示、原帖及标签 |
| 上述模块对应测试及 `insufficient-sources-cross-language.test.ts`、Python 离线 fixture | 覆盖零证据、部分失败、未知引用、原文保留、真实 Python/TS 边界、确认流程 |
| Server / agent-runtime README、本文 | 更新状态、接口、运行命令与验证限制 |

Jia 沿用现有 live Baseline 接口即可；代码入口为 `runResearchController(plan, provider, { evidencePolicy: "allow_insufficient" })` → `prepareRoadmapperInput()` → 现有模型 Provider → `compileRoadmapperBaseline()`。无需新 adapter，也不需要前端传模式开关。

如需恢复原硬性阻断，只把 live Baseline 调用改回 `runResearchController(plan, provider)`，重启 Server；原严格策略及测试仍保留。不要通过改 Mock 的 mode 恢复或冒充真实结果。

## 最终离线验证

- `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-backend.ps1`：Python **1065 通过、1 跳过**；当次后端 **432 通过、2 跳过**；HTTP **36/36**；双领域 Python Provider/adapter **2/2**；Server 类型检查通过。
- 最后修订兼容补丁后执行 `node node_modules/vitest/vitest.mjs run apps/server packages/agent-runtime packages/plan-engine`：**434 通过、2 跳过、0 失败**。
- `node node_modules/vitest/vitest.mjs run apps/web/src`：**41 通过、0 跳过、0 失败**。
- Server/Web TypeScript 检查、Web Vite build、`git diff --check` 通过。
- 跳过项为不适用本机的 POSIX 权限及 Windows 无权限建立符号链接检查；未宣称这些环境已验证。
- 最初新增回归已先确认失败，再实现通过；普通自动化未使用真实网络。上述离线通过不等同于真实模型排期或证据语义质量已通过人审。

完整后端报告：`packages/zhihu/artifacts/local-backend-20260913T101325Z-eeeb2626/checks.json`。

本次交付的是“证据不足时继续真实模型规划及原帖展示”的代码接入；**不宣称真实证据驱动完整 Roadmap 已完成质量验收**。

## 同周依赖修复与后续真实验证

用户随后反馈“依赖必须指向同一路线中更早一周的任务”。原 Roadmapper 把同周依赖、前置任务缺失和未来周依赖合并成同一错误；现按周执行窗口允许同路线同周任务有明确先后关系。

- `packages/agent-runtime/src/roadmapper.ts`：提示词与校验同时更新；任务按拓扑顺序及周次稳定排列。没有移动周次/日期、删依赖或改工时，所有边仍为 `hard:true`。
- 自依赖、缺失/其他路线任务、依赖未来周、循环依赖分别拒绝；Engine 仍要求完成前置后才能启动后续任务。
- `packages/agent-runtime/src/roadmapper.test.ts` 新增 6 项回归；先复现旧错误，再实现通过。
- `apps/server/src/roadmapper-dependencies.test.ts` 新增 4 项 HTTP 集成测试，覆盖生成草稿、用户确认、硬依赖执行，以及失败时保留原 pending/Plan/History。
- Server 与 agent-runtime README 已更新；本轮没有修改 Python、Controller、Plan Engine 或前端实现。

本轮命令：

```powershell
node node_modules/vitest/vitest.mjs run apps/server packages/agent-runtime packages/plan-engine apps/web/src
node node_modules/typescript/bin/tsc --noEmit -p apps/server/tsconfig.json
node node_modules/typescript/bin/tsc --noEmit -p apps/web/tsconfig.json
```

结果 **485 通过、2 跳过、0 失败**（含后端 444、前端 41）；两个跳过仍为 Windows/POSIX 环境项目。两端类型检查与 `git diff --check` 通过。独立审查无遗留 P1/P2。

本轮真实 DeepSeek **1 次**，复用此前的 9 篇真实 `no_evidence` 帖子作零证据输入，新增知乎/Planner/compiler 调用均 **0**；不是重新运行整轮线上研究。隔离 Server 接口返回 **HTTP 202**，生成 1 条真实模型暂定路线，9 篇不足原帖全部保留。模型输出含 **7 条依赖，其中 3 条同周依赖、0 条未来周依赖、0 条缺失引用**；原本会被旧规则拒绝的同周依赖现在通过。

真实与隔离正式 Plan 均未变，History 0，没有自动应用。结构联调通过，事实与行程质量仍标记 `needs_human_review`。本次成功不改写上阶段一次 422 失败记录；两阶段累计 DeepSeek 2 次。

本轮私有诊断目录：`packages/zhihu/artifacts/dependency-roadmapper-live-ESjTQA/`，包含安全摘要、模型输入/输出及待确认 HTTP 回复；该目录被 Git 忽略，不提交。修复后重启 Server，刷新页面再生成即可。

## 每周工时弹性（用户确认：最多 10%，且不超过 1 小时）

用户随后反馈“第 2 周的任务与复盘超过可投入工时”，并明确选定默认容差。原校验把任何超出确认预算的安排都拒绝；现允许有限弹性，同时保留原预算和真实任务估时。

- 完整一周的上限为 `原周预算 + min(原周预算 × 10%, 1 小时)`，任务与系统复盘共同计入。5 小时可到 5.5 小时，12 小时可到 13 小时。少于预算仍正常，不设下限、不凑满。
- 最后不足七天的一周按天数折算原容量和弹性，分别向下保留两位小数。额度不跨周借用，不随草稿修订叠加。
- 模型输入同时给出 `capacityHours`、`reviewHours`、`toleranceHours`、`maxTotalHours`，提示模型优先在原预算内安排。超过上限仍返回 HTTP 422，并说明计划量、原预算和上限；没有自动重试或压缩估时。
- 在额度内但超出原预算时，`roadmapper.weeklyOverruns` 记录实际超额周；预览和确认后的路线背包显示原预算、含复盘总量及额外投入，AI 推断卡带“工时弹性需确认”。`plan.weeklyHours` 和用户确认条件保持不变。
- 策略随 `researchRun.planningBudget`、研究快照和 `roadmapper.planningBudget` 保存。修订和 M3 回放沿用保存值；旧数据无此字段时采用固定 10%/1 小时默认值，不受当前环境中的更宽松值影响。
- 本轮范围为 M3 首次规划、草稿修订和回放。M4 时间变化重排仍保持原有严格预算规则。

新增响应字段示例（示例数值，不是真实模型评估结果）：

```json
{
  "planningBudget": { "weeklyToleranceRatio": 0.1, "weeklyToleranceHours": 1 },
  "weeklyOverruns": [
    { "routeId": "route-a", "week": 2, "capacityHours": 5, "plannedHours": 5.5, "toleranceHours": 0.5 }
  ]
}
```

上面字段位于 `BaselineProposal.roadmapper` 和确认后的 `plan.research.roadmapper`。HTTP 请求仍不接受任意覆盖用户预算，原接口及确认流程不变。Server 新增 `readRoadmapperPlanningBudget()` 并复用 Runtime 的 `validateRoadmapperPlanningBudget()`；Jia 继续调用现有 live Baseline、revise、apply 接口即可。

本轮修改涉及：`packages/contracts/src/index.ts`（共享策略/超额记录）；`packages/agent-runtime/src/index.ts`、`roadmapper.ts`（默认值、提示词、容量校验和记录）；`apps/server/src/roadmapper-provider.ts`、`index.ts`、`m3-replay.ts`（配置及持久化）；`apps/web/src/WeeklyOverrunNotice.tsx`、`App.tsx`、`styles.css`（所选路线提醒）；相应 Runtime、Provider、M3、revision、HTTP、Web 测试；Server `.env.example`、两端 README 与本文。本轮未修改 Python、Plan Engine 或 History 实现。

默认无需添加配置，重启后端即可生效。如需严格回退，新研究启动前设置以下非敏感配置（已保存草稿与快照仍沿用原策略）：

```powershell
Set-Location 'C:\Users\Kylee\Desktop\zhilu'
$env:ROADMAP_WEEKLY_TOLERANCE_PERCENT = '0'
node --env-file=apps/server/.env.local --import tsx apps/server/src/index.ts
```

恢复选定默认值可将上述值设为 `10`，并设置 `$env:ROADMAP_WEEKLY_TOLERANCE_HOURS = '1'`。环境读取仅在 Node，Python 不需要新配置；无效值在 Planner/搜索/模型调用之前安全拒绝，不回显原始配置。

本轮先新增失败测试再实现：Runtime 新用例先 9 失败；Server 配置先 16 失败，HTTP/保存/回放先 5 失败；Web 新提醒先 4 失败。实现后验证：

```powershell
node node_modules/vitest/vitest.mjs run apps/server/src packages/agent-runtime/src packages/plan-engine/src apps/web/src
node node_modules/vitest/vitest.mjs run apps/server/scripts
node node_modules/vitest/vitest.mjs run apps/server/src/roadmapper-budget.test.ts
node node_modules/typescript/bin/tsc --noEmit -p apps/server/tsconfig.json
node node_modules/typescript/bin/tsc --noEmit -p apps/web/tsconfig.json
Push-Location apps/web
node node_modules/vite/bin/vite.js build
Pop-Location
git diff --check
```

前两项合计 **528 通过、2 跳过、0 失败**（499 + 29，不重复计算单文件复测）；跳过仍为本机 Windows 符号链接权限与 POSIX 权限测试。最后补充的 HTTP 确认回归 **6/6**：原预算 6 小时、含复盘 6.5 小时的草稿可通过 Engine apply，GET 返回的策略、超额记录和警告完整，任务仍为原估时；生成阶段正式 Plan/History 不变，仅明确 apply 后 History 增加 1。两端类型检查、前端构建通过。独立审查未发现工时策略的 P1/P2 问题。Python 本轮没有变更，因此没有重复运行全量 Python；此前的 1065/1 结果保留为历史记录，不冒充本轮验证。

本轮真实 DeepSeek **1 次**，新增知乎/Planner/compiler 调用均 **0**。隔离 Server live Baseline 接口重放此前 9 篇真实 `no_evidence` 来源后调用真实模型，返回 **HTTP 202** 和一条暂定路线，9 篇原帖均保留。模型 5 周工时均在额度内，本次未实际使用额外额度；超额接受/超上限拒绝由上述离线边界测试验证。真实和隔离正式 Plan 均未变，History 为 0，没有自动应用或重试。

私有诊断：`packages/zhihu/artifacts/budget-roadmapper-live-B5JRaO/`，被 Git 忽略。此次验证说明接口及新的工时协议可运行，不代表事实、证据语义或路线可行性通过人审；仍为 `needs_human_review`。三个连续修复阶段累计真实 DeepSeek 3 次，本轮仅 1 次。没有宣称“真实证据驱动完整 Roadmap 已完成质量验收”。

## 最终 Git 状态

分支 `kylee-zhihu-agent`；HEAD `bf2aadd9f791b42a081b86bae2e792e8749d1d22`。无暂存、commit、merge 或 push；下列包含此前已有修改，原 pyc 与备份均保留。

```text
 M apps/server/.env.example
 M apps/server/README.md
 M apps/server/src/baseline-revision.test.ts
 M apps/server/src/baseline-revision.ts
 M apps/server/src/index.ts
 M apps/server/src/live-baseline.test.ts
 M apps/server/src/m3-replay.test.ts
 M apps/server/src/m3-replay.ts
 M apps/server/src/repository.ts
 M apps/server/src/research-controller.test.ts
 M apps/server/src/research-controller.ts
 M apps/server/src/roadmapper-provider.test.ts
 M apps/server/src/roadmapper-provider.ts
 M apps/server/src/zhihu-boundary.test.ts
 M apps/server/src/zhihu-boundary.ts
 M apps/web/src/App.tsx
 M apps/web/src/styles.css
 M packages/agent-runtime/README.md
 M packages/agent-runtime/src/index.ts
 M packages/agent-runtime/src/research-evidence.test.ts
 M packages/agent-runtime/src/research-evidence.ts
 M packages/agent-runtime/src/roadmapper.test-fixture.ts
 M packages/agent-runtime/src/roadmapper.test.ts
 M packages/agent-runtime/src/roadmapper.ts
 M packages/contracts/src/index.ts
 M packages/zhihu/tests/test_batch_replay.py
 M packages/zhihu/zhihu_m2/__pycache__/query_planner.cpython-312.pyc
 M packages/zhihu/zhihu_m2/__pycache__/ranker.cpython-312.pyc
 M packages/zhihu/zhihu_m2/evidence_cache.py
 M packages/zhihu/zhihu_m2/research_runner.py
?? apps/server/src/insufficient-sources-cross-language.test.ts
?? apps/server/src/roadmapper-budget.test.ts
?? apps/server/src/roadmapper-dependencies.test.ts
?? apps/web/src/ResearchEvidence.tsx
?? apps/web/src/WeeklyOverrunNotice.tsx
?? apps/web/src/research-evidence.test.tsx
?? docs/MODEL_PLANNING_WITH_INSUFFICIENT_EVIDENCE.md
?? packages/zhihu/tests/fixtures/insufficient_sources_boundary_offline.py
?? packages/zhihu/tests/test_insufficient_sources.py
?? packages/zhihu/zhihu_m2/batch_screening.py.bak
```
