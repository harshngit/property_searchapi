const express = require('express');
const { body, param } = require('express-validator');
const validate = require('../middlewares/validate');
const { authenticate, authorize } = require('../middlewares/auth');
const { uploadDocumentFile } = require('../middlewares/upload');
const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const auditService = require('../services/audit.service');
const dd = require('../services/dueDiligence.service');

// Module 20 Document Repository + Module 21 Due Diligence Engine.
// Mounted at /api/due-diligence.

const router = express.Router();
router.use(authenticate);
const STAFF = ['internal_sales', 'admin', 'super_admin'];
const meta = (req) => auditService.requestMeta(req);
const DOCUMENT_TYPES = [
  'kyc', 'agreement', 'payment_receipt', 'noc', 'other', 'sale_deed', 'agreement_to_sell', 'id_proof', 'tax_receipt',
  'encumbrance_certificate', 'title_document', 'allotment_letter', 'occupancy_certificate', 'completion_certificate',
  'approved_plan', 'mutation_record', 'society_noc', 'bank_noc', 'power_of_attorney', 'possession_letter',
  'rent_agreement', 'utility_bill', 'rera_certificate',
];
const VISIBILITY = ['owner', 'broker', 'buyer', 'admin'];

/**
 * @swagger
 * tags:
 *   name: Due Diligence
 *   description: >
 *     Module 20 / 21 - documents per listing with role visibility (owner / broker / buyer / admin), AI + rule-based
 *     classification and risk flags, checklist with missing-document detection, title chain, encumbrance, possession
 *     risk and NRI considerations. Facilitation only - not legal advice.
 */

/**
 * @swagger
 * /due-diligence/properties/{id}:
 *   get:
 *     summary: Due-diligence report for a listing - checklist (missing items), title chain (years, gaps), encumbrance, possession risk, risk flags, NRI considerations
 *     tags: [Due Diligence]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Report }, 403: { description: No relationship to the listing } }
 */
router.get('/properties/:id', [param('id').isUUID()], validate, asyncHandler(async (req, res) => success(res, 200, 'Due diligence', await dd.report(req.user, req.params.id))));

/**
 * @swagger
 * /due-diligence/properties/{id}/documents:
 *   get:
 *     summary: Documents on the listing (and its deals) that the caller's role may see
 *     tags: [Due Diligence]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: "{ roles, documents }" } }
 *   post:
 *     summary: Add a document to the listing (owner, listing broker or A R staff) - classified and risk-scanned on upload
 *     tags: [Due Diligence]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file: { type: string, format: binary }
 *               documentType: { type: string, description: Leave empty to auto-classify }
 *               visibleTo: { type: string, description: 'Comma-separated: owner, broker, buyer (admin always)' }
 *               documentUrl: { type: string, description: Existing stored path / link instead of a file }
 *     responses: { 201: { description: Document id, type and analysis } }
 */
router.get('/properties/:id/documents', [param('id').isUUID()], validate, asyncHandler(async (req, res) => success(res, 200, 'Documents', await dd.listPropertyDocuments(req.user, req.params.id))));
router.post(
  '/properties/:id/documents',
  uploadDocumentFile.single('file'),
  [
    param('id').isUUID(),
    body('documentType').optional({ checkFalsy: true }).isIn(DOCUMENT_TYPES),
    body('visibleTo').optional().customSanitizer((v) => (Array.isArray(v) ? v : String(v || '').split(',').map((x) => x.trim()).filter(Boolean))),
    body('visibleTo.*').optional().isIn(VISIBILITY),
    body('documentUrl').optional().isString().isLength({ max: 500 }),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const out = await dd.addPropertyDocument(
      req.user,
      req.params.id,
      { documentType: req.body.documentType || null, visibleTo: req.body.visibleTo, documentUrl: req.body.documentUrl, fileName: req.body.fileName, file: req.file },
      meta(req)
    );
    return success(res, 201, 'Document added', out);
  })
);

/**
 * @swagger
 * /due-diligence/properties/{id}/title-links:
 *   post:
 *     summary: "[Staff] Add a title-chain link (transfer) found in records not uploaded as a document"
 *     tags: [Due Diligence]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { type: object, required: [date], properties: { date: { type: string, format: date }, from: { type: string }, to: { type: string }, note: { type: string } } } } }
 *     responses: { 200: { description: Updated report } }
 */
router.post(
  '/properties/:id/title-links',
  authorize(...STAFF),
  [param('id').isUUID(), body('date').isISO8601(), body('from').optional().isString().isLength({ max: 200 }), body('to').optional().isString().isLength({ max: 200 }), body('note').optional().isString().isLength({ max: 500 })],
  validate,
  asyncHandler(async (req, res) => success(res, 200, 'Title link added', await dd.addTitleLink(req.user, req.params.id, req.body, meta(req))))
);

/**
 * @swagger
 * /due-diligence/properties/{id}/review:
 *   put:
 *     summary: "[Staff] Record a due-diligence review with notes"
 *     tags: [Due Diligence]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       content: { application/json: { schema: { type: object, properties: { notes: { type: string } } } } }
 *     responses: { 200: { description: Report } }
 */
router.put(
  '/properties/:id/review',
  authorize(...STAFF),
  [param('id').isUUID(), body('notes').optional().isString().isLength({ max: 4000 })],
  validate,
  asyncHandler(async (req, res) => success(res, 200, 'Reviewed', await dd.review(req.user, req.params.id, req.body, meta(req))))
);

/**
 * @swagger
 * /due-diligence/documents/{id}/review:
 *   put:
 *     summary: "[Staff] Approve or reject a document (reason recommended); the checklist updates"
 *     tags: [Due Diligence]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { type: object, required: [status], properties: { status: { type: string, enum: [approved, rejected] }, notes: { type: string } } } } }
 *     responses: { 200: { description: Document } }
 */
router.put(
  '/documents/:id/review',
  authorize(...STAFF),
  [param('id').isUUID(), body('status').isIn(['approved', 'rejected']), body('notes').optional().isString().isLength({ max: 1000 })],
  validate,
  asyncHandler(async (req, res) => success(res, 200, 'Document reviewed', await dd.reviewDocument(req.user, req.params.id, req.body, meta(req))))
);

/**
 * @swagger
 * /due-diligence/queue:
 *   get:
 *     summary: "[Staff] Listings with due-diligence issues, missing documents or documents awaiting review"
 *     tags: [Due Diligence]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Queue } }
 */
router.get('/queue', authorize(...STAFF), asyncHandler(async (req, res) => success(res, 200, 'Due diligence queue', await dd.queue())));

/**
 * @swagger
 * /due-diligence/analyse:
 *   post:
 *     summary: "[Staff] Classify and risk-scan any document without storing it (PDF / image / text)"
 *     tags: [Due Diligence]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content: { multipart/form-data: { schema: { type: object, required: [file], properties: { file: { type: string, format: binary } } } } }
 *     responses: { 200: { description: "{ type, confidence, method, summary, extracted, flags }" } }
 */
router.post(
  '/analyse',
  authorize(...STAFF),
  uploadDocumentFile.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw require('../utils/httpError').badRequest('Attach a document');
    return success(res, 200, 'Document analysed', await dd.analyse(req.file.buffer, req.file.mimetype, req.file.originalname));
  })
);

module.exports = router;
