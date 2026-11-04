#!/usr/bin/env node
// Test coverage of the API - contract: "minimum eighty percent (80%) unit-test
// coverage and passing end-to-end suites".
//
// Starts the API under c8 (V8's own coverage, no code instrumentation), runs
// the e2e suite against it, stops it, and reports line / branch / function
// coverage of src/ (text summary + HTML in coverage/). Use a LOCAL or staging
// database - the suite writes test data.
//
//   npm run coverage           # same env as npm test (see the e2e test header)
//
// Env: PORT (default 5055) - the API is started on it; COVERAGE_MIN_LINES
// (default 80) - exits 1 below it.

const { spawn } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const PORT = process.env.PORT || '5055';
const MIN = Number(process.env.COVERAGE_MIN_LINES || 80);
const c8 = path.join(root, 'node_modules/.bin/c8');
const env = { ...process.env, PORT };
const tmp = path.join(root, 'coverage/.tmp');

const run = (cmd, args, opts = {}) => new Promise((resolve) => {
  const p = spawn(cmd, args, { cwd: root, env, stdio: 'inherit', ...opts });
  p.on('close', (code) => resolve(code));
});

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://localhost:${PORT}/health`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`API did not start on port ${PORT}`);
}

async function main() {
  const server = spawn(c8, ['--clean', '--temp-directory', tmp, '--reporter=none', 'node', 'src/server.js'], { cwd: root, env, stdio: ['ignore', 'ignore', 'inherit'] });
  const stopped = new Promise((r) => server.on('close', r));
  await waitUp();
  console.log(`API up on ${PORT} under c8 - running the e2e suite`);
  const testCode = await run('node', ['--test', '--test-concurrency=1', 'tests/'], { env: { ...env, BASE_URL: `http://localhost:${PORT}/api` } });
  server.kill('SIGTERM');
  await stopped;
  const reportArgs = ['report', '--temp-directory', tmp, '--reporter=text-summary', '--reporter=html', '--reporter=json-summary',
    '--include=src/**', '--exclude=src/db/migrations/**', '--all', '--report-dir', 'coverage'];
  await run(c8, reportArgs);
  const summary = require(path.join(root, 'coverage/coverage-summary.json')).total;
  const lines = summary.lines.pct;
  console.log(`\nLines ${lines}% | branches ${summary.branches.pct}% | functions ${summary.functions.pct}% (target ${MIN}% lines). HTML: coverage/index.html`);
  console.log(`e2e suite: ${testCode === 0 ? 'passed' : 'had failures'}`);
  process.exit(lines >= MIN && testCode === 0 ? 0 : 1);
}

main().catch((err) => { console.error('[coverage]', err.message); process.exit(2); });
