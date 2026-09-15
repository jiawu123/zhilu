/** Explicit local M2 acceptance; default fixtures never contact a service. */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { assembleResearchRequests } from '@zhilu/agent-runtime';
import { createZhihuProvider, readZhihuProviderConfig, ZhihuProviderError, type ZhihuProvider } from '../src/zhihu-provider';
import { validateResearchInput, type ResearchProviderResult } from '../src/zhihu-boundary';

type Context = { goal: string; user_context: Record<string, unknown> };
type Save = (name: string, value: unknown) => Promise<unknown>;
type Run = { runId?: string; requestId: string; status: string; durationMs?: number;
  evidenceCount?: number; researchCandidateCount?: number; metrics?: Record<string, number> };
type Failure = { code: string; upstreamCode?: string; metrics?: Record<string, number>; cleanupError?: string };
interface Acceptance {
  status: 'ok' | 'no_evidence' | 'partial' | 'failed' | 'needs_clarification';
  planner?: { status: string; durationMs: number; runId?: string; metrics?: Record<string, number> };
  questionCount: number;
  plannedQueryCount: number;
  calls: { planner: number; search: number; batch: number; compiler: number };
  coldRuns: Run[];
  cacheRuns: Run[];
  globalEvidence: { uniqueCards: number; withinSixToEight: boolean; hasCaveat: boolean; sourceUrlCap: boolean; knownAuthorCap: boolean };
  failure?: Failure;
  failedStage?: 'plan' | 'research' | 'cache';
  failedRequestId?: string;
  failedStageDurationMs?: number;
}
const metricNames = ['planner_calls_attempted', 'search_calls_attempted', 'compiler_calls_attempted',
  'batch_model_calls_attempted', 'model_calls_attempted', 'candidate_count', 'evidence_count',
  'raw_item_count', 'valid_occurrence_count', 'variant_count', 'cache_hit', 'cache_write_success',
  'saved_search_calls', 'saved_model_calls', 'search_duration_ms', 'batch_duration_ms', 'total_duration_ms'] as const;
const upstreamCodes = new Set(['invalid_arguments', 'invalid_json', 'input_too_large', 'input_io_error',
  'invalid_request', 'dependency_unavailable', 'invalid_plan_output', 'llm_error', 'execution_error',
  'output_io_error', 'interrupted', 'research_failed', 'compilation_failed', 'configuration_error',
  'authentication_failed', 'rate_or_quota_limit', 'evidence_id_conflict', 'research_timeout']);
class AcceptanceFailure extends Error {
  constructor(readonly code: string) { super(code); }
}
function ensure(condition: unknown, code: string): asserts condition {
  if (!condition) throw new AcceptanceFailure(code);
}
function safeMetrics(metrics: Record<string, number> = {}): Record<string, number> {
  return Object.fromEntries(metricNames.flatMap(name => {
    const value = metrics[name];
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? [[name, value]] : [];
  }));
}
function safeFailure(error: unknown): Failure {
  if (error instanceof AcceptanceFailure) return { code: error.code };
  if (error instanceof ZhihuProviderError) return {
    code: error.code,
    ...(error.upstreamCode && upstreamCodes.has(error.upstreamCode) ? { upstreamCode: error.upstreamCode } : {}),
    ...(error.metrics ? { metrics: safeMetrics(error.metrics) } : {}),
    ...(error.cleanupError === 'cleanup_failed' ? { cleanupError: error.cleanupError } : {}),
  };
  return { code: 'acceptance_input_or_local_io_failed' };
}
function runSummary(result: ResearchProviderResult, durationMs: number): Run {
  return { runId: result.runId, requestId: result.pack.requestId, status: result.status, durationMs,
    evidenceCount: result.pack.evidence.length, researchCandidateCount: result.pack.routeCandidates.length,
    metrics: safeMetrics(result.metrics) };
}

/** Testable budget guard. cachedProvider MUST be configured for cache-only reads. */
export async function executeLiveAcceptance(provider: ZhihuProvider, cachedProvider: ZhihuProvider,
  context: Context, save: Save): Promise<Acceptance> {
  const report: Acceptance = { status: 'failed', questionCount: 0, plannedQueryCount: 0,
    calls: { planner: 0, search: 0, batch: 0, compiler: 0 }, coldRuns: [], cacheRuns: [],
    globalEvidence: { uniqueCards: 0, withinSixToEight: false, hasCaveat: false, sourceUrlCap: true, knownAuthorCap: true } };
  const cards = new Map<string, ResearchProviderResult['pack']['evidence'][number]>();
  let activeStage: { name: 'plan' | 'research' | 'cache'; started: number; requestId?: string } | undefined;
  try {
    const started = performance.now();
    activeStage = { name: 'plan', started };
    report.calls.planner += 1;
    const plan = await provider.planForBaseline(context);
    report.planner = { status: plan.status, durationMs: Math.round(performance.now() - started),
      ...('runId' in plan && typeof plan.runId === 'string' ? { runId: plan.runId } : {}),
      ...('metrics' in plan && plan.metrics && typeof plan.metrics === 'object' ? { metrics: safeMetrics(plan.metrics as Record<string, number>) } : {}) };
    await save('planner.json', plan);
    activeStage = undefined;
    if (plan.status === 'needs_clarification') {
      report.status = 'needs_clarification';
      return report;
    }
    const requests = assembleResearchRequests({ questions: plan.questions, queryPolicy: 'initial',
      relevantUserConditions: ['合成演示用户：已有 Python 函数与列表基础，每周可投入10小时，期限8周。'],
      evidenceLimitPerQuestion: 8, idFactory: index => `rq-m2-cold-${index}-${randomUUID()}` });
    report.questionCount = requests.length;
    report.plannedQueryCount = requests.reduce((count, request) => count + request.searchQueries.length, 0);
    ensure(requests.length <= 3 && report.plannedQueryCount >= 2 && report.plannedQueryCount <= 3, 'initial_query_budget_failed');
    // Persist Controller-allocated IDs before any request is sent. This records
    // future runs only; failed historical runs must never receive invented IDs.
    await save('requests.json', requests);
    for (let index = 0; index < requests.length; index += 1) {
      const request = requests[index]!;
      ensure(report.calls.search + request.searchQueries.length <= 3 && report.calls.batch < 3, 'live_call_budget_exhausted');
      const researchStarted = performance.now();
      activeStage = { name: 'research', started: researchStarted, requestId: request.id };
      const result = await provider.researchOne({ ...context, request });
      const summary = runSummary(result, Math.round(performance.now() - researchStarted));
      report.coldRuns.push(summary);
      report.calls.search += result.metrics.search_calls_attempted ?? 0;
      report.calls.batch += result.metrics.batch_model_calls_attempted ?? 0;
      report.calls.compiler += result.metrics.compiler_calls_attempted ?? 0;
      ensure((result.metrics.planner_calls_attempted ?? 0) === 0 && report.calls.search <= 3
        && report.calls.batch <= 3 && report.calls.compiler === 0, 'live_call_budget_exceeded');
      ensure(result.pack.requestId === request.id, 'request_id_changed');
      await save(`cold-${index}.json`, result);
      activeStage = undefined;
      for (const card of result.pack.evidence) cards.set(card.id, card);
      if (result.status === 'partial') {
        report.cacheRuns.push({ requestId: request.id, status: 'not_attempted_partial' });
        break;
      }
      if (result.metrics.cache_write_success !== 1) {
        report.cacheRuns.push({ requestId: request.id, status: 'not_attempted_cache_unavailable' });
        continue;
      }
      const cachedRequest = { ...request, id: `rq-m2-cache-${index}-${randomUUID()}` };
      await save(`cache-request-${index}.json`, cachedRequest);
      const hitStarted = performance.now();
      activeStage = { name: 'cache', started: hitStarted, requestId: cachedRequest.id };
      const hit = await cachedProvider.researchOne({ ...context, request: cachedRequest });
      const hitSummary = { ...runSummary(hit, Math.round(performance.now() - hitStarted)), status: 'unexpected_result' };
      report.cacheRuns.push(hitSummary);
      report.calls.search += hit.metrics.search_calls_attempted ?? 0;
      report.calls.batch += hit.metrics.batch_model_calls_attempted ?? 0;
      report.calls.compiler += hit.metrics.compiler_calls_attempted ?? 0;
      report.calls.planner += hit.metrics.planner_calls_attempted ?? 0;
      // Dedicated cache-only Provider makes cache corruption/miss fail before
      // search. This check also detects a regression in that production guard.
      ensure(hit.metrics.cache_hit === 1 && (hit.metrics.search_calls_attempted ?? 0) === 0
        && (hit.metrics.compiler_calls_attempted ?? 0) === 0 && (hit.metrics.batch_model_calls_attempted ?? 0) === 0
        && (hit.metrics.planner_calls_attempted ?? 0) === 0 && hit.pack.requestId === cachedRequest.id,
      'cache_reuse_contract_failed');
      ensure(hit.status === result.status
        && isDeepStrictEqual(hit.pack, { ...result.pack, requestId: cachedRequest.id }), 'cache_evidence_changed');
      hitSummary.status = 'hit';
      await save(`cache-${index}.json`, hit);
      activeStage = undefined;
    }
    const urls = new Map<string, number>();
    const authors = new Map<string, number>();
    for (const card of cards.values()) {
      if (card.sourceUrl) urls.set(card.sourceUrl, (urls.get(card.sourceUrl) ?? 0) + 1);
      const author = card.author?.trim().toLowerCase().replace(/ß/g, 'ss').replace(/ς/g, 'σ');
      if (author) authors.set(author, (authors.get(author) ?? 0) + 1);
    }
    report.globalEvidence = { uniqueCards: cards.size, withinSixToEight: cards.size >= 6 && cards.size <= 8,
      hasCaveat: [...cards.values()].some(card => Boolean(card.caveats?.length)),
      sourceUrlCap: [...urls.values()].every(count => count <= 2), knownAuthorCap: [...authors.values()].every(count => count <= 3) };
    report.status = report.coldRuns.some(run => run.status === 'partial') ? 'partial' : cards.size ? 'ok' : 'no_evidence';
  } catch (error) {
    report.status = 'failed';
    report.failure = safeFailure(error);
    if (activeStage) {
      report.failedStage = activeStage.name;
      report.failedStageDurationMs = Math.max(0, Math.round(performance.now() - activeStage.started));
      if (activeStage.requestId) report.failedRequestId = activeStage.requestId;
    }
    const failedMetrics = report.failure.metrics;
    if (failedMetrics) {
      report.calls.search += failedMetrics.search_calls_attempted ?? 0;
      report.calls.batch += failedMetrics.batch_model_calls_attempted ?? 0;
      report.calls.compiler += failedMetrics.compiler_calls_attempted ?? 0;
    }
  }
  return report;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log('Usage: test_m2_followup.ts [--live] [--output <directory under packages/zhihu/artifacts>]\nDefault: two offline Python batch fixtures through the real Provider and adapter.\n--live: at most one real Planner, three searches and three batch model calls; cache repeats are read-only.\nCredentials stay in the existing environment or packages/zhihu/.env. No M3, Plan or History writes.');
    return;
  }
  let live = false;
  let requestedOutput: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--live' && !live) live = true;
    else if (args[index] === '--output' && !requestedOutput && args[index + 1]) requestedOutput = args[++index];
    else throw new AcceptanceFailure('invalid_arguments');
  }
  const root = resolve(import.meta.dirname, '../../..');
  const artifacts = resolve(root, 'packages/zhihu/artifacts');
  const outputDir = requestedOutput ? resolve(requestedOutput) : resolve(artifacts, `m2-followup-${randomUUID()}`);
  const subdirectory = relative(artifacts, outputDir);
  ensure(subdirectory && !isAbsolute(subdirectory) && subdirectory !== '..'
    && !subdirectory.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`), 'output_must_be_an_artifact_subdirectory');
  const config = readZhihuProviderConfig({ ...process.env,
    ZHIHU_PYTHON_BIN: process.env.ZHIHU_PYTHON_BIN || resolve(root, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python'),
    ZHIHU_PYTHON_CWD: process.env.ZHIHU_PYTHON_CWD || resolve(root, 'packages/zhihu'),
    ZHIHU_PLANNING_PROFILE: 'm2-initial',
  });
  await mkdir(outputDir, { recursive: true });
  const save: Save = (name, value) => writeFile(resolve(outputDir, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const base = { mode: live ? 'live' : 'offline', startedAt, humanReview: 'needs_human_review',
    syntheticUserContext: true, formalRoadmapComplete: false, m3Acceptance: 'not_run_jia_final_environment_required',
    performanceClaim: 'single_run_no_stability_or_p95_claim', limits: { planner: 1, search: 3, batch: 3, evidencePerRequest: 8 } };
  try {
    if (!live) {
      const runs: Run[] = [];
      for (const domain of ['programming', 'writing'] as const) {
        const provider = createZhihuProvider({ ...config, timeoutMs: 20_000,
          env: { PYTHON_DOTENV_DISABLED: '1', DEEPSEEK_API_KEY: '', ZHIHU_ACCESS_SECRET: '', ZHIHU_RETRIEVAL_PROFILE: 'batch-v1' } }, {
          spawn: (executable, args, options) => {
            ensure(args.includes('research'), 'offline_fixture_action_invalid');
            return spawn(executable, ['-X', 'utf8', '-B', '-u', '-m', 'tests.fixtures.batch_boundary_offline', domain, '--provider'],
              { ...options, stdio: 'pipe' });
          },
        });
        const input = validateResearchInput({ goal: domain === 'writing' ? '完成一篇结构清晰的短文。' : '完成一个有测试的小程序。',
          user_context: { is_synthetic_demo: true }, request: { id: `offline-${domain}-🧪`,
            question: domain === 'writing' ? '怎样安排提纲和初稿的顺序？' : '怎样安排编码和测试的顺序？',
            searchQueries: [domain === 'writing' ? '写作 提纲 顺序' : '编程 测试 顺序'], relevantUserConditions: [], evidenceLimit: 8 } });
        const requestStarted = performance.now();
        const result = await provider.researchOne(input);
        ensure(result.pack.evidence.length === 8 && result.pack.routeCandidates.length === 2
          && result.pack.evidence.every(card => card.verificationStatus === 'unverified'
            && card.riskTags?.includes('semantic_support_not_checked')), 'offline_batch_adapter_failed');
        runs.push(runSummary(result, Math.round(performance.now() - requestStarted)));
        await save(`offline-${domain}.json`, result);
      }
      const report = { ...base, ok: true, finishedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - started),
        calls: { realPlanner: 0, realSearch: 0, realBatch: 0, offlineBatchWorker: 2 }, runs };
      await save('report.json', report);
      console.log(JSON.stringify({ ...report, outputDir }, null, 2));
      return;
    }
    const example: unknown = JSON.parse(await readFile(resolve(root, 'packages/zhihu/examples/planner_request.json'), 'utf8'));
    const demo = validateResearchInput({ ...(typeof example === 'object' && example !== null ? example : {}),
      request: { id: 'validate-demo', question: '怎样完成并测试小程序？', searchQueries: ['程序 测试'], relevantUserConditions: [], evidenceLimit: 8 } });
    const context: Context = { goal: demo.goal, user_context: { ...demo.user_context, is_synthetic_demo: true,
      current_ability: '能编写 Python 函数并使用列表与字典，还没有独立完成带自动化测试的项目。',
      target_artifact: '可在本地运行的最小 Agent 演示，附可重复运行的基本测试和使用说明。',
      duration_weeks: 8, weekly_hours: 10, budget: '使用免费本地工具；研究API费用由既有测试预算承担。',
      success_criteria: ['能独立运行和修改一个功能', '至少3个固定样例的测试可重复通过'],
      constraints: ['目标仅为练习，不对外部署，不接触真实用户数据'],
    } };
    const cacheDir = resolve(outputDir, `cache-${randomUUID()}`);
    const env = { ZHIHU_RETRIEVAL_PROFILE: 'batch-v1', ZHIHU_SEARCH_LIMIT_PER_QUERY: '5',
      ZHIHU_PLANNER_DIAGNOSTIC_FILE: resolve(outputDir, 'planner-diagnostic.json'),
      ZHIHU_BATCH_DIAGNOSTIC_DIR: resolve(outputDir, 'batch-diagnostics'),
      ZHIHU_COMPILER_MAX_CALLS: '3', ZHIHU_RESEARCH_DEADLINE_SECONDS: '600',
      ZHIHU_EVIDENCE_CACHE_ENABLED: 'true', ZHIHU_EVIDENCE_CACHE_DIR: cacheDir,
      ZHIHU_EVIDENCE_CACHE_ONLY: 'false', PYTHON_DOTENV_DISABLED: '0' };
    const provider = createZhihuProvider({ ...config, env });
    const cachedProvider = createZhihuProvider({ ...config, env: { ...env, ZHIHU_EVIDENCE_CACHE_ONLY: 'true' } });
    const acceptance = await executeLiveAcceptance(provider, cachedProvider, context, save);
    const diagnostic = await readFile(env.ZHIHU_PLANNER_DIAGNOSTIC_FILE, 'utf8')
      .then(value => JSON.parse(value) as { status: string; validation_message?: string;
        planned_query_count?: number; query_selection?: unknown })
      .catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    const batchFolders = await readdir(env.ZHIHU_BATCH_DIAGNOSTIC_DIR, { withFileTypes: true })
      .catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    const batchDiagnostics = await Promise.all(batchFolders.filter(entry => entry.isDirectory()).map(async entry => {
      const path = resolve(env.ZHIHU_BATCH_DIAGNOSTIC_DIR, entry.name, 'report.json');
      const summary = JSON.parse(await readFile(path, 'utf8'));
      return { path, status: summary.status, stage: summary.stage, errorCode: summary.error_code,
        errorType: summary.error_type, itemErrors: summary.item_errors, validItemCount: summary.valid_item_count };
    }));
    const report = { ...base, ...acceptance, ok: acceptance.status !== 'failed',
      batchDiagnostics,
      ...(diagnostic ? { plannerDiagnostic: { status: diagnostic.status,
        validationMessage: diagnostic.validation_message, plannedQueryCount: diagnostic.planned_query_count,
        querySelection: diagnostic.query_selection } } : {}),
      finishedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - started) };
    await save('report.json', report);
    console.log(JSON.stringify({ ...report, outputDir }, null, 2));
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    const report = { ...base, ok: false, failure: safeFailure(error), finishedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - started) };
    await save('report.json', report);
    console.error(JSON.stringify({ ...report, outputDir }, null, 2));
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch(error => {
    console.error(JSON.stringify({ ok: false, failure: safeFailure(error) }));
    process.exitCode = 1;
  });
}
