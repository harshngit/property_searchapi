require('dotenv').config();

// The VPS is dual-stack (IPv4 + IPv6). Outbound HTTPS calls (e.g. to MSG91)
// were nondeterministically going out over IPv6 depending on DNS resolution
// order, which isn't the address MSG91 has whitelisted - causing the same
// request to succeed or fail with "IP is not whitelisted" across identical
// calls. Forcing IPv4 first makes outbound connections consistent.
require('dns').setDefaultResultOrder('ipv4first');

const app = require('./app');

// Port 5000 is commonly occupied by macOS ControlCenter on local machines.
// Keep it configurable while using 5001 as the development fallback.
const PORT = process.env.PORT || 5001;

app.listen(PORT, () => {
  console.log(`PropertySerch Auth Service running on http://localhost:${PORT}`);
  console.log(`Swagger docs available at http://localhost:${PORT}/api-docs`);
  // Section 23 crawlers - on only where CRAWLER_SCHEDULER_ENABLED=true (the
  // production API), and each source still needs to be enabled and legally
  // approved in the admin panel, plus the crawler.enabled master switch.
  if (process.env.CRAWLER_SCHEDULER_ENABLED === 'true') require('./services/crawler/crawler.service').startScheduler();
  // Investor deal alerts held for each investor's daily window (Module 43).
  if (process.env.ALERT_DISPATCHER_DISABLED !== 'true') require('./services/investorAlert.service').startDispatcher();
  // Matching engine (sec. 7): nightly re-match + expiry + AI learning, daily Warm digest.
  if (process.env.MATCHING_JOBS_DISABLED !== 'true') require('./services/matchEngine.service').startScheduler();
  // Trust & reputation (sec. 8): daily recompute, weekly Featured Agents, quarterly / annual Best Broker.
  if (process.env.TRUST_JOBS_DISABLED !== 'true') require('./services/trust.service').startScheduler();
  // Disputes (sec. 9.6): hourly escalation of cases past their 48 h SLA.
  if (process.env.DISPUTE_JOBS_DISABLED !== 'true') require('./services/dispute.service').startScheduler();
  if (process.env.ORCHESTRATION_JOBS_DISABLED !== 'true') {
    require('./services/orchestration.service').startScheduler();
    require('./services/reputation.service').startScheduler();
  }
});
