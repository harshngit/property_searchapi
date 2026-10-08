const express = require('express');
const { body, param } = require('express-validator');
const validate = require('../middlewares/validate');
const { authenticate, authorize } = require('../middlewares/auth');
const { uploadPropertyMedia } = require('../middlewares/upload');
const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const auditService = require('../services/audit.service');
const wfh = require('../services/wfh.service');

// Module 47 - Work From Home (WFH) Citizen-Sourcing. Mounted at /api/wfh.

const router = express.Router();
const STAFF = ['internal_sales', 'admin', 'super_admin'];
const ADMIN = ['admin', 'super_admin'];
const meta = (req) => auditService.requestMeta(req);
const h = asyncHandler;
const ok = (res, msg, data, code = 200) => success(res, code, msg, data);
const idp = [param('id').isUUID()];

/**
 * @swagger
 * tags:
 *   name: Work From Home
 *   description: >
 *     Module 47 - citizen field network. Any registered user joins (Field Partner Agreement + KYC), takes tasks near
 *     them and is paid a fixed, admin-configured amount per verified task: buyer site visit, seller photo permission,
 *     requirement collection, listing assist, condition report, auction field check, area survey. Every task passes
 *     GPS / photo-EXIF / OTP / representative or staff checks before anything is credited. Monthly payout with TDS.
 */

/**
 * @swagger
 * /wfh/me:
 *   get:
 *     summary: My field partner profile, task types with their amounts, the agreement, performance
 *     tags: [Work From Home]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Profile } }
 * /wfh/register:
 *   post:
 *     summary: Join - accept the Field Partner Agreement and submit Aadhaar + bank details (stored encrypted) and location
 *     tags: [Work From Home]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 201: { description: Joined; KYC pending } }
 * /wfh/board:
 *   get:
 *     summary: Open tasks near me (default 5 km) - filter by taskType, minPayment; pass latitude / longitude to override
 *     tags: [Work From Home]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Task cards with distance and expiry } }
 * /wfh/tasks/{id}/accept:
 *   post:
 *     summary: Accept a task - reserved for 48 hours
 *     tags: [Work From Home]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 201: { description: Assignment } }
 * /wfh/assignments/{id}/submit:
 *   post:
 *     summary: Submit evidence (multipart - fields by task type, photos[] where required). Sends the OTP to the buyer / seller.
 *     tags: [Work From Home]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Submitted }, 400: { description: A check failed (distance, photos, phone) } }
 * /wfh/assignments/{id}/otp:
 *   post:
 *     summary: Enter the OTP the buyer / seller received (valid 10 minutes)
 *     tags: [Work From Home]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Confirmed } }
 * /wfh/earnings:
 *   get:
 *     summary: My earnings - totals, task-by-task ledger, payout history
 *     tags: [Work From Home]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Earnings } }
 * /wfh/manage/submissions/{id}/rep:
 *   post:
 *     summary: Representative confirms a buyer visit happened, or marks it Did Not Happen
 *     tags: [Work From Home]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Decided } }
 * /wfh/manage/submissions/{id}/review:
 *   post:
 *     summary: Staff quality review of a photo / report task - approve or reject with a reason
 *     tags: [Work From Home]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Decided } }
 * /wfh/manage/payouts/run:
 *   post:
 *     summary: Run the monthly payout - one payout per worker, TDS applied (admin)
 *     tags: [Work From Home]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Payouts created } }
 */
router.use(authenticate);

// ----- the field partner
router.get('/me', h(async (req, res) => ok(res, 'Field partner', await wfh.me(req.user))));
router.post('/register', [body('aadhaar').isString(), body('bankAccount').isString(), body('bankIfsc').isString()], validate, h(async (req, res) => ok(res, 'Joined', await wfh.register(req.user, req.body, meta(req)), 201)));
router.put('/location', h(async (req, res) => ok(res, 'Location saved', await wfh.updateLocation(req.user, req.body))));
router.get('/board', h(async (req, res) => ok(res, 'Task board', await wfh.board(req.user, req.query))));
router.post('/tasks/:id/accept', idp, validate, h(async (req, res) => ok(res, 'Task accepted', await wfh.accept(req.user, req.params.id, meta(req)), 201)));
router.get('/assignments', h(async (req, res) => ok(res, 'My tasks', await wfh.myTasks(req.user, { state: req.query.state }))));
router.get('/assignments/:id', idp, validate, h(async (req, res) => ok(res, 'Task', await wfh.assignmentView(req.user, req.params.id))));
router.post('/assignments/:id/submit', uploadPropertyMedia.array('photos', 12), idp, validate, h(async (req, res) => ok(res, 'Evidence submitted', await wfh.submit(req.user, req.params.id, req.body, req.files || [], meta(req)))));
router.post('/assignments/:id/otp', [...idp, body('otp').isString().isLength({ min: 4, max: 8 })], validate, h(async (req, res) => ok(res, 'OTP confirmed', await wfh.confirmOtp(req.user, req.params.id, req.body.otp))));
router.post('/assignments/:id/otp/resend', idp, validate, h(async (req, res) => ok(res, 'OTP sent', await wfh.resendOtp(req.user, req.params.id))));
router.get('/earnings', h(async (req, res) => ok(res, 'Earnings', await wfh.earnings(req.user))));
router.get(
  '/payouts/:id/slip',
  idp,
  validate,
  h(async (req, res) => {
    const pdf = await wfh.payoutSlip(req.user, req.params.id);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="payout-slip.pdf"' }).send(pdf);
  })
);

// ----- A R staff
router.get('/manage/summary', authorize(...STAFF), h(async (req, res) => ok(res, 'Field network summary', await wfh.summary())));
router.get('/manage/tasks', authorize(...STAFF), h(async (req, res) => ok(res, 'Tasks', await wfh.listTasks(req.query))));
router.post('/manage/tasks', authorize(...STAFF), [body('taskType').isIn(Object.keys(wfh.TYPES)), body('propertyId').optional({ checkFalsy: true }).isUUID(), body('count').optional().isInt({ min: 1, max: 50 })], validate, h(async (req, res) => ok(res, 'Task created', await wfh.createTask(req.user, req.body, meta(req)), 201)));
router.post('/manage/tasks/:id/cancel', authorize(...STAFF), idp, validate, h(async (req, res) => ok(res, 'Task cancelled', await wfh.cancelTask(req.user, req.params.id, meta(req)))));
router.get('/manage/submissions', authorize(...STAFF), h(async (req, res) => ok(res, 'Submissions', await wfh.listSubmissions(req.user, { queue: req.query.queue }))));
router.post('/manage/submissions/:id/rep', authorize(...STAFF), [...idp, body('happened').isBoolean()], validate, h(async (req, res) => ok(res, 'Visit decided', await wfh.repDecide(req.user, req.params.id, { happened: req.body.happened === true || req.body.happened === 'true', reason: req.body.reason }))));
router.post('/manage/submissions/:id/review', authorize(...STAFF), [...idp, body('decision').isIn(['approve', 'reject'])], validate, h(async (req, res) => ok(res, 'Task reviewed', await wfh.review(req.user, req.params.id, req.body))));
router.get('/manage/workers', authorize(...STAFF), h(async (req, res) => ok(res, 'Field partners', await wfh.listWorkers(req.query))));
router.post('/manage/workers/:id/kyc', authorize(...ADMIN), [...idp, body('decision').isIn(['verify', 'reject'])], validate, h(async (req, res) => ok(res, 'KYC decided', await wfh.decideKyc(req.user, req.params.id, req.body, meta(req)))));
router.put('/manage/workers/:id/status', authorize(...ADMIN), [...idp, body('status').isIn(['active', 'suspended', 'banned'])], validate, h(async (req, res) => ok(res, 'Status saved', await wfh.setWorkerStatus(req.user, req.params.id, req.body, meta(req)))));
router.get('/manage/payouts', authorize(...STAFF), h(async (req, res) => ok(res, 'Payouts', await wfh.listPayouts(req.query))));
router.post('/manage/payouts/run', authorize(...ADMIN), h(async (req, res) => ok(res, 'Payout run complete', await wfh.runPayouts(req.user, req.body, meta(req)))));
router.get('/manage/payouts/:id/bank', authorize(...ADMIN), idp, validate, h(async (req, res) => ok(res, 'Bank details', await wfh.payoutBankDetails(req.user, req.params.id, meta(req)))));
router.post('/manage/payouts/:id/paid', authorize(...ADMIN), [...idp, body('utr').isString().isLength({ min: 6, max: 60 })], validate, h(async (req, res) => ok(res, 'Payout recorded', await wfh.markPaid(req.user, req.params.id, req.body, meta(req)))));
router.get('/manage/config', authorize(...STAFF), h(async (req, res) => ok(res, 'Settings', await wfh.getConfig())));
router.put('/manage/config/:key', authorize(...ADMIN), h(async (req, res) => ok(res, 'Setting saved', await wfh.updateConfig(req.user, req.params.key, req.body.value, meta(req)))));
router.post('/manage/sweep', authorize(...ADMIN), h(async (req, res) => ok(res, 'Sweep complete', await wfh.sweep())));

module.exports = router;
