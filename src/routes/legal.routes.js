const express = require('express');
const { body, param, query } = require('express-validator');
const validate = require('../middlewares/validate');
const { authenticate, authorize } = require('../middlewares/auth');
const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const auditService = require('../services/audit.service');
const legal = require('../services/legal.service');

// Module 24 - Legal Integration. Mounted at /api/legal.
//   Clients : ask for legal help, follow the case (advocate, status, timeline)
//   Staff   : the panel of empanelled advocates / valuers (LP codes), case
//             desk: assign, hand off, track to completion

const router = express.Router();
const STAFF = ['internal_sales', 'admin', 'super_admin'];
const ADMIN = ['admin', 'super_admin'];
const meta = (req) => auditService.requestMeta(req);
const ok = (res, message, data, code = 200) => success(res, code, message, data);
router.use(authenticate);
// Panel partners (advocates, loan and insurance officers) work their cases from /partner-desk only,
// where each step they may take is checked - never through the client or staff routes here.
router.use((req, res, next) => (['legal_professional', 'loan_officer', 'insurance_officer'].includes(req.user.role) ? res.status(403).json({ success: false, message: 'Use your partner desk for your cases', errors: null }) : next()));

/**
 * @swagger
 * tags:
 *   name: Legal Integration
 *   description: >
 *     Module 24 - describe the requirement, documents auto-linked, advocate assigned, status tracked. Empanelled advocates and
 *     registered valuers carry an LP code issued only after the enrolment check; the code is never commission-bearing.
 *     A R Buildwel refers and coordinates - the client engages the advocate directly.
 */

/**
 * @swagger
 * /legal/cases/mine:
 *   get:
 *     summary: My legal cases - service, status, assigned advocate (name, firm, LP code), due date
 *     tags: [Legal Integration]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Cases, the service list and the disclaimer } }
 */
router.get('/cases/mine', asyncHandler(async (req, res) => ok(res, 'Legal cases', await legal.myCases(req.user))));

/**
 * @swagger
 * /legal/cases:
 *   post:
 *     summary: Ask for legal help - the documents already on file for the deal / property are linked automatically
 *     tags: [Legal Integration]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [serviceType, requirement]
 *             properties:
 *               serviceType: { type: string, enum: [due_diligence, title_verification, agreement_drafting, registration_support, valuation, other] }
 *               requirement: { type: string }
 *               dealId: { type: string, format: uuid }
 *               propertyId: { type: string, format: uuid }
 *               leadId: { type: string, format: uuid, description: Staff only }
 *               customerId: { type: string, format: uuid, description: Staff only }
 *     responses: { 201: { description: Legal case } }
 *   get:
 *     summary: "[Staff] Legal desk - every case with totals (to assign, in progress, report ready, overdue)"
 *     tags: [Legal Integration]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Cases and totals } }
 */
const caseRules = [body('serviceType').isIn(legal.SERVICES), body('requirement').trim().isLength({ min: 10, max: 4000 }), body('dealId').optional({ nullable: true }).isUUID(), body('propertyId').optional({ nullable: true }).isUUID(), body('leadId').optional({ nullable: true }).isUUID(), body('customerId').optional({ nullable: true }).isUUID()];
router.post('/cases', caseRules, validate, asyncHandler(async (req, res) => ok(res, 'Legal case opened', STAFF.includes(req.user.role) ? await legal.openCase(req.user, req.body, meta(req)) : await legal.requestCase(req.user, req.body, meta(req)), 201)));
router.get(
  '/cases',
  authorize(...STAFF),
  [query('status').optional().isIn(['requested', 'advocate_assigned', 'in_progress', 'report_ready', 'completed', 'cancelled']), query('serviceType').optional().isIn(legal.SERVICES), query('professionalId').optional().isUUID(), query('q').optional().isString().isLength({ max: 100 }), query('open').optional().isBoolean()],
  validate,
  asyncHandler(async (req, res) => ok(res, 'Legal cases', await legal.listCases({ ...req.query, open: req.query.open === 'true' })))
);

/**
 * @swagger
 * /legal/deals/{dealId}/cases:
 *   get:
 *     summary: "[Staff] Legal cases on one deal"
 *     tags: [Legal Integration]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: dealId, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Cases } }
 */
router.get('/deals/:dealId/cases', authorize(...STAFF), [param('dealId').isUUID()], validate, asyncHandler(async (req, res) => ok(res, 'Legal cases', await legal.forDeal(req.params.dealId))));

/**
 * @swagger
 * /legal/cases/{id}:
 *   get:
 *     summary: One legal case - status timeline, linked documents, advocate. Clients see their own; staff see all.
 *     tags: [Legal Integration]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Legal case } }
 */
router.get('/cases/:id', [param('id').isUUID()], validate, asyncHandler(async (req, res) => ok(res, 'Legal case', await legal.getCase(req.user, req.params.id))));

/**
 * @swagger
 * /legal/cases/{id}/cancel:
 *   post:
 *     summary: Cancel my request while no advocate has been assigned
 *     tags: [Legal Integration]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Legal case } }
 */
router.post('/cases/:id/cancel', [param('id').isUUID(), body('reason').optional().isString().isLength({ max: 300 })], validate, asyncHandler(async (req, res) => ok(res, 'Legal case cancelled', await legal.cancelMine(req.user, req.params.id, req.body.reason, meta(req)))));

/**
 * @swagger
 * /legal/cases/{id}/assign:
 *   post:
 *     summary: "[Staff] Assign an empanelled advocate / valuer, or record the client's own chosen advocate - sets the due date"
 *     tags: [Legal Integration]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Legal case } }
 */
router.post('/cases/:id/assign', authorize(...STAFF), [param('id').isUUID(), body('professionalId').optional({ nullable: true }).isUUID(), body('clientAdvocateName').optional({ nullable: true }).isString().isLength({ max: 150 }), body('note').optional({ nullable: true }).isString().isLength({ max: 1000 })], validate, asyncHandler(async (req, res) => ok(res, 'Advocate assigned', await legal.assign(req.user, req.params.id, req.body, meta(req)))));

/**
 * @swagger
 * /legal/cases/{id}/handoff:
 *   post:
 *     summary: "[Staff] Hand-off pack for the advocate - brief plus time-limited links to the linked documents; recorded on the case"
 *     tags: [Legal Integration]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Hand-off pack } }
 */
router.post('/cases/:id/handoff', authorize(...STAFF), [param('id').isUUID()], validate, asyncHandler(async (req, res) => ok(res, 'Hand-off pack', await legal.handoff(req.user, req.params.id, meta(req)))));

/**
 * @swagger
 * /legal/cases/{id}/status:
 *   put:
 *     summary: "[Staff] Move the case on (in progress, report ready, completed, cancelled), add a note, attach the report"
 *     tags: [Legal Integration]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Legal case } }
 */
router.put(
  '/cases/:id/status',
  authorize(...STAFF),
  [param('id').isUUID(), body('status').optional().isIn(['in_progress', 'report_ready', 'completed', 'cancelled', 'advocate_assigned']), body('note').optional({ nullable: true }).isString().isLength({ max: 2000 }), body('clientVisible').optional().isBoolean(), body('reportDocumentId').optional({ nullable: true }).isUUID()],
  validate,
  asyncHandler(async (req, res) => ok(res, 'Legal case updated', await legal.setStatus(req.user, req.params.id, req.body, meta(req))))
);
router.post('/cases/:id/documents', authorize(...STAFF), [param('id').isUUID(), body('documentId').isUUID()], validate, asyncHandler(async (req, res) => ok(res, 'Document linked', await legal.linkDocument(req.user, req.params.id, req.body.documentId, meta(req)))));

/**
 * @swagger
 * /legal/professionals:
 *   get:
 *     summary: "[Staff] The panel - empanelled advocates and registered valuers with their LP code, coverage and case load"
 *     tags: [Legal Integration]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Legal professionals } }
 *   post:
 *     summary: "[Admin] Add an advocate / valuer to the panel (pending until the enrolment check is recorded)"
 *     tags: [Legal Integration]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 201: { description: Legal professional } }
 */
router.get('/professionals', authorize(...STAFF), [query('status').optional().isIn(['pending', 'empanelled', 'suspended']), query('kind').optional().isIn(['advocate', 'valuer'])], validate, asyncHandler(async (req, res) => ok(res, 'Legal professionals', { professionals: await legal.listProfessionals(req.query), specialities: legal.SPECIALITIES })));
router.post('/professionals', authorize(...ADMIN), [body('fullName').trim().isLength({ min: 2, max: 150 }), body('enrolmentNumber').trim().isLength({ min: 3, max: 60 }), body('kind').optional().isIn(['advocate', 'valuer'])], validate, asyncHandler(async (req, res) => ok(res, 'Added to the panel', await legal.saveProfessional(req.user, req.body, meta(req)), 201)));
router.put('/professionals/:id', authorize(...ADMIN), [param('id').isUUID()], validate, asyncHandler(async (req, res) => ok(res, 'Saved', await legal.saveProfessional(req.user, { ...req.body, id: req.params.id }, meta(req)))));
/**
 * @swagger
 * /legal/professionals/{id}/decision:
 *   post:
 *     summary: "[Admin] Empanel (issues the LP code, records what was checked), suspend or reinstate"
 *     tags: [Legal Integration]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Legal professional } }
 */
router.post('/professionals/:id/decision', authorize(...ADMIN), [param('id').isUUID(), body('action').isIn(['empanel', 'suspend', 'reinstate']), body('note').trim().isLength({ min: 5, max: 1000 })], validate, asyncHandler(async (req, res) => ok(res, 'Decision recorded', await legal.decideProfessional(req.user, req.params.id, req.body, meta(req)))));

module.exports = router;
