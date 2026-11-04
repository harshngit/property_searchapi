#!/usr/bin/env node
// Load test - contract sec. 29.1 acceptance gate: "1,000 concurrent users
// sustained for 30 minutes within SLO targets", with the SLOs of sec. 25.1:
//   P95 latency < 1 s, P99 < 3 s, error rate < 0.1 %.
//
// Run it against STAGING (never production) from a machine close to it:
//
//   LOAD_TEST_URL=https://staging-api.example.com node scripts/loadtest/loadTest.js
//
// What one simulated user does, in a loop (weights in MIX below):
//   the public website - home, filters, a city search, a page of results,
//   a property page, suggestions, site config, the status page - and, when
//   LOAD_TEST_TOKEN is set (a staff token for a test account), the CRM
//   screens a broker opens most: leads, deals, notifications, /auth/me.
//
// Env (all optional):
//   LOAD_TEST_URL           base URL of the API (default http://localhost:5001)
//   LOAD_TEST_USERS         concurrent connections (default 1000)
//   LOAD_TEST_DURATION      seconds (default 1800 = 30 minutes)
//   LOAD_TEST_TOKEN         Bearer token of a TEST staff account; adds the CRM mix
//   LOAD_TEST_P95_MS / LOAD_TEST_P99_MS / LOAD_TEST_MAX_ERROR_PCT   SLO limits (1000 / 3000 / 0.1)
//   LOAD_TEST_REPORT        file to write the JSON result to (default loadtest-<date>.json)
//
// Exits 0 when every SLO holds, 1 otherwise. Rate limits: the only limiter
// is on /api/auth (sign-in), which this test does not call; a proxy / WAF
// in front of staging may need the test machine's IP allowed.

const autocannon = require('autocannon');
const fs = require('fs');

const BASE = (process.env.LOAD_TEST_URL || 'http://localhost:5001').replace(/\/+$/, '');
const USERS = Number(process.env.LOAD_TEST_USERS || 1000);
const DURATION = Number(process.env.LOAD_TEST_DURATION || 1800);
const TOKEN = process.env.LOAD_TEST_TOKEN || '';
const SLO = {
  p95: Number(process.env.LOAD_TEST_P95_MS || 1000),
  p99: Number(process.env.LOAD_TEST_P99_MS || 3000),
  errorPct: Number(process.env.LOAD_TEST_MAX_ERROR_PCT || 0.1),
};

if (/propertyserch\.com|prod/i.test(BASE) && process.env.LOAD_TEST_I_KNOW_THIS_IS_PRODUCTION !== 'yes') {
  console.error(`Refusing to load-test ${BASE}: it looks like production. Use staging.`);
  process.exit(2);
}

async function getJson(path) {
  const res = await fetch(BASE + path, { headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {} });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

// Real ids and cities from the target, so the requests hit real rows (no hardcoded cities).
async function discover() {
  const cities = ((await getJson('/api/geo/cities').catch(() => ({ data: [] }))).data || []).filter((c) => c.status === 'active').slice(0, 20);
  const props = ((await getJson('/api/search/properties?limit=100').catch(() => ({ data: { items: [] } }))).data?.items || []).map((p) => p.id);
  return { cities: cities.map((c) => c.city_name), props };
}

const pick = (a) => a[Math.floor(Math.random() * a.length)];

function buildMix({ cities, props }) {
  const city = () => (cities.length ? `&city=${encodeURIComponent(pick(cities))}` : '');
  const q = () => (cities.length ? encodeURIComponent(pick(cities).slice(0, 3)) : 'a');
  const mix = [
    [20, () => `/api/search/properties?limit=20${city()}`],
    [10, () => `/api/search/properties?limit=20&page=${1 + Math.floor(Math.random() * 3)}&sort=newest`],
    [10, () => `/api/search/properties?limit=20&purpose=rent${city()}`],
    [8, () => '/api/search/home'],
    [6, () => '/api/search/filters'],
    [8, () => `/api/search/suggestions?q=${q()}`],
    [6, () => '/api/site-config?app=website'],
    [4, () => '/api/geo/cities'],
    [2, () => '/api/status'],
    [2, () => '/health'],
  ];
  if (props.length) mix.push([20, () => `/api/search/properties/${pick(props)}`]);
  if (TOKEN) {
    mix.push(
      [8, () => '/api/leads?limit=20'],
      [5, () => '/api/deals?limit=20'],
      [5, () => '/api/notifications/unread-count'],
      [3, () => '/api/auth/me'],
    );
  }
  const total = mix.reduce((s, [w]) => s + w, 0);
  return () => {
    let r = Math.random() * total;
    for (const [w, f] of mix) if ((r -= w) < 0) return f();
    return mix[0][1]();
  };
}

async function main() {
  const found = await discover();
  console.log(`Target ${BASE}: ${USERS} users for ${DURATION}s; ${found.cities.length} cities and ${found.props.length} listings found${TOKEN ? '; CRM mix on' : ''}.`);
  if (!found.props.length) console.warn('No approved listings found - property pages are left out of the mix. Seed staging first for a realistic run.');
  const next = buildMix(found);
  const headers = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};

  const instance = autocannon({
    url: BASE,
    connections: USERS,
    duration: DURATION,
    timeout: 30,
    headers,
    requests: [{ method: 'GET', setupRequest: (req) => ({ ...req, path: next() }) }],
  });
  // autocannon reports P97.5 / P99 but not P95: count every response time (1 ms buckets) for exact percentiles.
  const buckets = new Uint32Array(30001);
  let seen = 0;
  instance.on('response', (_client, _status, _bytes, ms) => { buckets[Math.min(30000, Math.round(ms))]++; seen++; });
  const pct = (p) => { let need = Math.ceil(seen * p), i = 0; for (; i < buckets.length; i++) if ((need -= buckets[i]) <= 0) break; return i; };
  autocannon.track(instance, { renderProgressBar: process.stdout.isTTY, renderResultsTable: true });
  const r = await new Promise((resolve, reject) => instance.on('done', resolve).on('error', reject));

  const total = r.requests.total + r.errors + r.timeouts;
  const failed = r.errors + r.timeouts + r.non2xx;
  const errorPct = total ? (failed / total) * 100 : 100;
  const p95 = pct(0.95);
  const p99 = pct(0.99);
  const checks = {
    p95: { value: p95, limit: SLO.p95, ok: p95 < SLO.p95 },
    p99: { value: p99, limit: SLO.p99, ok: p99 < SLO.p99 },
    errorPct: { value: Math.round(errorPct * 1000) / 1000, limit: SLO.errorPct, ok: errorPct < SLO.errorPct },
    sustained: { value: r.duration, limit: DURATION, ok: r.duration >= DURATION * 0.99 },
  };
  const pass = Object.values(checks).every((c) => c.ok);
  const report = {
    target: BASE, startedAt: r.start, finishedAt: r.finish, users: USERS, durationSec: r.duration,
    requests: r.requests.total, rps: r.requests.average, non2xx: r.non2xx, errors: r.errors, timeouts: r.timeouts,
    statusCodes: r.statusCodeStats, latencyMs: { p50: pct(0.5), p90: pct(0.9), p95, p99, max: r.latency.max },
    slo: checks, pass,
  };
  const file = process.env.LOAD_TEST_REPORT || `loadtest-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.json`;
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`\nSLO (contract 25.1): P95 ${p95} ms (< ${SLO.p95}) ${checks.p95.ok ? 'OK' : 'FAIL'} | P99 ${p99} ms (< ${SLO.p99}) ${checks.p99.ok ? 'OK' : 'FAIL'} | errors ${checks.errorPct.value}% (< ${SLO.errorPct}%) ${checks.errorPct.ok ? 'OK' : 'FAIL'}`);
  console.log(`${pass ? 'PASS' : 'FAIL'} - report written to ${file}`);
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error('[load test] failed:', err.message);
  process.exit(2);
});
