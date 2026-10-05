const express = require('express');
const rateLimit = require('express-rate-limit');
const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const ingestion = require('../services/ingestion/ingestion.service');

// Public lead ingestion endpoints (no user auth - each is authenticated by
// its own source credential). Mounted at /api/leads/ingest.
//   GET/POST /meta                 one app-level webhook for every connected page
//   POST     /email                inbound-mail provider -> lead-<org>@ mailboxes
//   POST     /:source/:key         portals, Google, JustDial, Sulekha, LinkedIn, new sources

const router = express.Router();
const limiter = rateLimit({ windowMs: 60 * 1000, max: Number(process.env.INGEST_RATE_LIMIT_PER_MINUTE) || 600, standardHeaders: true, legacyHeaders: false });
router.use(limiter);

/**
 * @swagger
 * tags:
 *   name: Lead Ingestion
 *   description: >
 *     Engine 2 external lead ingestion - one shared endpoint per source type serves every tenant. Each payload is
 *     archived, normalised, de-duplicated (phone within the org; external id across push + pull) and routed into
 *     the tenant's CRM with an immutable source tag, then into the assignment cascade.
 */

/**
 * @swagger
 * /leads/ingest/meta:
 *   get:
 *     summary: Meta webhook verification (hub.challenge) - verify token from any connected page
 *     tags: [Lead Ingestion]
 *     responses: { 200: { description: Challenge echoed }, 403: { description: Verify token mismatch } }
 *   post:
 *     summary: Meta Lead Ads (Facebook / Instagram) leadgen webhook - routed by page id, X-Hub-Signature-256 checked when the app secret is set
 *     tags: [Lead Ingestion]
 *     responses: { 200: { description: Processed } }
 */
router.get('/meta', asyncHandler(async (req, res) => res.status(200).send(String(await ingestion.metaVerify(req.query)))));
router.post(
  '/meta',
  asyncHandler(async (req, res) => success(res, 200, 'Processed', await ingestion.handleMetaWebhook({ body: req.body, rawBody: req.rawBody, headers: req.headers })))
);

/**
 * @swagger
 * /leads/ingest/email:
 *   post:
 *     summary: Inbound portal lead email (from the mail provider) - routed by mailbox lead-<org-slug>@<domain>; X-Ingest-Secret required
 *     tags: [Lead Ingestion]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, properties: { to: { type: string }, from: { type: string }, subject: { type: string }, text: { type: string } } }
 *     responses: { 200: { description: Ingested / queued for review } }
 */
router.post(
  '/email',
  asyncHandler(async (req, res) => {
    const expected = process.env.LEAD_EMAIL_INGEST_SECRET;
    if (!expected || req.headers['x-ingest-secret'] !== expected) return res.status(403).json({ success: false, message: 'Invalid ingest secret' });
    const b = req.body || {};
    return success(res, 200, 'Email processed', await ingestion.handleEmail({ to: b.to || b.recipient, from: b.from || b.sender, subject: b.subject, text: b.text || b['body-plain'] || b.html || '' }));
  })
);

/**
 * @swagger
 * /leads/ingest/{source}/{key}:
 *   post:
 *     summary: Push webhook for a source (JSON or form-encoded; single lead, array, or { leads }) - key identifies the org connection
 *     tags: [Lead Ingestion]
 *     parameters:
 *       - { in: path, name: source, required: true, schema: { type: string, example: 99acres } }
 *       - { in: path, name: key, required: true, schema: { type: string } }
 *     responses: { 200: { description: Per-lead results }, 403: { description: Bad credential }, 404: { description: Unknown connection } }
 */
router.post(
  '/:source/:key',
  asyncHandler(async (req, res) => success(res, 200, 'Processed', await ingestion.handleWebhook(req.params.source, req.params.key, { body: req.body, headers: req.headers })))
);

module.exports = router;
