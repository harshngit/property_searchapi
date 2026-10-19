const express = require('express');
const { body, param, query } = require('express-validator');
const validate = require('../middlewares/validate');
const { authenticate, authorize } = require('../middlewares/auth');
const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const auditService = require('../services/audit.service');
const finance = require('../services/finance.service');

// Modules 25 (Loan / Financing) and 26 (Insurance). Mounted at /api/finance.
// Referral only - the platform never lends, disburses, issues a policy or
// takes a premium.

const router = express.Router();
const STAFF = ['internal_sales', 'admin', 'super_admin'];
const ADMIN = ['admin', 'super_admin'];
const meta = (req) => auditService.requestMeta(req);
const ok = (res, message, data, code = 200) => success(res, code, message, data);
const id = [param('id').isUUID()];

/**
 * @swagger
 * tags:
 *   - name: Loan & Financing
 *     description: >
 *       Module 25 - income + property value, documents linked, indicative eligibility, lender options, application submitted,
 *       handed to the lender's Loan Officer (LO code), sanction and disbursement tracked. Referral only.
 *   - name: Insurance
 *     description: >
 *       Module 26 - property details pre-filled, coverage options, insurer selected, handed to the IRDAI-licensed Insurance Officer
 *       (IO code), policy confirmed. Referral only - no premium or commission passes through the platform.
 */

/**
 * @swagger
 * /finance/loans/eligibility:
 *   post:
 *     summary: Public - indicative loan eligibility and the empanelled lenders that fit (nothing is saved)
 *     tags: [Loan & Financing]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               loanType: { type: string, enum: [home_loan, commercial_property_loan, construction_finance, lap, nri_mortgage, builder_project_loan] }
 *               monthlyIncome: { type: number }
 *               existingEmi: { type: number }
 *               propertyValue: { type: number }
 *               loanAmountRequested: { type: number }
 *               tenureYears: { type: integer }
 *               city: { type: string }
 *     responses: { 200: { description: Eligibility, lender options and the disclaimer } }
 */
const loanRules = [
  body('loanType').optional().isIn(finance.LOAN_TYPES), body('monthlyIncome').optional({ nullable: true }).isFloat({ min: 0 }), body('existingEmi').optional({ nullable: true }).isFloat({ min: 0 }),
  body('propertyValue').optional({ nullable: true }).isFloat({ min: 0 }), body('loanAmountRequested').optional({ nullable: true }).isFloat({ min: 0 }), body('tenureYears').optional({ nullable: true }).isInt({ min: 1, max: 30 }),
  body('city').optional({ nullable: true }).isString().isLength({ max: 100 }), body('dealId').optional({ nullable: true }).isUUID(), body('propertyId').optional({ nullable: true }).isUUID(),
];
router.post('/loans/eligibility', loanRules, validate, asyncHandler(async (req, res) => ok(res, 'Indicative eligibility', await finance.checkEligibility(req.body))));

router.use(authenticate);
// Panel partners (advocates, loan and insurance officers) work their cases from /partner-desk only,
// where each step they may take is checked - never through the client or staff routes here.
router.use((req, res, next) => (['legal_professional', 'loan_officer', 'insurance_officer'].includes(req.user.role) ? res.status(403).json({ success: false, message: 'Use your partner desk for your cases', errors: null }) : next()));

// ------------------------------------------------------------------- loans
/**
 * @swagger
 * /finance/loans/mine:
 *   get:
 *     summary: My loan applications - status, lender, loan officer (name and LO code), sanction, disbursement schedule
 *     tags: [Loan & Financing]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Applications } }
 */
router.get('/loans/mine', asyncHandler(async (req, res) => ok(res, 'Loan applications', await finance.myLoans(req.user))));
/**
 * @swagger
 * /finance/loans:
 *   post:
 *     summary: Start a loan application - eligibility worked out, lender options returned, documents on file linked
 *     tags: [Loan & Financing]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 201: { description: Application with eligibility and lender options } }
 *   get:
 *     summary: "[Staff] Loan desk - every application with totals (to refer, with lender, sanctioned, disbursed)"
 *     tags: [Loan & Financing]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Applications and totals } }
 */
router.post('/loans', [...loanRules, body('leadId').optional({ nullable: true }).isUUID(), body('customerId').optional({ nullable: true }).isUUID()], validate, asyncHandler(async (req, res) => ok(res, 'Loan application started', await finance.startLoan(req.user, req.body, meta(req)), 201)));
router.get('/loans', authorize(...STAFF), [query('status').optional().isIn(['started', 'submitted', 'referred', 'sanctioned', 'disbursed', 'rejected', 'withdrawn']), query('institutionId').optional().isUUID(), query('q').optional().isString().isLength({ max: 100 })], validate, asyncHandler(async (req, res) => ok(res, 'Loan applications', await finance.listLoans(req.query))));
router.get('/loans/:id', id, validate, asyncHandler(async (req, res) => ok(res, 'Loan application', await finance.getLoan(req.user, req.params.id))));
router.put('/loans/:id', [...id, ...loanRules], validate, asyncHandler(async (req, res) => ok(res, 'Loan application updated', await finance.updateLoan(req.user, req.params.id, req.body, meta(req)))));
/**
 * @swagger
 * /finance/loans/{id}/submit:
 *   post:
 *     summary: Submit the application, optionally naming the preferred lender from the options
 *     tags: [Loan & Financing]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Application } }
 */
router.post('/loans/:id/submit', [...id, body('institutionId').optional({ nullable: true }).isUUID()], validate, asyncHandler(async (req, res) => ok(res, 'Application submitted', await finance.submitLoan(req.user, req.params.id, req.body, meta(req)))));
router.post('/loans/:id/withdraw', [...id, body('reason').optional().isString().isLength({ max: 300 })], validate, asyncHandler(async (req, res) => ok(res, 'Application withdrawn', await finance.withdrawLoan(req.user, req.params.id, req.body.reason, meta(req)))));
/**
 * @swagger
 * /finance/loans/{id}/refer:
 *   post:
 *     summary: "[Staff] Hand the application to the lender's verified Loan Officer - the deal's loan referral is recorded"
 *     tags: [Loan & Financing]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Application } }
 */
router.post('/loans/:id/refer', authorize(...STAFF), [...id, body('institutionId').optional({ nullable: true }).isUUID(), body('officerId').isUUID(), body('note').optional({ nullable: true }).isString().isLength({ max: 1000 })], validate, asyncHandler(async (req, res) => ok(res, 'Referred to the lender', await finance.referLoan(req.user, req.params.id, req.body, meta(req)))));
router.post('/loans/:id/handoff', authorize(...STAFF), id, validate, asyncHandler(async (req, res) => ok(res, 'Hand-off pack', await finance.loanHandoff(req.user, req.params.id, meta(req)))));
/**
 * @swagger
 * /finance/loans/{id}/status:
 *   put:
 *     summary: "[Staff] Lender approval status (sanctioned / rejected / disbursed), lender reference and the disbursement schedule"
 *     tags: [Loan & Financing]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Application } }
 */
router.put(
  '/loans/:id/status',
  authorize(...STAFF),
  [...id, body('status').optional().isIn(['sanctioned', 'disbursed', 'rejected', 'withdrawn']), body('sanctionedAmount').optional({ nullable: true }).isFloat({ gt: 0 }), body('sanctionedRate').optional({ nullable: true }).isFloat({ gt: 0, max: 40 }),
    body('sanctionedOn').optional({ nullable: true }).isISO8601(), body('disbursementSchedule').optional().isArray({ max: 24 }), body('note').optional({ nullable: true }).isString().isLength({ max: 2000 })],
  validate,
  asyncHandler(async (req, res) => ok(res, 'Loan application updated', await finance.updateLoanStatus(req.user, req.params.id, req.body, meta(req))))
);
router.post('/loans/:id/documents', authorize(...STAFF), [...id, body('documentId').isUUID()], validate, asyncHandler(async (req, res) => ok(res, 'Document linked', await finance.linkDocument(req.user, 'loan', req.params.id, req.body.documentId, meta(req)))));

// --------------------------------------------------------------- insurance
/**
 * @swagger
 * /finance/insurance/preview:
 *   get:
 *     summary: Property details pre-filled from the deal / listing, and the insurers offering each cover
 *     tags: [Insurance]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: dealId, schema: { type: string, format: uuid } }
 *       - { in: query, name: propertyId, schema: { type: string, format: uuid } }
 *     responses: { 200: { description: Pre-filled details and coverage options } }
 */
router.get('/insurance/preview', [query('dealId').optional().isUUID(), query('propertyId').optional().isUUID()], validate, asyncHandler(async (req, res) => ok(res, 'Insurance options', await finance.insurancePreview(req.user, req.query))));
router.get('/insurance/mine', asyncHandler(async (req, res) => ok(res, 'Insurance requests', await finance.myInsurance(req.user))));
/**
 * @swagger
 * /finance/insurance:
 *   post:
 *     summary: Ask for insurance on a deal or property - details pre-filled, optionally with the insurer already chosen
 *     tags: [Insurance]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 201: { description: Insurance request } }
 *   get:
 *     summary: "[Staff] Insurance desk - every request with totals (to refer, with insurer, issued, renewing soon)"
 *     tags: [Insurance]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Requests and totals } }
 */
router.post(
  '/insurance',
  [body('coverType').isIn(finance.COVER_TYPES), body('sumInsured').optional({ nullable: true }).isFloat({ gt: 0 }), body('institutionId').optional({ nullable: true }).isUUID(), body('dealId').optional({ nullable: true }).isUUID(),
    body('propertyId').optional({ nullable: true }).isUUID(), body('leadId').optional({ nullable: true }).isUUID(), body('customerId').optional({ nullable: true }).isUUID(), body('loanApplicationId').optional({ nullable: true }).isUUID()],
  validate,
  asyncHandler(async (req, res) => ok(res, 'Insurance requested', await finance.requestInsurance(req.user, req.body, meta(req)), 201))
);
router.get('/insurance', authorize(...STAFF), [query('status').optional().isIn(['requested', 'option_selected', 'referred', 'issued', 'declined', 'cancelled']), query('institutionId').optional().isUUID(), query('q').optional().isString().isLength({ max: 100 })], validate, asyncHandler(async (req, res) => ok(res, 'Insurance requests', await finance.listInsurance(req.query))));
router.get('/insurance/:id', id, validate, asyncHandler(async (req, res) => ok(res, 'Insurance request', await finance.getInsurance(req.user, req.params.id))));
/**
 * @swagger
 * /finance/insurance/{id}/select:
 *   post:
 *     summary: Choose an insurer from the coverage options
 *     tags: [Insurance]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Insurance request } }
 */
router.post('/insurance/:id/select', [...id, body('institutionId').isUUID()], validate, asyncHandler(async (req, res) => ok(res, 'Insurer chosen', await finance.selectInsurer(req.user, req.params.id, req.body, meta(req)))));
router.post('/insurance/:id/cancel', [...id, body('reason').optional().isString().isLength({ max: 300 })], validate, asyncHandler(async (req, res) => ok(res, 'Request cancelled', await finance.cancelInsurance(req.user, req.params.id, req.body.reason, meta(req)))));
/**
 * @swagger
 * /finance/insurance/{id}/refer:
 *   post:
 *     summary: "[Staff] Hand the request to the insurer's verified, IRDAI-licensed Insurance Officer - the deal's insurance referral is recorded"
 *     tags: [Insurance]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Insurance request } }
 */
router.post('/insurance/:id/refer', authorize(...STAFF), [...id, body('institutionId').optional({ nullable: true }).isUUID(), body('officerId').isUUID(), body('note').optional({ nullable: true }).isString().isLength({ max: 1000 })], validate, asyncHandler(async (req, res) => ok(res, 'Referred to the insurer', await finance.referInsurance(req.user, req.params.id, req.body, meta(req)))));
router.post('/insurance/:id/handoff', authorize(...STAFF), id, validate, asyncHandler(async (req, res) => ok(res, 'Hand-off pack', await finance.insuranceHandoff(req.user, req.params.id, meta(req)))));
/**
 * @swagger
 * /finance/insurance/{id}/status:
 *   put:
 *     summary: "[Staff] Confirm the policy issued by the insurer (number, dates), or mark the request declined / cancelled"
 *     tags: [Insurance]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Insurance request } }
 */
router.put(
  '/insurance/:id/status',
  authorize(...STAFF),
  [...id, body('status').optional().isIn(['issued', 'declined', 'cancelled']), body('policyNumber').optional({ nullable: true }).isString().isLength({ max: 80 }), body('policyStart').optional({ nullable: true }).isISO8601(), body('policyEnd').optional({ nullable: true }).isISO8601(),
    body('premiumAmount').optional({ nullable: true }).isFloat({ min: 0 }), body('note').optional({ nullable: true }).isString().isLength({ max: 2000 })],
  validate,
  asyncHandler(async (req, res) => ok(res, 'Insurance request updated', await finance.updateInsuranceStatus(req.user, req.params.id, req.body, meta(req))))
);
router.post('/insurance/:id/documents', authorize(...STAFF), [...id, body('documentId').isUUID()], validate, asyncHandler(async (req, res) => ok(res, 'Document linked', await finance.linkDocument(req.user, 'insurance', req.params.id, req.body.documentId, meta(req)))));

/**
 * @swagger
 * /finance/deals/{id}:
 *   get:
 *     summary: "[Staff] Loan applications and insurance requests on one deal"
 *     tags: [Loan & Financing]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Loans and insurance } }
 */
router.get('/deals/:id', authorize(...STAFF), id, validate, asyncHandler(async (req, res) => ok(res, 'Deal finance', await finance.forDeal(req.params.id))));

// ------------------------------------------------------------------- panel
/**
 * @swagger
 * /finance/institutions:
 *   get:
 *     summary: "[Staff] The panel - banks, NBFCs, housing finance companies and insurers with products, indicative terms and referral counts"
 *     tags: [Loan & Financing]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Institutions } }
 *   post:
 *     summary: "[Admin] Add an institution (pending until its empanelment is recorded)"
 *     tags: [Loan & Financing]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 201: { description: Institution } }
 */
router.get('/institutions', authorize(...STAFF), [query('kind').optional().isIn(['bank', 'nbfc', 'hfc', 'insurer', 'lender']), query('status').optional().isIn(['pending', 'empanelled', 'suspended'])], validate, asyncHandler(async (req, res) => ok(res, 'Institutions', { institutions: await finance.listInstitutions(req.query), loanTypes: finance.LOAN_TYPES, coverTypes: finance.COVER_TYPES })));
router.post('/institutions', authorize(...ADMIN), [body('kind').isIn(['bank', 'nbfc', 'hfc', 'insurer']), body('name').trim().isLength({ min: 2, max: 200 })], validate, asyncHandler(async (req, res) => ok(res, 'Institution added', await finance.saveInstitution(req.user, req.body, meta(req)), 201)));
router.put('/institutions/:id', authorize(...ADMIN), id, validate, asyncHandler(async (req, res) => ok(res, 'Institution saved', await finance.saveInstitution(req.user, { ...req.body, id: req.params.id }, meta(req)))));
/**
 * @swagger
 * /finance/institutions/{id}/decision:
 *   post:
 *     summary: "[Admin] Empanel (letter / IRDAI registration on record), suspend or reinstate an institution"
 *     tags: [Loan & Financing]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Institution } }
 */
router.post('/institutions/:id/decision', authorize(...ADMIN), [...id, body('action').isIn(['empanel', 'suspend', 'reinstate']), body('note').trim().isLength({ min: 5, max: 1000 })], validate, asyncHandler(async (req, res) => ok(res, 'Decision recorded', await finance.decideInstitution(req.user, req.params.id, req.body, meta(req)))));
/**
 * @swagger
 * /finance/officers:
 *   get:
 *     summary: "[Staff] Loan Officers and Insurance Officers with their LO / IO code"
 *     tags: [Loan & Financing]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Officers } }
 *   post:
 *     summary: "[Admin] Add a partner officer (no code until verified)"
 *     tags: [Loan & Financing]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 201: { description: Officer } }
 */
router.get('/officers', authorize(...STAFF), [query('institutionId').optional().isUUID(), query('role').optional().isIn(['LO', 'IO']), query('status').optional().isIn(['pending', 'verified', 'suspended'])], validate, asyncHandler(async (req, res) => ok(res, 'Officers', await finance.listOfficers(req.query))));
router.post('/officers', authorize(...ADMIN), [body('institutionId').isUUID(), body('fullName').trim().isLength({ min: 2, max: 150 })], validate, asyncHandler(async (req, res) => ok(res, 'Officer added', await finance.saveOfficer(req.user, req.body, meta(req)), 201)));
router.put('/officers/:id', authorize(...ADMIN), id, validate, asyncHandler(async (req, res) => ok(res, 'Officer saved', await finance.saveOfficer(req.user, { ...req.body, id: req.params.id }, meta(req)))));
/**
 * @swagger
 * /finance/officers/{id}/decision:
 *   post:
 *     summary: "[Admin] Verify (issues the LO / IO code; an IO needs the IRDAI licence number), suspend or reinstate an officer"
 *     tags: [Loan & Financing]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Officer } }
 */
router.post('/officers/:id/decision', authorize(...ADMIN), [...id, body('action').isIn(['verify', 'suspend', 'reinstate']), body('note').trim().isLength({ min: 5, max: 1000 })], validate, asyncHandler(async (req, res) => ok(res, 'Decision recorded', await finance.decideOfficer(req.user, req.params.id, req.body, meta(req)))));

module.exports = router;
