// Offline transport fixture only. Production always invokes zhihu_m2.pipeline.
const mode = process.argv[2];
if (mode === 'hang') setInterval(() => {}, 1000);
else if (mode === 'tree') {
  const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  require('node:fs').writeFileSync(process.env.OFFLINE_PID_FILE, String(child.pid));
  setInterval(() => {}, 1000);
}
else if (mode === 'exit-early') process.exit(4);
else {
  let input = '';
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', () => {
    if (mode === 'invalid-json') return process.stdout.write('private raw upstream secret');
    if (mode === 'signal') return process.kill(process.pid, 'SIGTERM');
    if (mode === 'large-out') return process.stdout.write('x'.repeat(10000));
    if (mode === 'large-err') { process.stderr.write('x'.repeat(10000)); return; }
    if (mode === 'nonzero') { process.stderr.write('Authorization secret'); process.exit(7); }
    const request = JSON.parse(input);
    if (mode === 'supplement-stop') {
      return process.stdout.write(JSON.stringify({ protocol_version: 'm2-entry-v0.1', run_id: 'offline-supplement',
        action: 'supplement', ok: true, error: null, metrics: { planner_calls_attempted: 0 },
        data: { status: 'stop', reason: '覆盖已充分', research_questions: [], clarification_questions: [],
          planning_stage: 'supplemental', input_scope: 'goal_context_and_gap_summary', gaps: request.gaps,
          planner_calls_attempted: 0, remaining_query_budget: request.remaining_query_budget,
          executed_query_count: request.executed_queries.length, stop_reason: 'coverage_sufficient' } }));
    }
    if (mode === 'plan-initial' || mode === 'plan-legacy') {
      const questions = mode === 'plan-initial' ? 1 : 3;
      return process.stdout.write(JSON.stringify({ protocol_version: 'm2-entry-v0.1', run_id: 'offline-plan',
        action: 'plan', ok: true, error: null, metrics: { planner_calls_attempted: 1 },
        data: { status: 'ready_for_review', reason: '', human_approved: false, coverage_verified: false,
          clarification_questions: [], research_questions: Array.from({ length: questions }, (_, i) => ({
            question_id: `internal-${i}`, research_question: `怎样实施步骤${i}？`, why_needed: '补充当前知识缺口',
            queries: [`实施步骤${i} 方法`, `实施步骤${i} 风险`],
          })) } }));
    }
    if (mode.startsWith('stderr-')) {
      const metadata = { event: 'pipeline_finished', action: 'research', ok: false,
        error_code: mode === 'stderr-timeout' ? 'research_timeout' : 'configuration_error',
        planner_calls_attempted: 0, search_calls_attempted: 1, compiler_calls_attempted: 0,
        batch_model_calls_attempted: 1, model_calls_attempted: 1, candidate_count: 2, evidence_count: 0,
        batch_invalid_item_count: 1, batch_valid_output_count: 1, batch_invalid_group_count: 2,
        run_id: 'private run id', message: 'Authorization secret-canary traceback', unknown_counter: 9876 };
      if (mode === 'stderr-unknown-code') metadata.error_code = 'private-canary';
      if (mode === 'stderr-wrong-action') metadata.action = 'plan';
      if (mode === 'stderr-ok') metadata.ok = true;
      if (mode === 'stderr-invalid-counter') metadata.search_calls_attempted = true;
      if (mode === 'stderr-invalid-batch-counter') metadata.batch_invalid_item_count = true;
      if (mode === 'stderr-oversize-line') metadata.message = 'x'.repeat(5000);
      const line = JSON.stringify(metadata) + (mode === 'stderr-unframed' ? '' : '\r\n');
      process.stderr.write('private diagnostic log 🍞\r\n');
      if (mode === 'stderr-failure-split') {
        process.exitCode = 1;
        const bytes = Buffer.from(line);
        process.stderr.write(bytes.subarray(0, 37));
        setTimeout(() => {
          process.stderr.write(bytes.subarray(37, 92));
          setTimeout(() => process.stderr.write(bytes.subarray(92)), 5);
        }, 5);
        return;
      }
      process.stderr.write(line);
      if (mode === 'stderr-conflicting') process.stderr.write(JSON.stringify({ ...metadata, error_code: 'research_timeout' }) + '\n');
      if (mode === 'stderr-invalid-json') { process.exitCode = 1; return process.stdout.write('private invalid json'); }
      if (!['stderr-success', 'stderr-envelope-failed'].includes(mode)) { process.exitCode = 1; return; }
    }
    const response = {
      protocol_version: 'm2-entry-v0.1', run_id: 'offline-child', action: 'research',
      ok: true, error: null,
      metrics: { search_calls_attempted: 1, compiler_calls_attempted: 0, candidate_count: 0, evidence_count: 0 },
      data: { requestId: request.request.id, status: 'no_evidence', compilerOutputs: [],
        routeCandidates: [], unresolvedQuestions: ['中文🧪没有适用证据'], issues: [] },
    };
    if (mode === 'wrong-action') response.action = 'plan';
    if (mode === 'wrong-id') response.data.requestId = 'other';
    if (['failed', 'research-timeout', 'bad-failure', 'stderr-envelope-failed'].includes(mode)) {
      response.ok = false; response.data = null;
      response.error = { code: mode === 'research-timeout' ? 'research_timeout' : 'research_failed', message: 'private raw upstream secret' };
      response.metrics.batch_invalid_item_count = 1;
      response.metrics.batch_valid_output_count = 0;
      response.metrics.batch_invalid_group_count = 0;
      if (mode === 'bad-failure') response.action = 'plan';
      process.exitCode = 1;
    }
    const output = Buffer.from(JSON.stringify(response));
    if (mode === 'invalid-utf8') output[output.indexOf(Buffer.from('中文'))] = 0xff;
    process.stderr.write('harmless diagnostic log\n');
    // Deliberately split a multibyte emoji, then keep stdout open briefly.
    const split = output.indexOf(Buffer.from('🧪')) + 1;
    process.stdout.write(output.subarray(0, split));
    setTimeout(() => { process.stdout.write(output.subarray(split)); }, 15);
  });
}
