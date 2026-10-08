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
  // Module 46: mandate expiry reminders (30 / 7 / 1 days) and expiry.
  if (process.env.MANDATE_JOBS_DISABLED !== 'true') require('./services/mandate.service').startScheduler();
  // Sec. 34: assignment cascade - missed windows, departed reps, response SLA.
  if (process.env.ASSIGNMENT_JOBS_DISABLED !== 'true') require('./services/assignment.service').startScheduler();
  // Engine 2: pull reconciliation for every push+pull / pull lead source.
  if (process.env.INGESTION_JOBS_DISABLED !== 'true') require('./services/ingestion/ingestion.service').startScheduler();
  // Module 48/49: event partitions, WARM digest / NURTURE summary, score recency.
  if (process.env.EVENTS_JOBS_DISABLED !== 'true') require('./services/events.service').startScheduler();
  // Module 17: end finished ad campaigns and send renewal reminders (hourly).
  if (process.env.ADS_JOBS_DISABLED !== 'true') require('./services/advertising.service').startScheduler();
  // Module 29: hourly points sync from platform activity.
  if (process.env.GAMIFICATION_JOBS_DISABLED !== 'true') require('./services/gamification.service').startScheduler();
  // Module 28: keep the search dictionary (autocomplete, did-you-mean) fresh.
  if (process.env.SEARCH_JOBS_DISABLED !== 'true') require('./services/search.service').startScheduler();
  // Module 47: WFH task locks, expiry, representative escalation, listing-assist payment (every 15 minutes).
  if (process.env.WFH_JOBS_DISABLED !== 'true') require('./services/wfh.service').startScheduler();
  // Module 35: webhook event scanner and delivery (every minute).
  if (process.env.WEBHOOK_JOBS_DISABLED !== 'true') require('./services/webhook.service').startScheduler();
  // Modules 32 / 33: hourly compliance checks; DPDP deletion requests whose 30-day notice has ended.
  if (process.env.COMPLIANCE_JOBS_DISABLED !== 'true') {
    require('./services/compliance.service').startScheduler();
    require('./services/privacy.service').startScheduler();
  }
});
