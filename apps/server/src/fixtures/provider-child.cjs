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
    const response = {
      protocol_version: 'm2-entry-v0.1', run_id: 'offline-child', action: 'research',
      ok: true, error: null,
      metrics: { search_calls_attempted: 1, compiler_calls_attempted: 0, candidate_count: 0, evidence_count: 0 },
      data: { requestId: request.request.id, status: 'no_evidence', compilerOutputs: [],
        routeCandidates: [], unresolvedQuestions: ['中文🧪没有适用证据'], issues: [] },
    };
    if (mode === 'wrong-action') response.action = 'plan';
    if (mode === 'wrong-id') response.data.requestId = 'other';
    if (['failed', 'research-timeout', 'bad-failure'].includes(mode)) {
      response.ok = false; response.data = null;
      response.error = { code: mode === 'research-timeout' ? 'research_timeout' : 'research_failed', message: 'private raw upstream secret' };
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
