const configService = require('../config.service');

// Polite HTTP fetching for the crawlers (Annexure A "Legal and Ethical
// Rules"): robots.txt is read and obeyed before any request, requests to a
// domain are spaced at least crawler.min_request_interval_ms apart (default
// 3s, plus random jitter), user agents rotate, and only public pages are
// fetched (no cookies / logins).

const ROBOTS_TTL_MS = 24 * 60 * 60 * 1000;
const robotsCache = new Map(); // origin -> { rules, fetchedAt }
const lastRequestAt = new Map(); // host -> timestamp
let uaIndex = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CrawlerError extends Error {
  constructor(type, message) {
    super(message);
    this.type = type; // robots_blocked | http_error | timeout | network | parse_error | not_configured
  }
}

// Minimal robots.txt parser: groups for our bot name and "*", Allow /
// Disallow with longest-match precedence and "*" / "$" wildcards.
function parseRobots(text) {
  const groups = [];
  let current = null;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      if (!current || current.rules.length) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if ((key === 'allow' || key === 'disallow') && current) {
      current.rules.push({ allow: key === 'allow', path: value });
    }
  }
  const mine = groups.filter((g) => g.agents.some((a) => a.includes('propertyserch')));
  const any = groups.filter((g) => g.agents.includes('*'));
  return (mine.length ? mine : any).flatMap((g) => g.rules);
}

function ruleMatches(rulePath, path) {
  if (!rulePath) return false;
  const pattern = rulePath.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$');
  return new RegExp(`^${pattern}`).test(path);
}

function isAllowed(rules, path) {
  let best = null;
  for (const rule of rules) {
    if (rule.path === '' && !rule.allow) continue; // "Disallow:" (empty) allows everything
    if (ruleMatches(rule.path, path) && (!best || rule.path.length > best.path.length || (rule.path.length === best.path.length && rule.allow))) {
      best = rule;
    }
  }
  return !best || best.allow;
}

async function nextUserAgent() {
  const agents = await configService.getConfig('crawler.user_agents', ['Mozilla/5.0 (compatible; PropertySerchBot/1.0)']);
  uaIndex = (uaIndex + 1) % agents.length;
  return agents[uaIndex];
}

async function throttle(host) {
  const minGap = Number(await configService.getConfig('crawler.min_request_interval_ms', 3000)) || 3000;
  const last = lastRequestAt.get(host) || 0;
  const wait = Math.max(0, last + minGap - Date.now()) + Math.floor(Math.random() * 1000);
  if (wait) await sleep(wait);
  lastRequestAt.set(host, Date.now());
}

async function rawGet(url, { timeoutMs = 20000, accept } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': await nextUserAgent(), Accept: accept || 'text/html,application/json,application/xml;q=0.9,*/*;q=0.8' },
      redirect: 'follow',
      signal: controller.signal,
    });
    return res;
  } catch (err) {
    if (err.name === 'AbortError') throw new CrawlerError('timeout', `Timed out fetching ${url}`);
    throw new CrawlerError('network', `Could not reach ${url}: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function robotsRules(origin) {
  const cached = robotsCache.get(origin);
  if (cached && Date.now() - cached.fetchedAt < ROBOTS_TTL_MS) return cached.rules;
  let rules = [];
  try {
    await throttle(new URL(origin).host);
    const res = await rawGet(`${origin}/robots.txt`, { timeoutMs: 10000, accept: 'text/plain' });
    if (res.ok) rules = parseRobots(await res.text());
    // 4xx = no robots.txt = allowed; 5xx = be safe and treat as fully disallowed.
    else if (res.status >= 500) rules = [{ allow: false, path: '/' }];
  } catch {
    rules = [{ allow: false, path: '/' }];
  }
  robotsCache.set(origin, { rules, fetchedAt: Date.now() });
  return rules;
}

// Fetches a public URL politely. Throws CrawlerError('robots_blocked') if
// robots.txt disallows it.
async function politeFetch(url, { as = 'text' } = {}) {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new CrawlerError('not_configured', `Unsupported URL: ${url}`);
  const rules = await robotsRules(u.origin);
  if (!isAllowed(rules, `${u.pathname}${u.search}`)) throw new CrawlerError('robots_blocked', `robots.txt disallows ${u.pathname}`);
  await throttle(u.host);
  const res = await rawGet(url);
  if (!res.ok) throw new CrawlerError('http_error', `HTTP ${res.status} from ${url}`);
  if (as === 'buffer') return Buffer.from(await res.arrayBuffer());
  if (as === 'json') return res.json();
  return res.text();
}

module.exports = { politeFetch, parseRobots, isAllowed, CrawlerError };
