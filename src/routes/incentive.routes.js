const express = require('express');
const { body, param, query } = require('express-validator');

const incentives = require('../services/incentive.service');
const auditService = require('../services/audit.service');
const validate = require('../middlewares/validate');
const { authenticate, authorize } = require('../middlewares/auth');
const { success } = require('../utils/response');
const handler = require('../utils/asyncHandler');

const router = express.Router();
const meta = (req) => auditService.requestMeta(req);
// A R staff only - employees, their team leaders and admins. EM codes never leave these screens.
router.use(authenticate, authorize('internal_sales', 'admin', 'super_admin'));
const month = query('period').optional().matches(/^\d{4}-\d{2}$/).withMessage('period is YYYY-MM');

/**
 * @swagger
 * tags:
 *   name: Incentives
 *   description: >
 *     Employee incentive engine (sec. 33 / 34). Scoring facts come from what the platform records - inquiries
 *     attended / missed (the assignment cascade), response SLA breaches, site visits completed and deals closed won
 *     on the employee's deals; related-party transactions are excluded (sec. 33.12). Months are approved and exported
 *     to payroll by the Super Admin - employees earn incentives, never commissions, and nothing is paid here.
 * /incentives:
 *   get:
 *     summary: Month board - the caller's own score, a Team Leader's team, or everyone for admins
 *     tags: [Incentives]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: query, name: period, schema: { type: string, example: "2026-11" } }]
 * /incentives/periods:
 *   get:
 *     summary: Months approved / exported
 *     tags: [Incentives]
 *     security: [{ bearerAuth: [] }]
 * /incentives/employees/{userId}:
 *   get:
 *     summary: One employee's scoring facts for a month (self, own team, or admin)
 *     tags: [Incentives]
 *     security: [{ bearerAuth: [] }]
 * /incentives/codes:
 *   get:
 *     summary: Every EM code, including retired ones, with history - Super Admin
 *     tags: [Incentives]
 *     security: [{ bearerAuth: [] }]
 * /incentives/rules:
 *   get:
 *     summary: Points per fact, points per lakh of deal value, rupees per point, minimum and monthly cap
 *     tags: [Incentives]
 *     security: [{ bearerAuth: [] }]
 *   put:
 *     summary: Change the rules - Super Admin (audited)
 *     tags: [Incentives]
 *     security: [{ bearerAuth: [] }]
 * /incentives/sync:
 *   post:
 *     summary: Score new facts now (also runs every hour) - admin
 *     tags: [Incentives]
 *     security: [{ bearerAuth: [] }]
 * /incentives/adjustments:
 *   post:
 *     summary: Add or take away points for an employee in an open month, with a reason - Super Admin
 *     tags: [Incentives]
 *     security: [{ bearerAuth: [] }]
 * /incentives/periods/{period}/approve:
 *   post:
 *     summary: Approve a finished month - statements are frozen with the rules in force - Super Admin
 *     tags: [Incentives]
 *     security: [{ bearerAuth: [] }]
 * /incentives/periods/{period}/export:
 *   get:
 *     summary: CSV of an approved month for payroll (marks it exported) - Super Admin
 *     tags: [Incentives]
 *     security: [{ bearerAuth: [] }]
 * /incentives/employees/{userId}/exit:
 *   post:
 *     summary: Record an employee's exit - the EM code is retired for good, the account switched off, open inquiries re-routed - Super Admin
 *     tags: [Incentives]
 *     security: [{ bearerAuth: [] }]
 */
router.get('/', [month], validate, handler(async (req, res) => success(res, 200, 'Incentives', await incentives.board(req.user, { period: req.query.period }))));
router.get('/periods', handler(async (req, res) => success(res, 200, 'Months', await incentives.periods(req.user))));
router.get('/codes', handler(async (req, res) => success(res, 200, 'Employee codes', await incentives.codes(req.user))));
router.get('/rules', handler(async (req, res) => success(res, 200, 'Incentive rules', await incentives.rules())));
router.put(
  '/rules',
  [body('points').optional().isObject(), ...['dealPointsPerLakh', 'dealPointsCap', 'rupeesPerPoint', 'minPointsForPayout'].map((k) => body(k).optional().isFloat({ min: 0 })), body('monthlyCapInr').optional({ nullable: true })],
  validate,
  handler(async (req, res) => success(res, 200, 'Rules saved', await incentives.saveRules(req.user, req.body, meta(req))))
);
router.post('/sync', authorize('admin', 'super_admin'), handler(async (req, res) => success(res, 200, 'Scored', await incentives.sync())));
router.post(
  '/adjustments',
  [body('userId').isUUID(), body('period').matches(/^\d{4}-\d{2}$/), body('points').isFloat(), body('note').isString().trim().isLength({ min: 5, max: 300 })],
  validate,
  handler(async (req, res) => success(res, 201, 'Adjustment added', await incentives.adjust(req.user, req.body, meta(req))))
);
router.get('/employees/:userId', [param('userId').isUUID(), month], validate, handler(async (req, res) => success(res, 200, 'Scorecard', await incentives.scorecard(req.user, req.params.userId, { period: req.query.period }))));
router.post('/employees/:userId/exit', [param('userId').isUUID(), body('reason').isString().trim().isLength({ min: 5, max: 300 })], validate, handler(async (req, res) => success(res, 200, 'Exit recorded', await incentives.terminate(req.user, req.params.userId, req.body, meta(req)))));
router.post('/periods/:period/approve', [param('period').matches(/^\d{4}-\d{2}$/)], validate, handler(async (req, res) => success(res, 200, 'Month approved', await incentives.approve(req.user, req.params.period, meta(req)))));
router.get(
  '/periods/:period/export',
  [param('period').matches(/^\d{4}-\d{2}$/)],
  validate,
  handler(async (req, res) => {
    const out = await incentives.exportCsv(req.user, req.params.period, meta(req));
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${out.filename}"`);
    return res.send(out.csv);
  })
);

module.exports = router;
