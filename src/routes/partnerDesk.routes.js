const express = require('express');
const { body, param, query } = require('express-validator');
const router = express.Router();

const validate = require('../middlewares/validate');
const { authenticate, authorize } = require('../middlewares/auth');
const { uploadDocumentFile } = require('../middlewares/upload');
const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const auditService = require('../services/audit.service');
const desk = require('../services/partnerDesk.service');

// Separate logins for advocates / valuers (LP), loan officers (LO) and
// insurance officers (IO): their own cases only, their own steps only.
const meta = (req) => auditService.requestMeta(req);
const h = asyncHandler;
const ok = (res, msg, data, code = 200) => success(res, code, msg, data);
const KIND = param('kind').isIn(['legal', 'loan', 'insurance']);
const ID = param('id').isUUID();

router.use(authenticate);

/**
 * @swagger
 * tags:
 *   - name: Partner desk
 *     description: The panel partners' own login - an advocate's cases, a loan officer's applications, an insurance officer's requests. Non-commission-bearing (sec. 33.8).
 * /partner-desk/logins:
 *   post:
 *     summary: Create the login for an empanelled professional or a verified officer (admin)
 *     tags: [Partner desk]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [kind, id, password]
 *             properties:
 *               kind: { type: string, enum: [legal, officer] }
 *               id: { type: string, format: uuid, description: legal_professionals.id or partner_officers.id }
 *               email: { type: string, description: Defaults to the panel record's email }
 *               password: { type: string, minLength: 8 }
 *               mobile: { type: string }
 */
router.post(
  '/logins',
  authorize('admin', 'super_admin'),
  [body('kind').isIn(['legal', 'officer']), body('id').isUUID(), body('email').optional().isEmail(), body('password').isString().isLength({ min: 8, max: 128 }), body('mobile').optional({ nullable: true }).isString().isLength({ max: 20 })],
  validate,
  h(async (req, res) => ok(res, 'Login created', await desk.createLogin(req.user, req.body.kind, req.body.id, req.body, meta(req)), 201))
);

router.use(authorize(...desk.ROLES));

/**
 * @swagger
 * /partner-desk/me:
 *   get:
 *     summary: The partner's code, firm / institution and a summary of their work
 *     tags: [Partner desk]
 *     security: [{ bearerAuth: [] }]
 * /partner-desk/{kind}:
 *   get:
 *     summary: The partner's cases (legal), applications (loan) or requests (insurance)
 *     tags: [Partner desk]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: kind, required: true, schema: { type: string, enum: [legal, loan, insurance] } }
 *       - { in: query, name: open, schema: { type: boolean } }
 * /partner-desk/{kind}/{id}:
 *   get:
 *     summary: One case with its documents and timeline (no client contact details)
 *     tags: [Partner desk]
 *     security: [{ bearerAuth: [] }]
 *   put:
 *     summary: Take one of the partner's own steps (e.g. in progress, sanctioned, issued) or add a note
 *     tags: [Partner desk]
 *     security: [{ bearerAuth: [] }]
 * /partner-desk/{kind}/{id}/document-request:
 *   post:
 *     summary: Ask the client, through A R Buildwel, for documents
 *     tags: [Partner desk]
 *     security: [{ bearerAuth: [] }]
 * /partner-desk/{kind}/{id}/documents:
 *   post:
 *     summary: Upload a file to the case (multipart "file"; documentType; asReport for a legal report)
 *     tags: [Partner desk]
 *     security: [{ bearerAuth: [] }]
 * /partner-desk/{kind}/{id}/documents/{documentId}:
 *   get:
 *     summary: A short-lived link to a document on the case
 *     tags: [Partner desk]
 *     security: [{ bearerAuth: [] }]
 * /partner-desk/legal/{id}/fee:
 *   put:
 *     summary: Record the fee quoted / invoiced / paid - settled directly with the client, no platform share
 *     tags: [Partner desk]
 *     security: [{ bearerAuth: [] }]
 */
router.get('/me', h(async (req, res) => ok(res, 'Partner desk', await desk.me(req.user))));

const lists = { legal: desk.legalCases, loan: desk.loans, insurance: desk.insuranceList };
const ones = { legal: desk.legalCase, loan: desk.loan, insurance: desk.insurance };
router.get('/:kind', [KIND, query('open').optional().isBoolean()], validate, h(async (req, res) => ok(res, 'Cases', await lists[req.params.kind](req.user, { open: req.query.open === 'true' }))));
router.get('/:kind/:id', [KIND, ID], validate, h(async (req, res) => ok(res, 'Case', await ones[req.params.kind](req.user, req.params.id))));

router.put(
  '/legal/:id/fee',
  [ID, body('amount').isFloat({ min: 0 }), body('status').isIn(['quoted', 'invoiced', 'paid']), body('note').optional({ nullable: true }).isString().isLength({ max: 300 })],
  validate,
  h(async (req, res) => ok(res, 'Fee recorded', await desk.setFee(req.user, req.params.id, req.body, meta(req))))
);

router.put(
  '/:kind/:id',
  [KIND, ID, body('status').optional({ nullable: true }).isString().isLength({ max: 20 }), body('note').optional({ nullable: true }).isString().isLength({ max: 2000 }), body('clientVisible').optional().isBoolean()],
  validate,
  h(async (req, res) => ok(res, 'Updated', await desk.update(req.user, req.params.kind, req.params.id, req.body, meta(req))))
);

router.post(
  '/:kind/:id/document-request',
  [KIND, ID, body('note').isString().isLength({ min: 5, max: 600 })],
  validate,
  h(async (req, res) => ok(res, 'Documents requested', await desk.requestDocuments(req.user, req.params.kind, req.params.id, req.body, meta(req))))
);

router.post(
  '/:kind/:id/documents',
  uploadDocumentFile.single('file'),
  [KIND, ID, body('documentType').optional().isIn(desk.DOC_TYPES), body('asReport').optional().isBoolean()],
  validate,
  h(async (req, res) => ok(res, 'Document added', await desk.upload(req.user, req.params.kind, req.params.id, req.file, { documentType: req.body.documentType, asReport: req.body.asReport === 'true' || req.body.asReport === true }, meta(req)), 201))
);

router.get('/:kind/:id/documents/:documentId', [KIND, ID, param('documentId').isUUID()], validate, h(async (req, res) => ok(res, 'Document link', await desk.documentUrl(req.user, req.params.kind, req.params.id, req.params.documentId))));

module.exports = router;
