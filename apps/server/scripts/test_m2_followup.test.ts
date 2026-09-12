import { describe, expect, it, vi } from 'vitest';
import { executeLiveAcceptance } from './test_m2_followup';
import { ZhihuProviderError, type ZhihuProvider } from '../src/zhihu-provider';
import type { ResearchProviderResult } from '../src/zhihu-boundary';

const context = { goal: '完成小程序', user_context: { is_synthetic_demo: true } };
function fake(options: { clarification?: boolean; queries?: string[]; error?: boolean; cache?: boolean; partial?: boolean } = {}) {
  const calls = { plan: 0, research: 0, hits: 0, saved: 0 };
  const provider: ZhihuProvider = {
    async planForBaseline() {
      calls.plan += 1;
      return options.clarification ? { status: 'needs_clarification', questions: [], clarificationQuestions: ['目标是什么？'] }
        : { status: 'ready_for_review', questions: [{ question: '如何检验结果？', searchQueries: options.queries ?? ['输入 检查', '输出 检查'], rationale: '需要方法' }], clarificationQuestions: [] };
    },
    async researchOne(input) {
      calls.research += 1;
      if (options.error) {
        const failure = new ZhihuProviderError('process_failed');
        failure.upstreamCode = 'authentication_failed';
        throw failure;
      }
      return { runId: 'offline-test', status: options.partial ? 'partial' : 'no_evidence',
        pack: { requestId: input.request.id, evidence: [], routeCandidates: [], unresolvedQuestions: [] }, issues: [],
        metrics: { search_calls_attempted: 2, compiler_calls_attempted: 0, batch_model_calls_attempted: 1,
          planner_calls_attempted: 0, cache_write_success: options.cache ? 1 : 0 } };
    },
  };
  const cachedProvider: ZhihuProvider = { ...provider, async researchOne(input) {
    calls.hits += 1;
    return { runId: 'offline-cache', status: 'no_evidence', pack: { requestId: input.request.id,
      evidence: [], routeCandidates: [], unresolvedQuestions: [] }, issues: [],
      metrics: { cache_hit: 1, search_calls_attempted: 0, compiler_calls_attempted: 0, batch_model_calls_attempted: 0 } };
  } };
  return { calls, provider, cachedProvider, save: async (_name: string, _value: unknown) => { calls.saved += 1; } };
}

describe('explicit M2 live acceptance budget guards (offline doubles)', () => {
  it('does not retry the Planner when clarification is needed', async () => {
    const f = fake({ clarification: true });
    const result = await executeLiveAcceptance(f.provider, f.cachedProvider, context, f.save);
    expect(result.status).toBe('needs_clarification');
    expect(f.calls).toMatchObject({ plan: 1, research: 0, hits: 0 });
  });
  it('rejects excess planned queries before search', async () => {
    const f = fake({ queries: ['问题一', '问题二', '问题三', '问题四'] });
    const result = await executeLiveAcceptance(f.provider, f.cachedProvider, context, f.save);
    expect(result.status).toBe('failed');
    expect(f.calls.research).toBe(0);
  });
  it('stops immediately after provider failure and exposes only safe categories', async () => {
    const f = fake({ error: true });
    const result = await executeLiveAcceptance(f.provider, f.cachedProvider, context, f.save);
    expect(result.status).toBe('failed');
    expect(result.failure).toMatchObject({ code: 'process_failed', upstreamCode: 'authentication_failed' });
    expect(f.calls).toMatchObject({ plan: 1, research: 1, hits: 0 });
  });
  it('does not risk a paid repeat when the cold result was not cached', async () => {
    const f = fake();
    const result = await executeLiveAcceptance(f.provider, f.cachedProvider, context, f.save);
    expect(result.status).toBe('no_evidence');
    expect(f.calls.hits).toBe(0);
    expect(result.cacheRuns[0]?.status).toBe('not_attempted_cache_unavailable');
  });
  it('cache repeat uses a new ID, no Planner and no search/model calls', async () => {
    const f = fake({ cache: true });
    const result = await executeLiveAcceptance(f.provider, f.cachedProvider, context, f.save);
    expect(f.calls).toMatchObject({ plan: 1, research: 1, hits: 1 });
    expect(result.cacheRuns[0]?.status).toBe('hit');
    expect(result.cacheRuns[0]?.requestId).not.toBe(result.coldRuns[0]?.requestId);
    expect(result.calls).toMatchObject({ planner: 1, search: 2, batch: 1 });
  });
  it('does not cache-repeat a partial execution', async () => {
    const f = fake({ cache: true, partial: true });
    const result = await executeLiveAcceptance(f.provider, f.cachedProvider, context, f.save);
    expect(result.status).toBe('partial');
    expect(f.calls.hits).toBe(0);
  });
  it('treats unexpected paid cache work as a failure and stops', async () => {
    const f = fake({ cache: true });
    f.cachedProvider.researchOne = async input => ({ runId: 'bad-cache', status: 'no_evidence',
      pack: { requestId: input.request.id, evidence: [], routeCandidates: [], unresolvedQuestions: [] },
      issues: [], metrics: { cache_hit: 0, search_calls_attempted: 1, compiler_calls_attempted: 0 } } satisfies ResearchProviderResult);
    const result = await executeLiveAcceptance(f.provider, f.cachedProvider, context, f.save);
    expect(result.status).toBe('failed');
    expect(result.failure?.code).toBe('cache_reuse_contract_failed');
    expect(result.calls.search).toBe(3);
    expect(result.cacheRuns[0]?.status).not.toBe('hit');
  });
  it('saves allocated requests before research and records the failed sent ID and elapsed stage', async () => {
    const f = fake();
    const saved = new Map<string, unknown>();
    const now = vi.spyOn(performance, 'now').mockReturnValue(100);
    let sentId = '';
    f.provider.researchOne = async input => {
      expect(saved.has('requests.json')).toBe(true);
      sentId = input.request.id;
      now.mockReturnValue(350);
      throw new Error('Authorization: Bearer RAW_PRIVATE_EXCEPTION');
    };
    try {
      const result = await executeLiveAcceptance(f.provider, f.cachedProvider, context,
        async (name, value) => { saved.set(name, structuredClone(value)); });
      expect(saved.get('requests.json')).toEqual([expect.objectContaining({ id: sentId })]);
      expect(result).toMatchObject({ status: 'failed', failedStage: 'research', failedRequestId: sentId,
        failedStageDurationMs: 250 });
      expect(result.coldRuns).toEqual([]);
      expect(result.cacheRuns).toEqual([]);
      expect(JSON.stringify(result)).not.toContain('RAW_PRIVATE_EXCEPTION');
      expect(JSON.stringify(result)).not.toContain('Authorization');
    } finally { now.mockRestore(); }
  });
  it('records planner failure without inventing a research request ID', async () => {
    const f = fake();
    const now = vi.spyOn(performance, 'now').mockReturnValue(100);
    f.provider.planForBaseline = async () => {
      now.mockReturnValue(420);
      throw new ZhihuProviderError('timeout');
    };
    try {
      const result = await executeLiveAcceptance(f.provider, f.cachedProvider, context, f.save);
      expect(result).toMatchObject({ status: 'failed', failedStage: 'plan', failedStageDurationMs: 320 });
      expect(result.failedRequestId).toBeUndefined();
      expect(f.calls.research).toBe(0);
    } finally { now.mockRestore(); }
  });
  it('records cache failure with its actual new request ID and no successful cache run', async () => {
    const f = fake({ cache: true });
    const now = vi.spyOn(performance, 'now').mockReturnValue(100);
    const saved = new Map<string, unknown>();
    let sentId = '';
    f.cachedProvider.researchOne = async input => {
      expect(saved.has('cache-request-0.json')).toBe(true);
      sentId = input.request.id;
      now.mockReturnValue(600);
      throw new ZhihuProviderError('process_failed');
    };
    try {
      const result = await executeLiveAcceptance(f.provider, f.cachedProvider, context,
        async (name, value) => { saved.set(name, structuredClone(value)); });
      expect(result).toMatchObject({ status: 'failed', failedStage: 'cache', failedRequestId: sentId,
        failedStageDurationMs: 500 });
      expect(saved.get('cache-request-0.json')).toMatchObject({ id: sentId });
      expect(result.failedRequestId).not.toBe(result.coldRuns[0]?.requestId);
      expect(result.coldRuns).toHaveLength(1);
      expect(result.cacheRuns).toEqual([]);
    } finally { now.mockRestore(); }
  });
  it('does not start research if writing the request manifest fails', async () => {
    const f = fake();
    const result = await executeLiveAcceptance(f.provider, f.cachedProvider, context, async name => {
      if (name === 'requests.json') throw new Error('PRIVATE_LOCAL_WRITE_ERROR');
    });
    expect(result.status).toBe('failed');
    expect(f.calls.research).toBe(0);
    expect(result.failedRequestId).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('PRIVATE_LOCAL_WRITE_ERROR');
  });
});
