const express = require('express');
const { body, param, query } = require('express-validator');
const router = express.Router();

const validate = require('../middlewares/validate');
const { authenticate } = require('../middlewares/auth');
const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const auditService = require('../services/audit.service');
const rp = require('../services/relatedParty.service');

// Contract sec. 33.12 - employee disclosures and the related-party Compliance Dashboard.
const meta = (req) => auditService.requestMeta(req);
const h = asyncHandler;
const ok = (res, msg, data, code = 200) => success(res, code, msg, data);
const KIND = param('entityType').isIn(['property', 'lead', 'deal']);

router.use(authenticate);

/**
 * @swagger
 * tags:
 *   - name: Related party
 *     description: Employee-as-user safeguards (sec. 33.12) - family disclosures, linked accounts, related-party transactions and their review.
 * /related-party/disclosures/mine:
 *   get:
 *     summary: An employee's own disclosures (their PAN, and immediate family's mobile / PAN)
 *     tags: [Related party]
 *     security: [{ bearerAuth: [] }]
 * /related-party/disclosures:
 *   get:
 *     summary: All disclosures (reviewers)
 *     tags: [Related party]
 *     security: [{ bearerAuth: [] }]
 *   post:
 *     summary: Add a disclosure (employee for themselves; admin for any employee). Re-checks every record.
 *     tags: [Related party]
 *     security: [{ bearerAuth: [] }]
 * /related-party/disclosures/{id}/withdraw:
 *   post:
 *     summary: Withdraw a disclosure with a reason (kept on record)
 *     tags: [Related party]
 *     security: [{ bearerAuth: [] }]
 * /related-party/me:
 *   get:
 *     summary: Whether the caller reviews related-party transactions - everything (Super Admin / central) or a city / area (City Head / Area Head)
 *     tags: [Related party]
 *     security: [{ bearerAuth: [] }]
 * /related-party/dashboard:
 *   get:
 *     summary: Related-party listings, inquiries and deals for review - a City / Area Head sees their own city / localities
 *     tags: [Related party]
 *     security: [{ bearerAuth: [] }]
 * /related-party/linked-accounts:
 *   get:
 *     summary: Accounts linked to an employee by mobile or PAN
 *     tags: [Related party]
 *     security: [{ bearerAuth: [] }]
 * /related-party/{entityType}/{id}:
 *   get:
 *     summary: Detections, reviews and cascade re-routing for one record
 *     tags: [Related party]
 *     security: [{ bearerAuth: [] }]
 * /related-party/{entityType}/{id}/review:
 *   post:
 *     summary: Record the review outcome (append-only); "undisclosed" alerts the Super Admin for a Section 35 decision
 *     tags: [Related party]
 *     security: [{ bearerAuth: [] }]
 * /related-party/rescan:
 *   post:
 *     summary: Re-check every record now (reviewers)
 *     tags: [Related party]
 *     security: [{ bearerAuth: [] }]
 */
// Whether the signed-in person reviews related-party transactions, and over what (for the CRM).
router.get('/me', h(async (req, res) => ok(res, 'Reviewer', await rp.me(req.user))));
router.get('/disclosures/mine', h(async (req, res) => ok(res, 'Disclosures', await rp.myDisclosures(req.user))));
router.get('/disclosures', [query('employeeId').optional().isUUID()], validate, h(async (req, res) => ok(res, 'Disclosures', await rp.allDisclosures(req.user, req.query))));
router.post(
  '/disclosures',
  [body('relation').isIn(rp.RELATIONS), body('fullName').optional({ nullable: true }).isString().isLength({ max: 150 }), body('mobile').optional({ nullable: true }).isString().isLength({ max: 20 }), body('pan').optional({ nullable: true }).isString().isLength({ max: 10 }), body('employeeId').optional({ nullable: true }).isUUID()],
  validate,
  h(async (req, res) => ok(res, 'Disclosure recorded', await rp.addDisclosure(req.user, req.body, meta(req)), 201))
);
router.post('/disclosures/:id/withdraw', [param('id').isUUID(), body('note').isString().isLength({ min: 5, max: 300 })], validate, h(async (req, res) => ok(res, 'Disclosure withdrawn', await rp.withdrawDisclosure(req.user, req.params.id, req.body, meta(req)))));

router.get('/dashboard', [query('entityType').optional().isIn(['property', 'lead', 'deal']), query('review').optional().isIn(['open', 'all']), query('q').optional().isString().isLength({ max: 100 })], validate, h(async (req, res) => ok(res, 'Related-party transactions', await rp.dashboard(req.user, req.query))));
router.get('/linked-accounts', h(async (req, res) => ok(res, 'Linked accounts', await rp.linkedAccounts(req.user))));
router.post('/rescan', h(async (req, res) => {
  await rp.assertCentral(req.user);
  return ok(res, 'Re-checked', await rp.rescan('manual'));
}));
router.get('/:entityType/:id', [KIND, param('id').isUUID()], validate, h(async (req, res) => ok(res, 'History', await rp.history(req.user, req.params.entityType, req.params.id))));
router.post(
  '/:entityType/:id/review',
  [KIND, param('id').isUUID(), body('outcome').isIn(['disclosed_ok', 'undisclosed', 'not_related', 'noted']), body('note').isString().isLength({ min: 5, max: 2000 })],
  validate,
  h(async (req, res) => ok(res, 'Review recorded', await rp.review(req.user, req.params.entityType, req.params.id, req.body, meta(req)), 201))
);

module.exports = router;
