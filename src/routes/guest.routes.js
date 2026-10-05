const express = require('express');
const rateLimit = require('express-rate-limit');
const { body, query } = require('express-validator');
const validate = require('../middlewares/validate');
const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const guest = require('../services/guestInterest.service');

// Guest Browsing & Guest Interest - no registration. Mounted at /api/guest.

const router = express.Router();
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  // Same override as the other public forms, for automated test runs only.
  max: Number(process.env.PUBLIC_FORM_RATE_LIMIT_MAX) || 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please try again later.' },
});

/**
 * @swagger
 * tags:
 *   name: Guest
 *   description: >
 *     Guest Interest - an unregistered visitor expresses interest in a listing or a posted requirement with only
 *     mobile + OTP. Creates a lead tied to the phone number (no account), routed through the inquiry assignment
 *     cascade; the guest sees only the assigned representative's name and platform number.
 */

/**
 * @swagger
 * /guest/interest/otp:
 *   post:
 *     summary: Send the OTP for a guest interest (max 5 per number per hour)
 *     tags: [Guest]
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { type: object, required: [mobile], properties: { mobile: { type: string, example: "9876543210" } } } } }
 *     responses: { 200: { description: OTP sent (echoed outside production) }, 429: { description: Too many requests } }
 */
router.post(
  '/interest/otp',
  limiter,
  [body('mobile').isString().isLength({ min: 10, max: 15 })],
  validate,
  asyncHandler(async (req, res) => success(res, 200, 'OTP sent', await guest.requestOtp(req.body)))
);

/**
 * @swagger
 * /guest/interest:
 *   post:
 *     summary: Verify the OTP and record the interest - creates (or adds to) a lead and assigns a representative
 *     tags: [Guest]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [mobile, otp]
 *             properties:
 *               mobile: { type: string }
 *               otp: { type: string }
 *               fullName: { type: string }
 *               propertyId: { type: string, format: uuid }
 *               requirementId: { type: string, format: uuid }
 *               message: { type: string }
 *               anonymousId: { type: string }
 *               attribution: { type: object }
 *     responses: { 201: { description: "Interest recorded - { reference, representative: { name, platformNumber } }" }, 400: { description: Invalid / expired OTP } }
 */
router.post(
  '/interest',
  limiter,
  [
    body('mobile').isString().isLength({ min: 10, max: 15 }),
    body('otp').isString().isLength({ min: 4, max: 8 }),
    body('fullName').optional({ checkFalsy: true }).isString().isLength({ max: 150 }),
    body('propertyId').optional({ checkFalsy: true }).isUUID(),
    body('requirementId').optional({ checkFalsy: true }).isUUID(),
    body('message').optional({ checkFalsy: true }).isString().isLength({ max: 1000 }),
    body('anonymousId').optional({ checkFalsy: true }).isString().isLength({ max: 80 }),
  ],
  validate,
  asyncHandler(async (req, res) => success(res, 201, 'Thank you - your interest is registered', await guest.submit(req.body)))
);

/**
 * @swagger
 * /guest/requirements:
 *   get:
 *     summary: Posted requirements a guest may browse - city, locality, type and size only (no person, contact or budget)
 *     tags: [Guest]
 *     parameters:
 *       - { in: query, name: city, schema: { type: string } }
 *       - { in: query, name: purpose, schema: { type: string, enum: [buy, rent] } }
 *     responses: { 200: { description: Masked requirements } }
 */
router.get(
  '/requirements',
  [query('city').optional().isString().isLength({ max: 80 }), query('purpose').optional().isIn(['buy', 'rent', 'invest', 'lease'])],
  validate,
  asyncHandler(async (req, res) => success(res, 200, 'Requirements', await guest.publicRequirements(req.query)))
);

module.exports = router;
