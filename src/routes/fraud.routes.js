const express = require('express');
const { body, param } = require('express-validator');
const validate = require('../middlewares/validate');
const { authenticate, authorize } = require('../middlewares/auth');
const { uploadDocumentFile } = require('../middlewares/upload');
const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const auditService = require('../services/audit.service');
const fraud = require('../services/fraud.service');

// Sec. 9 / Module 19 - property verification levels, duplicates (with the
// auto-resolution flow), fraud risk review, appeals and user flags.
// Mounted at /api/fraud.

const router = express.Router();
router.use(authenticate);
const STAFF = ['internal_sales', 'admin', 'super_admin'];
const ADMIN = ['admin', 'super_admin'];
const meta = (req) => auditService.requestMeta(req);
const idParam = [param('id').isUUID()];

async function uploadEvidence(req, folder) {
  const files = req.files || (req.file ? [req.file] : []);
  if (!files.length) return [];
  const { uploadBuffer } = require('../utils/storage');
  const out = [];
  for (const f of files) out.push({ path: await uploadBuffer(f.buffer, folder, f.originalname, f.mimetype), name: f.originalname, uploadedBy: req.user.id, at: new Date().toISOString() });
  return out;
}

/**
 * @swagger
 * tags:
 *   name: Verification & Fraud
 *   description: >
 *     Sec. 9 - four-level property verification (System / Seller / Legally / Site Verified), four-layer duplicate
 *     detection with auto-resolution (routing, update existing, cancel), fraud risk score 0-100 with Green / Yellow /
 *     Red / Critical actions, appeals and user flags.
 */

/**
 * @swagger
 * /fraud/listings/{id}:
 *   get:
 *     summary: Verification, duplicate, appeal and risk summary of a listing (lister or A R staff; score and factors for staff only)
 *     tags: [Verification & Fraud]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Summary } }
 */
router.get('/listings/:id', idParam, validate, asyncHandler(async (req, res) => success(res, 200, 'Listing checks', await fraud.listingSummary(req.user, req.params.id))));

/**
 * @swagger
 * /fraud/listings/{id}/verifications:
 *   post:
 *     summary: Request Seller Verified (2 - ownership proof), Legally Verified (3 - title / encumbrance papers) or Site Verified (4 - A R visit), with evidence files
 *     tags: [Verification & Fraud]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [level]
 *             properties:
 *               level: { type: integer, enum: [2, 3, 4] }
 *               note: { type: string }
 *               files: { type: array, items: { type: string, format: binary } }
 *     responses: { 201: { description: Verification request } }
 */
router.post(
  '/listings/:id/verifications',
  uploadDocumentFile.array('files', 10),
  [...idParam, body('level').isInt({ min: 2, max: 4 }).toInt(), body('note').optional().isString().isLength({ max: 1000 })],
  validate,
  asyncHandler(async (req, res) => {
    const evidence = await uploadEvidence(req, `verifications/properties/${req.params.id}`);
    return success(res, 201, 'Verification requested', await fraud.requestVerification(req.user, req.params.id, req.body.level, { note: req.body.note, evidence }, meta(req)));
  })
);

/**
 * @swagger
 * /fraud/listings/{id}/verifications/{level}:
 *   put:
 *     summary: "[Staff] Record a verification decision with its checklist (all checks must pass to verify; reason required to reject)"
 *     description: >
 *       Level 2 checks - ownership_proof, id_verified (auto from the lister's KYC), callback_done, photos_recent.
 *       Level 3 - title_chain_3y, encumbrance_clear, no_litigation, tax_paid, regulatory_compliance.
 *       Level 4 - photos_match, condition_ok, amenities_match, measurements_ok, inspection_report.
 *     tags: [Verification & Fraud]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *       - { in: path, name: level, required: true, schema: { type: integer, enum: [2, 3, 4] } }
 *     requestBody:
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [status]
 *             properties:
 *               status: { type: string, enum: [in_progress, verified, rejected] }
 *               checks: { type: string, description: JSON object of check -> boolean }
 *               notes: { type: string }
 *               files: { type: array, items: { type: string, format: binary } }
 *     responses: { 200: { description: Verification } }
 */
router.put(
  '/listings/:id/verifications/:level',
  authorize(...STAFF),
  uploadDocumentFile.array('files', 10),
  [...idParam, param('level').isInt({ min: 2, max: 4 }).toInt(), body('status').isIn(['in_progress', 'verified', 'rejected']), body('notes').optional().isString().isLength({ max: 1000 })],
  validate,
  asyncHandler(async (req, res) => {
    let checks = req.body.checks || {};
    if (typeof checks === 'string') checks = JSON.parse(checks || '{}');
    const evidence = await uploadEvidence(req, `verifications/properties/${req.params.id}`);
    return success(res, 200, 'Verification updated', await fraud.decideVerification(req.user, req.params.id, req.params.level, { status: req.body.status, checks, notes: req.body.notes, evidence }, meta(req)));
  })
);

/**
 * @swagger
 * /fraud/listings/{id}/duplicate-resolution:
 *   post:
 *     summary: "Sec. 9.3 - resolve a listing held as a duplicate: request mandate-verification routing with the original lister, update the existing listing with newer info, or cancel"
 *     tags: [Verification & Fraud]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { type: object, required: [action], properties: { action: { type: string, enum: [request_routing, update_existing, cancel] }, note: { type: string } } } } }
 *     responses: { 200: { description: Result } }
 */
router.post(
  '/listings/:id/duplicate-resolution',
  [...idParam, body('action').isIn(['request_routing', 'update_existing', 'cancel']), body('note').optional().isString().isLength({ max: 500 })],
  validate,
  asyncHandler(async (req, res) => success(res, 200, 'Duplicate resolved', await fraud.resolveDuplicate(req.user, req.params.id, req.body.action, { note: req.body.note }, meta(req))))
);

/**
 * @swagger
 * /fraud/listings/{id}/appeal:
 *   post:
 *     summary: Appeal a fraud auto-rejection or duplicate hold, with evidence
 *     tags: [Verification & Fraud]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       content:
 *         multipart/form-data:
 *           schema: { type: object, required: [reason], properties: { reason: { type: string }, files: { type: array, items: { type: string, format: binary } } } }
 *     responses: { 201: { description: Appeal } }
 */
router.post(
  '/listings/:id/appeal',
  uploadDocumentFile.array('files', 10),
  [...idParam, body('reason').trim().isLength({ min: 10, max: 2000 })],
  validate,
  asyncHandler(async (req, res) => {
    const evidence = await uploadEvidence(req, `appeals/${req.params.id}`);
    return success(res, 201, 'Appeal submitted', await fraud.appeal(req.user, req.params.id, req.body.reason, evidence, meta(req)));
  })
);

/**
 * @swagger
 * /fraud/routing:
 *   get:
 *     summary: Mandate-verification routing requests sent by or to the caller (all for staff)
 *     tags: [Verification & Fraud]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Requests } }
 */
router.get('/routing', asyncHandler(async (req, res) => success(res, 200, 'Routing requests', await fraud.listRoutingRequests(req.user))));

/**
 * @swagger
 * /fraud/routing/{id}:
 *   put:
 *     summary: Original lister accepts (both become routed partners with the predefined split) or declines (duplicate closed)
 *     tags: [Verification & Fraud]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { type: object, required: [action], properties: { action: { type: string, enum: [accept, decline] } } } } }
 *     responses: { 200: { description: Request } }
 */
router.put(
  '/routing/:id',
  [...idParam, body('action').isIn(['accept', 'decline'])],
  validate,
  asyncHandler(async (req, res) => success(res, 200, 'Routing answered', await fraud.respondRouting(req.user, req.params.id, req.body.action, meta(req))))
);

// ------------------------------------------------------------------ staff

/**
 * @swagger
 * /fraud/queue:
 *   get:
 *     summary: "[Staff] Review queue - Yellow / Red / Critical listings with SLA, duplicate holds, verification requests, appeals, user flags, open duplicate findings"
 *     tags: [Verification & Fraud]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Queue } }
 */
router.get('/queue', authorize(...STAFF), asyncHandler(async (req, res) => success(res, 200, 'Review queue', await fraud.queue())));

/**
 * @swagger
 * /fraud/listings/{id}/assess:
 *   post:
 *     summary: "[Staff] Re-run duplicate detection + fraud scoring now"
 *     tags: [Verification & Fraud]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Assessment } }
 */
router.post('/listings/:id/assess', authorize(...STAFF), idParam, validate, asyncHandler(async (req, res) => success(res, 200, 'Assessed', await fraud.assess(req.params.id, { trigger: 'manual', actor: req.user }))));

/**
 * @swagger
 * /fraud/listings/{id}/review:
 *   put:
 *     summary: "[Staff] Clear (go / stay live, remove banner), hold, reject (reason required) or log that A R contacted the lister"
 *     tags: [Verification & Fraud]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { type: object, required: [action], properties: { action: { type: string, enum: [clear, hold, reject, contacted] }, note: { type: string } } } } }
 *     responses: { 200: { description: Listing state } }
 */
router.put(
  '/listings/:id/review',
  authorize(...STAFF),
  [...idParam, body('action').isIn(['clear', 'hold', 'reject', 'contacted']), body('note').optional().isString().isLength({ max: 1000 })],
  validate,
  asyncHandler(async (req, res) => success(res, 200, 'Review recorded', await fraud.review(req.user, req.params.id, req.body.action, req.body.note, meta(req))))
);

/**
 * @swagger
 * /fraud/appeals/{id}:
 *   put:
 *     summary: "[Admin] Uphold (reinstate the listing, clear the flag) or dismiss an appeal"
 *     tags: [Verification & Fraud]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { type: object, required: [decision], properties: { decision: { type: string, enum: [uphold, dismiss] }, note: { type: string } } } } }
 *     responses: { 200: { description: Appeal } }
 */
router.put(
  '/appeals/:id',
  authorize(...ADMIN),
  [...idParam, body('decision').isIn(['uphold', 'dismiss']), body('note').optional().isString().isLength({ max: 1000 })],
  validate,
  asyncHandler(async (req, res) => success(res, 200, 'Appeal decided', await fraud.decideAppeal(req.user, req.params.id, req.body.decision, req.body.note, meta(req))))
);

/**
 * @swagger
 * /fraud/flags/{id}/resolve:
 *   put:
 *     summary: "[Admin] Resolve a user flag"
 *     tags: [Verification & Fraud]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Flag } }
 */
router.put('/flags/:id/resolve', authorize(...ADMIN), idParam, validate, asyncHandler(async (req, res) => success(res, 200, 'Flag resolved', await fraud.resolveFlag(req.user, req.params.id, meta(req)))));

/**
 * @swagger
 * /fraud/scan-image:
 *   post:
 *     summary: "[Staff] Check any image - dimensions, fingerprint, EXIF GPS and the contact-detail scan"
 *     tags: [Verification & Fraud]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content: { multipart/form-data: { schema: { type: object, required: [file], properties: { file: { type: string, format: binary } } } } }
 *     responses: { 200: { description: Analysis } }
 */
router.post(
  '/scan-image',
  authorize(...STAFF),
  uploadDocumentFile.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw require('../utils/httpError').badRequest('Attach an image');
    return success(res, 200, 'Image analysed', await require('../services/imageScan.service').analyse(req.file.buffer));
  })
);

/**
 * @swagger
 * /fraud/evidence:
 *   get:
 *     summary: "[Staff] 15-minute link to a verification / appeal evidence file"
 *     tags: [Verification & Fraud]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: query, name: path, required: true, schema: { type: string } }]
 *     responses: { 200: { description: "{ url }" } }
 */
router.get(
  '/evidence',
  authorize(...STAFF),
  asyncHandler(async (req, res) => {
    const path = String(req.query.path || '');
    if (!/^(verifications|appeals)\//.test(path) || path.includes('..')) throw require('../utils/httpError').badRequest('Invalid evidence path');
    const { generateSignedReadUrl } = require('../utils/storage');
    return success(res, 200, 'Evidence link', { url: await generateSignedReadUrl(path, 15 * 60 * 1000) });
  })
);

module.exports = router;
