# Jia P0 源码摘录

来源：用户上传 `zhilu-p0-core-roadmap.zip`。分支 `codex/p0-core-roadmap`，提交 `daf3588c9fd85f4a1d1a9a089ef75dc2e66ef662`。

每段保留原文件行号。仅摘录接口和接入相关逻辑，不代表完整项目已通过验收。

## 01 — P0 实际范围

文件：`README.md`


行 28–36：

```text
  28 | ## 当前可运行纵切
  29 | 
  30 | Jia / Core 第一版已经跑通：
  31 | 
  32 | ```text
  33 | Demo Fixture → Plan Engine → 本地 API → Roadmap → Event → pending Diff → Commit
  34 | ```
  35 | 
  36 | 当前支持创建任意目标项目、6 个核心问题与 1 个条件化追问、User Context Card / Goal Contract 确认、Markdown/TXT 背景导入、本周焦点、节点编辑/改期/完成/新增/归档、节点级与时间约束事件、依据检查、确定性影响定位、Patch 审批、本地持久化、History，以及 JSON、Markdown、`.planbundle.zip` 导出。确认目标后先生成“研究准备版”；随后可用明确标注的 Mock Research 跑通 `Research Question → EvidencePack → 两条 Route → Roadmapper Draft → 用户确认 Baseline`。真实知乎执行器仍未合并，Mock 卡片不会伪装成知乎来源。
```

## 02 — 共享证据格式与 Python 原始格式

文件：`packages/contracts/src/index.ts`


行 19–86：

```text
  19 | export type EvidenceSourceType = "user" | "zhihu" | "official" | "engine" | "ai";
  20 | 
  21 | export type EvidenceContentType =
  22 |   | "user_fact"
  23 |   | "advice"
  24 |   | "experience"
  25 |   | "opinion"
  26 |   | "factual_claim"
  27 |   | "rule"
  28 |   | "ai_inference";
  29 | 
  30 | export type VerificationStatus = "verified" | "unverified" | "not_applicable";
  31 | 
  32 | export interface EvidenceCard {
  33 |   id: string;
  34 |   title: string;
  35 |   summary: string;
  36 |   sourceType: EvidenceSourceType;
  37 |   contentType: EvidenceContentType;
  38 |   verificationStatus: VerificationStatus;
  39 |   sourceTitle?: string;
  40 |   sourceUrl?: string;
  41 |   author?: string;
  42 |   publishedAt?: string;
  43 |   retrievedAt?: string;
  44 |   supportingQuote?: string;
  45 |   applicableWhen: string[];
  46 |   caveats: string[];
  47 |   riskTags: string[];
  48 |   adoptionReason: string;
  49 | }
  50 | 
  51 | /** 精确对应 origin/kylee-zhihu-agent 当前 evidence_compiler.py 的卡片输出。 */
  52 | export interface ZhihuCompiledEvidenceCard {
  53 |   id: string;
  54 |   source_id: string;
  55 |   source_url: string;
  56 |   source_title: string;
  57 |   source_scope: "search_snippet";
  58 |   claim: string;
  59 |   claim_type: "advice" | "experience" | "opinion" | "factual_claim";
  60 |   supporting_quote: string;
  61 |   quote_start: number;
  62 |   quote_end: number;
  63 |   citation_status: "exact_match";
  64 |   verification_status: "unverified";
  65 |   applies_when: string;
  66 |   applicability_basis: "ai_inference";
  67 |   caveats: string[];
  68 |   risk_flags: string[];
  69 | }
  70 | 
  71 | export interface ZhihuEvidenceCompilerOutput {
  72 |   compiler_version: string;
  73 |   status: "ok" | "no_evidence";
  74 |   reason: string;
  75 |   source: {
  76 |     id: string;
  77 |     provider: "zhihu";
  78 |     title: string;
  79 |     url: string;
  80 |     author: string;
  81 |     snippet: string;
  82 |     retrievedAt: string | null;
  83 |     source_scope: "search_snippet";
  84 |   };
  85 |   evidence_cards: ZhihuCompiledEvidenceCard[];
  86 | }
```

## 03 — 用户背景、目标和研究接口

文件：`packages/contracts/src/index.ts`


行 204–228：

```text
 204 | export interface UserContextCard {
 205 |   currentSituation: string;
 206 |   weeklyHours: number;
 207 |   constraints: string[];
 208 |   backgroundNotes?: string;
 209 |   confirmed: boolean;
 210 | }
 211 | 
 212 | export interface GoalContract {
 213 |   goal: string;
 214 |   targetDate: string;
 215 |   successCriteria: string[];
 216 |   nonGoals: string[];
 217 |   mustHaveOutcomes: string[];
 218 |   tradeoffs: string[];
 219 |   reviewCadence: "weekly" | "biweekly" | "monthly";
 220 |   confirmed: boolean;
 221 | }
 222 | 
 223 | export interface CreateProjectInput {
 224 |   userContext: UserContextCard;
 225 |   goalContract: GoalContract;
 226 |   adaptiveQuestion: string;
 227 |   adaptiveAnswer: string;
 228 | }
```


行 251–307：

```text
 251 | /** Query Planner 的输出。它只生成问题内容和检索 Query，不分配运行 ID。 */
 252 | export interface ResearchQuestionDraft {
 253 |   question: string;
 254 |   searchQueries: string[];
 255 |   rationale: string;
 256 | }
 257 | 
 258 | /** Workflow Controller 校验、补字段后交给 Research Subagent 执行的请求。 */
 259 | export interface ResearchRequest {
 260 |   id: string;
 261 |   question: string;
 262 |   searchQueries: string[];
 263 |   relevantUserConditions: string[];
 264 |   freshness?: string;
 265 |   evidenceLimit: number;
 266 | }
 267 | 
 268 | export interface EvidencePack {
 269 |   requestId: string;
 270 |   evidence: EvidenceCard[];
 271 |   routeCandidates: RouteCandidate[];
 272 |   unresolvedQuestions: string[];
 273 | }
 274 | 
 275 | export interface RouteCandidate {
 276 |   id: string;
 277 |   title: string;
 278 |   summary: string;
 279 |   applicableWhen: string[];
 280 |   evidenceIds: string[];
 281 |   risks: string[];
 282 | }
 283 | 
 284 | export interface ResearchRunResult {
 285 |   id: string;
 286 |   mode: "mock" | "live";
 287 |   generatedAt: string;
 288 |   questions: ResearchQuestionDraft[];
 289 |   requests: ResearchRequest[];
 290 |   evidencePacks: EvidencePack[];
 291 |   routeCandidates: RouteCandidate[];
 292 | }
 293 | 
 294 | export interface BaselineRoutePreview {
 295 |   routeId: string;
 296 |   plan: PlanState;
 297 | }
 298 | 
 299 | export interface BaselineProposal {
 300 |   id: string;
 301 |   projectId: string;
 302 |   baseVersion: number;
 303 |   createdAt: string;
 304 |   recommendedRouteId: string;
 305 |   researchRun: ResearchRunResult;
 306 |   previews: BaselineRoutePreview[];
 307 | }
```

## 04 — 已有证据转换器（不是进程调用器）

文件：`apps/server/src/zhihu-adapter.ts`


行 1–23：

```text
   1 | import type { EvidenceCard, ZhihuEvidenceCompilerOutput } from "@zhilu/contracts";
   2 | 
   3 | /** 将 Kyle 当前 Python 编译器的边界输出转换为 Plan 使用的 EvidenceCard。 */
   4 | export function adaptZhihuCompilerOutput(output: ZhihuEvidenceCompilerOutput): EvidenceCard[] {
   5 |   if (output.status === "no_evidence") return [];
   6 |   return output.evidence_cards.map((card) => ({
   7 |     id: card.id,
   8 |     title: card.source_title,
   9 |     summary: card.claim,
  10 |     sourceType: "zhihu",
  11 |     contentType: card.claim_type,
  12 |     verificationStatus: card.verification_status,
  13 |     sourceTitle: card.source_title,
  14 |     sourceUrl: card.source_url,
  15 |     author: output.source.author,
  16 |     ...(output.source.retrievedAt ? { retrievedAt: output.source.retrievedAt } : {}),
  17 |     supportingQuote: card.supporting_quote,
  18 |     applicableWhen: [card.applies_when],
  19 |     caveats: [...card.caveats],
  20 |     riskTags: [...card.risk_flags],
  21 |     adoptionReason: output.reason || "该主张直接回答当前研究问题",
  22 |   }));
  23 | }
```

## 05 — Query 数量和 Controller ID 分配

文件：`packages/agent-runtime/src/index.ts`


行 80–139：

```text
  80 | export interface AssembleResearchRequestsInput {
  81 |   questions: ResearchQuestionDraft[];
  82 |   relevantUserConditions: string[];
  83 |   freshness?: string;
  84 |   evidenceLimitPerQuestion: number;
  85 |   idFactory: (index: number) => string;
  86 | }
  87 | 
  88 | /**
  89 |  * Controller 边界：只校验 Query Planner 的输出并补充调度字段。
  90 |  * 这里不生成、改写或合并 Research Question。
  91 |  */
  92 | export function assembleResearchRequests(input: AssembleResearchRequestsInput): ResearchRequest[] {
  93 |   const validation = validateResearchQuestionDrafts(input.questions);
  94 |   const issues = [...validation.issues];
  95 |   if (!Number.isInteger(input.evidenceLimitPerQuestion) || input.evidenceLimitPerQuestion < 1 || input.evidenceLimitPerQuestion > 12) {
  96 |     issues.push({ code: "INVALID_EVIDENCE_LIMIT", message: "每个 Research Question 的 Evidence 上限必须是 1–12", path: "evidenceLimitPerQuestion" });
  97 |   }
  98 |   if (input.relevantUserConditions.some((condition) => !condition.trim())) {
  99 |     issues.push({ code: "EMPTY_USER_CONDITION", message: "相关用户条件不能是空字符串", path: "relevantUserConditions" });
 100 |   }
 101 |   if (issues.length > 0) throw new ResearchRequestValidationError(issues);
 102 | 
 103 |   return input.questions.map((question, index) => ({
 104 |     id: input.idFactory(index),
 105 |     question: question.question,
 106 |     searchQueries: [...question.searchQueries],
 107 |     relevantUserConditions: [...input.relevantUserConditions],
 108 |     ...(input.freshness ? { freshness: input.freshness } : {}),
 109 |     evidenceLimit: input.evidenceLimitPerQuestion,
 110 |   }));
 111 | }
 112 | 
 113 | export function validateResearchQuestionDrafts(questions: ResearchQuestionDraft[]): ValidationResult {
 114 |   const issues: ValidationIssue[] = [];
 115 |   if (questions.length < 1 || questions.length > 3) {
 116 |     issues.push({ code: "QUESTION_COUNT", message: "Query Planner 必须生成 1–3 个 Research Question", path: "questions" });
 117 |   }
 118 |   const totalQueryCount = questions.reduce((sum, question) => sum + question.searchQueries.length, 0);
 119 |   if (totalQueryCount < 6 || totalQueryCount > 10) {
 120 |     issues.push({ code: "QUERY_COUNT", message: "全部 Research Question 合计必须包含 6–10 个知乎检索 Query", path: "questions.searchQueries" });
 121 |   }
 122 |   const normalizedQuestions = new Set<string>();
 123 |   const normalizedQueries = new Set<string>();
 124 |   for (const [index, question] of questions.entries()) {
 125 |     const path = `questions.${index}`;
 126 |     if (!question.question.trim()) issues.push({ code: "EMPTY_QUESTION", message: "Research Question 不能为空", path: `${path}.question` });
 127 |     if (!question.rationale.trim()) issues.push({ code: "EMPTY_RATIONALE", message: "Research Question 必须说明为什么需要研究", path: `${path}.rationale` });
 128 |     const normalizedQuestion = normalizeText(question.question);
 129 |     if (normalizedQuestions.has(normalizedQuestion)) issues.push({ code: "DUPLICATE_QUESTION", message: "Research Question 不能重复", path: `${path}.question` });
 130 |     normalizedQuestions.add(normalizedQuestion);
 131 |     for (const [queryIndex, query] of question.searchQueries.entries()) {
 132 |       if (!query.trim()) issues.push({ code: "EMPTY_QUERY", message: "知乎检索 Query 不能为空", path: `${path}.searchQueries.${queryIndex}` });
 133 |       const normalizedQuery = normalizeText(query);
 134 |       if (normalizedQueries.has(normalizedQuery)) issues.push({ code: "DUPLICATE_QUERY", message: `知乎检索 Query 重复：${query}`, path: `${path}.searchQueries.${queryIndex}` });
 135 |       normalizedQueries.add(normalizedQuery);
 136 |     }
 137 |   }
 138 |   return { valid: issues.length === 0, issues };
 139 | }
```

## 06 — Mock 研究与写死的路线预览

文件：`packages/agent-runtime/src/index.ts`


行 255–325：

```text
 255 | export interface MockResearchInput {
 256 |   runId: string;
 257 |   proposalId: string;
 258 |   requestIdFactory: (index: number) => string;
 259 |   now: string;
 260 | }
 261 | 
 262 | /**
 263 |  * 在真实知乎执行器尚未接入时，用于验证 Controller → EvidencePack → Roadmapper 的产品闭环。
 264 |  * 所有卡片都明确标为 AI 推断，不提供虚构 URL，也不能冒充知乎证据。
 265 |  */
 266 | export function createMockBaselineProposal(plan: PlanState, input: MockResearchInput): BaselineProposal {
 267 |   if (!plan.userContext || !plan.goalContract) {
 268 |     throw new ResearchRequestValidationError([
 269 |       { code: "RESEARCH_CONTEXT_REQUIRED", message: "运行研究前需要已确认的 User Context Card 与 Goal Contract" },
 270 |     ]);
 271 |   }
 272 |   const goal = plan.goalContract.goal.trim();
 273 |   const success = plan.goalContract.successCriteria[0]?.trim() ?? "完成可检查成果";
 274 |   const questions: ResearchQuestionDraft[] = [
 275 |     {
 276 |       question: `从“${plan.userContext.currentSituation}”出发，达成“${goal}”通常要先补齐哪些关键能力？`,
 277 |       searchQueries: [`${goal} 入门 路线`, `${goal} 零基础 经验`, `${goal} 关键能力`],
 278 |       rationale: "先识别起点到目标之间的能力缺口，避免把通用清单直接当成个人路线。",
 279 |     },
 280 |     {
 281 |       question: `在每周 ${plan.weeklyHours} 小时和现有限制下，怎样用可检查成果验证“${success}”？`,
 282 |       searchQueries: [`${goal} 实践 项目`, `${goal} 学习 复盘`, `${goal} 常见错误`],
 283 |       rationale: "把建议转换成能按周执行、能验收、能根据反馈调整的任务。",
 284 |     },
 285 |   ];
 286 |   const requests = assembleResearchRequests({
 287 |     questions,
 288 |     relevantUserConditions: [
 289 |       plan.userContext.currentSituation,
 290 |       `每周可投入 ${plan.weeklyHours} 小时`,
 291 |       ...plan.userContext.constraints,
 292 |     ],
 293 |     evidenceLimitPerQuestion: 6,
 294 |     idFactory: input.requestIdFactory,
 295 |   });
 296 |   const evidence = buildMockEvidence(plan, success);
 297 |   const routes = buildMockRoutes(evidence);
 298 |   const evidencePacks: EvidencePack[] = requests.map((request, index) => ({
 299 |     requestId: request.id,
 300 |     evidence: evidence.slice(index * 3, index * 3 + 3),
 301 |     routeCandidates: index === 0 ? routes : [],
 302 |     unresolvedQuestions: ["等待真实知乎检索后验证适用条件、冲突观点与来源质量"],
 303 |   }));
 304 |   const researchRun: ResearchRunResult = {
 305 |     id: input.runId,
 306 |     mode: "mock",
 307 |     generatedAt: input.now,
 308 |     questions,
 309 |     requests,
 310 |     evidencePacks,
 311 |     routeCandidates: routes,
 312 |   };
 313 |   return {
 314 |     id: input.proposalId,
 315 |     projectId: plan.projectId,
 316 |     baseVersion: plan.version,
 317 |     createdAt: input.now,
 318 |     recommendedRouteId: routes[0]!.id,
 319 |     researchRun,
 320 |     previews: routes.map((route) => ({
 321 |       routeId: route.id,
 322 |       plan: buildRoutePreview(plan, researchRun, route, evidence, success, input.now),
 323 |     })),
 324 |   };
 325 | }
```


行 354–415：

```text
 354 | function buildMockRoutes(evidence: EvidenceCard[]): RouteCandidate[] {
 355 |   return [
 356 |     {
 357 |       id: "route-outcome",
 358 |       title: "先做出来",
 359 |       summary: "用一个最小但完整的成果尽早暴露问题，再按反馈补齐能力。",
 360 |       applicableWhen: ["成功标准清晰", "可以较早获得真实反馈"],
 361 |       evidenceIds: evidence.slice(0, 3).map((item) => item.id),
 362 |       risks: ["第一版质量可能粗糙", "Mock 推断仍需真实知乎来源验证"],
 363 |     },
 364 |     {
 365 |       id: "route-foundation",
 366 |       title: "先练基本功",
 367 |       summary: "先找出最影响终点的基础能力，通过重复练习后再完成整体验收。",
 368 |       applicableWhen: ["当前起点较早", "完整成果失败成本较高"],
 369 |       evidenceIds: evidence.slice(3).map((item) => item.id),
 370 |       risks: ["容易迟迟不进入真实场景", "Mock 推断仍需真实知乎来源验证"],
 371 |     },
 372 |   ];
 373 | }
 374 | 
 375 | function buildRoutePreview(
 376 |   plan: PlanState,
 377 |   run: ResearchRunResult,
 378 |   route: RouteCandidate,
 379 |   mockEvidence: EvidenceCard[],
 380 |   success: string,
 381 |   now: string,
 382 | ): PlanState {
 383 |   const start = now.slice(0, 10);
 384 |   const end = plan.goalContract?.targetDate ?? dateAtFraction(start, start, 1);
 385 |   const first = dateAtFraction(start, end, 0.3);
 386 |   const second = dateAtFraction(start, end, 0.72);
 387 |   const baseEvidence = plan.evidence.filter((item) => item.sourceType === "user");
 388 |   const evidenceIds = route.evidenceIds;
 389 |   const outcomeFirst = route.id === "route-outcome";
 390 |   const nodes: PlanNode[] = [
 391 |     starterMilestone("m-baseline", outcomeFirst ? "做出第一个可见成果" : "补齐最关键的基本功", "in_progress", start, first, evidenceIds),
 392 |     starterTask("t-baseline", outcomeFirst ? `定义最小成果：${success.slice(0, 28)}` : "识别并练习最影响终点的基础动作", "ready", "m-baseline", start, first, Math.max(2, Math.round(plan.weeklyHours * 0.35)), outcomeFirst ? "一份可以展示和获取反馈的最小成果" : "一组带记录的基础练习与自测结果", ["产出可以被检查", "记录至少一个暴露出的能力缺口"], evidenceIds),
 393 |     starterMilestone("m-feedback", "让现实给路线反馈", "todo", first, second, evidenceIds),
 394 |     starterTask("t-feedback", outcomeFirst ? "完成一轮真实反馈并补最短板" : "把基本功组合成一次完整演练", "todo", "m-feedback", first, second, Math.max(2, Math.round(plan.weeklyHours * 0.4)), "一次完整实践、反馈记录和下一轮调整", ["有外部或真实场景反馈", "明确保留、停止和调整的内容"], evidenceIds),
 395 |     starterMilestone("m-arrival", "抵达与验收", "todo", second, end, [...evidenceIds, "e-user-goal"]),
 396 |     starterTask("t-arrival", `按真实场景验收：${success.slice(0, 30)}`, "todo", "m-arrival", second, end, Math.max(2, Math.round(plan.weeklyHours * 0.25)), success, [success, `在 ${end} 前完成一次完整验收`], [...evidenceIds, "e-user-goal"]),
 397 |   ];
 398 |   return {
 399 |     ...structuredClone(plan),
 400 |     version: plan.version + 1,
 401 |     currentCommitId: String(plan.version + 1).padStart(6, "0"),
 402 |     nodes,
 403 |     relations: [
 404 |       { id: "r-feedback-after-baseline", type: "depends_on", sourceId: "t-feedback", targetId: "t-baseline" },
 405 |       { id: "r-arrival-after-feedback", type: "depends_on", sourceId: "t-arrival", targetId: "t-feedback" },
 406 |     ],
 407 |     evidence: [...baseEvidence, ...mockEvidence],
 408 |     research: {
 409 |       mode: run.mode,
 410 |       runId: run.id,
 411 |       selectedRouteId: route.id,
 412 |       routeCandidates: structuredClone(run.routeCandidates),
 413 |     },
 414 |     updatedAt: now,
 415 |   };
```

## 07 — 保存提案与正式应用接口

文件：`apps/server/src/index.ts`


行 114–173：

```text
 114 |   const mockResearchMatch = pathname.match(/^\/api\/projects\/([^/]+)\/research\/mock$/);
 115 |   if (request.method === "POST" && mockResearchMatch) {
 116 |     const projectId = decodeURIComponent(requiredMatch(mockResearchMatch, 1));
 117 |     const plan = await planRepository.getPlan(projectId);
 118 |     if (!plan.evidence.some((item) => item.riskTags.includes("等待知乎研究"))) {
 119 |       throw new HttpError(409, "当前项目已经有 Baseline；需要新研究时请从 knowledge_gap Event 发起");
 120 |     }
 121 |     for (const existing of await planRepository.getBaselineProposals(projectId)) {
 122 |       await planRepository.removeBaselineProposal(projectId, existing.id);
 123 |     }
 124 |     const now = new Date().toISOString();
 125 |     const proposal = createMockBaselineProposal(plan, {
 126 |       runId: uniqueId("research"),
 127 |       proposalId: uniqueId("baseline"),
 128 |       requestIdFactory: (index) => `rq-${String(index + 1).padStart(2, "0")}-${crypto.randomUUID().slice(0, 6)}`,
 129 |       now,
 130 |     });
 131 |     for (const preview of proposal.previews) {
 132 |       const validation = validatePlan(preview.plan);
 133 |       if (!validation.valid) throw new PlanEngineError(validation.issues);
 134 |     }
 135 |     await planRepository.saveBaselineProposal(projectId, proposal);
 136 |     sendJson(response, 202, proposal);
 137 |     return;
 138 |   }
 139 | 
 140 |   const baselineApplyMatch = pathname.match(/^\/api\/projects\/([^/]+)\/baseline\/apply$/);
 141 |   if (request.method === "POST" && baselineApplyMatch) {
 142 |     const projectId = decodeURIComponent(requiredMatch(baselineApplyMatch, 1));
 143 |     const { proposalId, routeId } = await readBody<{ proposalId: string; routeId: string }>(request);
 144 |     const proposal = (await planRepository.getBaselineProposals(projectId)).find((item) => item.id === proposalId);
 145 |     if (!proposal) throw new HttpError(404, `Baseline 提案不存在：${proposalId}`);
 146 |     const plan = await planRepository.getPlan(projectId);
 147 |     const now = new Date().toISOString();
 148 |     const next = applyBaselineProposal(plan, proposal, routeId, now);
 149 |     const route = proposal.researchRun.routeCandidates.find((item) => item.id === routeId);
 150 |     const commit = createCommit(plan, next, {
 151 |       id: next.currentCommitId,
 152 |       createdAt: now,
 153 |       actor: "user",
 154 |       reason: `用户确认 Mock Research 路线：${route?.title ?? routeId}`,
 155 |     });
 156 |     await planRepository.savePlan(next);
 157 |     await planRepository.saveCommit(projectId, commit);
 158 |     await planRepository.removeBaselineProposal(projectId, proposal.id);
 159 |     sendJson(response, 200, {
 160 |       plan: next,
 161 |       view: projectView(next),
 162 |       history: await planRepository.getHistory(projectId),
 163 |       pending: await planRepository.getPending(projectId),
 164 |       baselineProposals: [],
 165 |     });
 166 |     return;
 167 |   }
 168 | 
 169 |   const evidenceMatch = pathname.match(/^\/api\/projects\/([^/]+)\/evidence$/);
 170 |   if (request.method === "GET" && evidenceMatch) {
 171 |     const plan = await planRepository.getPlan(decodeURIComponent(requiredMatch(evidenceMatch, 1)));
 172 |     sendJson(response, 200, { evidence: plan.evidence });
 173 |     return;
```

## 08 — 前端仍调用 Mock

文件：`apps/web/src/App.tsx`


行 259–270：

```text
 259 |   const runMockResearch = async () => {
 260 |     setBusy(true);
 261 |     setError(null);
 262 |     try {
 263 |       const proposal = await api<BaselineProposal>(`/api/projects/${activeProjectId}/research/mock`, { method: "POST" });
 264 |       setBaselineProposal(proposal);
 265 |       setSelectedRouteId(proposal.recommendedRouteId);
 266 |     } catch (requestError) {
 267 |       setError(toMessage(requestError));
 268 |     } finally {
 269 |       setBusy(false);
 270 |     }
```


行 369–393：

```text
 369 |       {showOnboarding && <Onboarding busy={busy} error={error} onClose={() => { setShowOnboarding(false); setError(null); }} onCreate={(input) => void createProject(input)} />}
 370 |       {showResearch && (
 371 |         <ResearchStudio
 372 |           proposal={baselineProposal}
 373 |           selectedRouteId={selectedRouteId}
 374 |           busy={busy}
 375 |           onClose={() => setShowResearch(false)}
 376 |           onRun={() => void runMockResearch()}
 377 |           onSelectRoute={setSelectedRouteId}
 378 |           onApply={() => void applyBaseline()}
 379 |         />
 380 |       )}
 381 |     </div>
 382 |   );
 383 | }
 384 | 
 385 | function ResearchStudio({ proposal, selectedRouteId, busy, onClose, onRun, onSelectRoute, onApply }: { proposal: BaselineProposal | null; selectedRouteId: string | null; busy: boolean; onClose: () => void; onRun: () => void; onSelectRoute: (routeId: string) => void; onApply: () => void }) {
 386 |   if (!proposal) {
 387 |     return <div className="research-backdrop"><section className="research-intro" role="dialog" aria-modal="true" aria-labelledby="research-title"><button className="research-close" onClick={onClose}>×</button><div className="research-constellation"><span>问</span><i /><i /><i /></div><p className="section-kicker">Research Subagent · Mock mode</p><h2 id="research-title">先让证据回来，<br />再决定走哪条路。</h2><p>Query Planner 会根据你的目标与限制生成研究问题；Controller 只负责校验和调度。当前尚未合并真实知乎执行器，这次会用清楚标记的 Mock Evidence 跑通产品闭环。</p><div className="research-steps"><span><b>01</b>拆出研究问题</span><span><b>02</b>比较两条路线</span><span><b>03</b>你确认后写入图</span></div><div className="mock-warning">不会生成虚构知乎链接；所有结果都标记为未验证 AI 推断。</div><button className="research-primary" disabled={busy} onClick={onRun}>{busy ? "正在让问题穿过研究层…" : "运行 Mock Research"}<span>→</span></button></section></div>;
 388 |   }
 389 |   const route = proposal.researchRun.routeCandidates.find((item) => item.id === selectedRouteId) ?? proposal.researchRun.routeCandidates[0];
 390 |   const preview = proposal.previews.find((item) => item.routeId === route?.id)?.plan;
 391 |   const evidenceCount = proposal.researchRun.evidencePacks.reduce((sum, pack) => sum + pack.evidence.length, 0);
 392 |   const queryCount = proposal.researchRun.questions.reduce((sum, question) => sum + question.searchQueries.length, 0);
 393 |   return <div className="research-backdrop"><section className="route-lab" role="dialog" aria-modal="true" aria-labelledby="route-lab-title"><button className="research-close" onClick={onClose}>×</button><header><div><p className="section-kicker">Roadmapper Draft · 尚未写入</p><h2 id="route-lab-title">哪条路更像你的路？</h2></div><div className="research-metrics"><span><b>{proposal.researchRun.questions.length}</b>问题</span><span><b>{queryCount}</b>Queries</span><span><b>{evidenceCount}</b>Mock Cards</span></div></header><div className="route-lab-grid"><section className="question-rail"><p className="section-kicker">研究问了什么</p>{proposal.researchRun.questions.map((question, index) => <article key={question.question}><span>0{index + 1}</span><p>{question.question}</p><small>{question.rationale}</small></article>)}<div className="mock-stamp">MOCK / UNVERIFIED</div></section><section className="route-choice"><p className="section-kicker">选择路线</p>{proposal.researchRun.routeCandidates.map((candidate) => <button key={candidate.id} className={candidate.id === route?.id ? "is-selected" : ""} onClick={() => onSelectRoute(candidate.id)}><span className="route-radio" /><div><small>{candidate.id === proposal.recommendedRouteId ? "推荐起点" : "另一种节奏"}</small><h3>{candidate.title}</h3><p>{candidate.summary}</p><em>适合：{candidate.applicableWhen.join(" · ")}</em></div></button>)}</section><section className="preview-rail"><p className="section-kicker">图会变成这样</p>{preview?.nodes.filter((node) => node.type === "task").map((node, index) => <article key={node.id}><span>{index + 1}</span><div><strong>{node.title}</strong><small>{node.deliverable}</small></div></article>)}<div className="preview-note">应用后生成 v{preview?.currentCommitId}。原研究准备版仍保留在版本历史中。</div></section></div><footer><div><span className="route-proof-dot" /><small>这是机制演示，不是已验证的知乎研究结论。</small></div><button className="research-primary" disabled={busy || !selectedRouteId} onClick={onApply}>{busy ? "正在写入路线…" : `选择“${route?.title ?? "这条路线"}”并点亮图`}<span>→</span></button></footer></section></div>;
```

## 09 — 引擎应用边界

文件：`packages/plan-engine/src/index.ts`


行 295–321：

```text
 295 | export function applyBaselineProposal(
 296 |   plan: PlanState,
 297 |   proposal: BaselineProposal,
 298 |   routeId: string,
 299 |   updatedAt: string,
 300 | ): PlanState {
 301 |   if (proposal.projectId !== plan.projectId) {
 302 |     throw new PlanEngineError([issue("PROJECT_MISMATCH", "Baseline 提案不属于当前项目", "projectId")]);
 303 |   }
 304 |   if (proposal.baseVersion !== plan.version) {
 305 |     throw new PlanEngineError([
 306 |       issue("VERSION_CONFLICT", `Baseline 基于版本 ${proposal.baseVersion}，当前版本是 ${plan.version}`, "baseVersion"),
 307 |     ]);
 308 |   }
 309 |   const preview = proposal.previews.find((item) => item.routeId === routeId);
 310 |   if (!preview) {
 311 |     throw new PlanEngineError([issue("UNKNOWN_ROUTE", `候选路线不存在：${routeId}`, "routeId")]);
 312 |   }
 313 |   const next = structuredClone(preview.plan);
 314 |   if (next.projectId !== plan.projectId || next.research?.runId !== proposal.researchRun.id || next.research.selectedRouteId !== routeId) {
 315 |     throw new PlanEngineError([issue("BASELINE_PREVIEW_MISMATCH", "Baseline 预览与当前项目、研究运行或所选路线不一致", "previews")]);
 316 |   }
 317 |   next.version = plan.version + 1;
 318 |   next.currentCommitId = String(next.version).padStart(6, "0");
 319 |   next.updatedAt = updatedAt;
 320 |   assertValid(validatePlan(next));
 321 |   return next;
```
