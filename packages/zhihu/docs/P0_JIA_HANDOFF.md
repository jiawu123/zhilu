# P0 Jia 接入交接

实施规格在根目录 `docs/CODEX_M2_P0_INTEGRATION.md`；参考摘录与合成 fixtures 均已阅读，实际字段以当前源码为准。共享 Contracts、现有 adapter、排序算法、Mock 路线模板均保持原有职责。

## Jia 下一步调用

```ts
import { randomUUID } from "node:crypto";
import { assembleResearchRequests, validateResearchQuestionDrafts } from "@zhilu/agent-runtime";
import { buildM2Context } from "./m2-context";
import { createZhihuProvider, readZhihuProviderConfig } from "./zhihu-provider";

const provider = createZhihuProvider(readZhihuProviderConfig());
const context = buildM2Context(plan); // 读取 Server 已保存且 confirmed 的 Plan
const planning = await provider.planForBaseline(context);
if (planning.status === "needs_clarification") {
  // 交给现有访谈流程；本轮不 assemble、不 research，不自动第二次模型调用。
  return planning;
}
const validation = validateResearchQuestionDrafts(planning.questions);
if (!validation.valid) throw new Error("Research drafts rejected");
const requests = assembleResearchRequests({
  questions: planning.questions,
  relevantUserConditions: [plan.userContext!.currentSituation, ...plan.userContext!.constraints],
  evidenceLimitPerQuestion: 4,
  idFactory: () => `rq-${randomUUID()}`,
});
const selectedRequest = requests[0]!; // 由 Controller 选定本次请求
const result = await provider.researchOne({ ...context, request: selectedRequest });
// 保留 result.status / issues / metrics / pack；此处不生成或应用 Baseline。
return result;
```

`planForBaseline()` 只映射 `research_question → question`、`queries → searchQueries`、`why_needed → rationale`，并运行原有 Draft validator。`question_id` 留在 Python 内部；对外 ID 来自 Controller 的 `idFactory`。首次模式严格 3 题、每题 2 Query、全局不重复；通用 Planner 仍允许少于 3 题。没有提升 human_approved、coverage_verified、semantic_quality_checked。

## 精确公开签名

`apps/server/src/zhihu-provider.ts`：

```ts
interface ZhihuProviderConfig {
  pythonBin: string;          // 必须绝对路径
  pythonCwd: string;          // 必须绝对路径，当前指向 packages/zhihu
  timeoutMs?: number;         // 默认630000，上限630000
  maxStdoutBytes?: number;    // 默认/上限2 MiB
  maxStderrBytes?: number;    // 默认/上限64 KiB
  env?: NodeJS.ProcessEnv;    // 仅可信 Server 配置
}
interface M2ResearchInput {
  goal: string;
  user_context: Record<string, unknown>;
  request: ResearchRequest;   // 共享Contracts未更改
}
interface BaselinePlanningResult {
  status: "ready_for_review" | "needs_clarification";
  questions: ResearchQuestionDraft[];
  clarificationQuestions: string[];
}
interface ResearchProviderResult {
  runId: string;
  status: "ok" | "no_evidence" | "partial";
  pack: EvidencePack;
  issues: ResearchIssue[];
  metrics: Record<string, number>;
}
interface ResearchIssue {
  code: string; // 实际由程序白名单验证
  stage: "search" | "normalize" | "rank" | "compile" | "coverage";
  queryIndex?: number;
  sourceId?: string;
}
interface ZhihuProvider {
  planForBaseline(input: {goal: string; user_context: Record<string, unknown>}): Promise<BaselinePlanningResult>;
  researchOne(input: M2ResearchInput): Promise<ResearchProviderResult>;
}
// createZhihuProvider(config): ZhihuProvider
// readZhihuProviderConfig(env = process.env): ZhihuProviderConfig
// buildM2Context(plan: PlanState): {goal: string; user_context: Record<string, unknown>}
```

Python：`zhihu_m2.research_runner.validate_research_input(payload)` 无 I/O，返回防御性副本；`run_research(payload, *, dependencies=None, limits=None, metrics=None)` 只执行一个请求。外部进程统一入口仍是 `python -X utf8 -u -m zhihu_m2.pipeline --action plan|research`，plan 可选 `--planning-profile jia-p0-baseline`。Server factory 第二参数为测试用 spawn 注入边界，HTTP 无权选择 executable/module/fixture。

## 完整输入与成功返回示例

Python／`researchOne` 输入（可运行文件为 `examples/entry_research_request.json`）：

```json
{
  "goal": "8周内完成一个可运行、带基本测试的 Agent 小项目。",
  "user_context": {
    "current_situation": "Python 初学者",
    "weekly_hours": 10,
    "constraints": ["只能使用业余时间"],
    "success_criteria": ["项目可以运行，包含基本自动化测试"]
  },
  "request": {
    "id": "rq-integration-001",
    "question": "初学者怎样为 Agent 项目编写基本测试？",
    "searchQueries": ["Agent 项目 初学者 自动化测试", "Python Agent 项目 验收 调试"],
    "relevantUserConditions": ["Python 初学者", "每周可投入10小时"],
    "evidenceLimit": 4
  }
}
```

HTTP 输入只保留上面的 `request`，完整 body：

```json
{
  "request": {
    "id": "rq-integration-001",
    "question": "初学者怎样为 Agent 项目编写基本测试？",
    "searchQueries": ["Agent 项目 初学者 自动化测试", "Python Agent 项目 验收 调试"],
    "relevantUserConditions": ["Python 初学者", "每周可投入10小时"],
    "evidenceLimit": 4
  }
}
```

HTTP 200 成功结构如下。**以下证据内容是合成格式示例，不是真实知乎结果**；真实联调产物仅存在被忽略的本地 artifacts。

```json
{
  "ok": true,
  "result": {
    "runId": "synthetic-example",
    "status": "ok",
    "pack": {
      "requestId": "rq-integration-001",
      "evidence": [{
        "id": "synthetic-card-1",
        "title": "合成离线来源",
        "summary": "作者建议检查固定输入的输出结果。",
        "sourceType": "zhihu",
        "contentType": "advice",
        "verificationStatus": "unverified",
        "sourceTitle": "合成离线来源",
        "sourceUrl": "https://www.zhihu.com/question/1/answer/2",
        "author": "合成作者",
        "supportingQuote": "给程序输入固定样例，并检查输出结果。",
        "applicableWhen": ["检查程序时"],
        "caveats": ["合成离线数据，不是真实研究结果"],
        "riskTags": ["search_snippet_only", "not_independently_verified", "semantic_support_not_checked"],
        "adoptionReason": "合成离线测试"
      }],
      "routeCandidates": [],
      "unresolvedQuestions": []
    },
    "issues": [],
    "metrics": {"planner_calls_attempted": 0, "search_calls_attempted": 2, "compiler_calls_attempted": 1, "candidate_count": 1, "evidence_count": 1}
  }
}
```

source 的检索时间为 null 时，adapter 不添加 `retrievedAt`，保留未知含义；有实际时间则原样保留。原始 snippet、quote、CRLF、emoji 和风险不改写。Python 偏移为 Unicode code point，TS 用 `Array.from`/展开后的代码点验证精确片段，不能直接用 JS UTF-16 slice。compilerOutputs（含 source/reason/no_evidence）在 Python→Server 保留完整，HTTP 仅返回共享 pack。

正常无证据完整返回：

```json
{"ok":true,"result":{"runId":"example-empty","status":"no_evidence","pack":{"requestId":"rq-integration-001","evidence":[],"routeCandidates":[],"unresolvedQuestions":["No applicable evidence was obtained from the evaluated search results."]},"issues":[],"metrics":{"planner_calls_attempted":0,"search_calls_attempted":2,"compiler_calls_attempted":0,"candidate_count":0,"evidence_count":0}}}
```

部分失败完整返回（可以没有卡片，但不是正常无证据）：

```json
{"ok":true,"result":{"runId":"example-partial","status":"partial","pack":{"requestId":"rq-integration-001","evidence":[],"routeCandidates":[],"unresolvedQuestions":["Some research coverage remains incomplete; inspect the safe issue codes.","No applicable evidence was obtained from the evaluated search results."]},"issues":[{"code":"search_network_error","stage":"search","queryIndex":1}],"metrics":{"planner_calls_attempted":0,"search_calls_attempted":2,"compiler_calls_attempted":0,"candidate_count":0,"evidence_count":0}}}
```

执行失败示例为 HTTP 502：

```json
{"error":"Python 研究执行失败；未回退 Mock。","code":"process_failed"}
```

Provider 抛出的 `ZhihuProviderError` 提供 `code`、`status`；已校验的 Python 失败还可含 `upstreamCode`、`metrics`，便于 Server 本地诊断。清理未确认时可有 `cleanupError:"cleanup_failed"`；原始异常、stderr、上游原始 body 均不输出。

## 状态与错误语义

| 情况 | Python | Provider／HTTP |
| --- | --- | --- |
| 有证据且无执行失败 | ok:true / status:ok / exit0 | 200，result.status=ok |
| 正常耗尽且无适用证据 | ok:true / status:no_evidence / exit0 | 200，result.status=no_evidence |
| 部分搜索/来源失败、预算不足、freshness未落实 | ok:true / status:partial / exit0 | 200，result.status=partial，检查issues |
| 所有搜索失败 | ok:false / research_failed / 非零 | 502，process_failed |
| 实际尝试的所有编译失败 | ok:false / compilation_failed / 非零 | 502，process_failed |
| 配置/依赖/鉴权/配额致命错误 | 对应白名单error，立即停止 | 502，不继续付费或回退 |
| Python research_timeout／Node超时 | 非零／终止进程 | 504，timeout |
| stdout非法JSON/UTF-8、协议/action/ID/引文/卡片违约 | 不适用 | 502，invalid_response |
| 启动、stdin、输出大小错误 | 不适用 | 502，startup_failed/stdin_failed/output_limit |
| 未启用/项目不存在/请求无效 | 不调用Python | 503/404/400 |
| 未确认或过长背景、同项目busy | 不调用Python | 409 |

每 Query 搜索数量与最终 evidenceLimit 分开控制；正常 no_evidence 来源会继续下一个候选，直到上限/候选耗尽/预算截止。次数是尝试次数，不是计费次数；没有编造 token usage。

## 背景、配置与剩余接入

`buildM2Context` 从 confirmed GoalContract/UserContext 提取 goal、current_situation、weekly_hours、constraints、success_criteria、target_date、non_goals、must_have_outcomes、tradeoffs、review_cadence、可选background_notes。不会传全部 Plan 或节点。超长背景明确拒绝并请求缩短，不静默截断约束。编译额外把 relevantUserConditions/freshness 放入 `research_request_constraints`，与 `confirmed_user_context` 分开，并重新检查组合长度。

配置和直接可运行 PowerShell 命令见 [README](../README.md#p0-server-真实证据接入)。Server 的 live 默认关闭；仅原有本地监听/跨域范围使用，同项目一个执行中请求，不引入任务队列。

**routeCandidates 固定为空。** 下一步由 Jia 的真实 runtime 将多个有状态的 EvidencePack 综合成 RouteCandidate/BaselineProposal，检查所有 evidenceIds、推断标记、预览与 baseVersion；保存 pending 后等待用户确认，再走现有 baseline/apply 与 Plan Engine。不得复用固定 Mock 模板并改 mode，也不得提前删除旧 pending。

本轮真实 smoke：2026-09-11，Provider→Python→知乎→compiler→adapter 成功，Planner 0、研究请求1、搜索2、编译2、证据2，status=ok、issues=[]。Windows进程树与离线HTTP流程已测试；真实Planner未调用，真实HTTP live未付费运行，Linux/macOS清理未执行。最终超时收尾修正以离线验证为准，未再重复付费 smoke。最新精确测试数与限制以 [状态记录](P0_INTEGRATION_STATUS.md) 为准。
