const express = require('express');
const { body, param, query } = require('express-validator');

const dealRoom = require('../services/dealRoom.service');
const auditService = require('../services/audit.service');
const validate = require('../middlewares/validate');
const { authenticate, authorize } = require('../middlewares/auth');
const { uploadDocumentFile } = require('../middlewares/upload');
const { success } = require('../utils/response');
const handler = require('../utils/asyncHandler');

const router = express.Router();
router.use(authenticate);

const STAFF = ['internal_sales', 'admin', 'super_admin'];
const ADMINS = ['admin', 'super_admin'];
const DOC_TYPES = ['auction_notice', 'sale_notice', 'emd_receipt', 'title_documents', 'valuation_report', 'legal_opinion', 'inspection_report', 'term_sheet', 'financials', 'photos', 'other'];
const meta = (req) => auditService.requestMeta(req);

/**
 * @swagger
 * tags:
 *   name: Deal Room
 *   description: >
 *     Module 39 - NDA-gated, versioned document sharing for special situation /
 *     bank auction, institutional and HNI deals. A document can be read only when
 *     the user is a verified buyer (verified NRI/HNI investor profile or broker),
 *     has signed the NDA on the platform, and an admin has approved their
 *     request. Reads go through 15-minute signed URLs (PDFs watermarked with the
 *     viewer's identity); every view, download, blocked download and URL is logged.
 */

// ------------------------------------------------------------ staff first
// (static paths before /:propertyId)

/**
 * @swagger
 * /deal-room/manage/rooms:
 *   get:
 *     summary: Deals with a deal room - document count, pending requests, approved users (staff)
 *     tags: [Deal Room]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Rooms } }
 */
router.get('/manage/rooms', authorize(...STAFF), handler(async (req, res) => success(res, 200, 'Deal rooms fetched', await dealRoom.listRooms())));

/**
 * @swagger
 * /deal-room/manage/requests:
 *   get:
 *     summary: Access requests across all deal rooms (staff) - pending first
 *     tags: [Deal Room]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: query, name: status, schema: { type: string, enum: [pending_approval, approved, rejected, revoked] } }]
 *     responses: { 200: { description: Requests } }
 */
router.get(
  '/manage/requests',
  authorize(...STAFF),
  [query('status').optional().isIn(['pending_approval', 'approved', 'rejected', 'revoked'])],
  validate,
  handler(async (req, res) => success(res, 200, 'Access requests fetched', await dealRoom.listAccess({ status: req.query.status })))
);

/**
 * @swagger
 * /deal-room/manage/access/{id}:
 *   put:
 *     summary: Approve, reject or revoke a deal room access request (admin)
 *     tags: [Deal Room]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [action]
 *             properties:
 *               action: { type: string, enum: [approve, reject, revoke] }
 *               reason: { type: string, description: Required to reject / revoke; shown to the user }
 *     responses: { 200: { description: Access record } }
 */
router.put(
  '/manage/access/:id',
  authorize(...ADMINS),
  [param('id').isUUID(), body('action').isIn(['approve', 'reject', 'revoke']), body('reason').optional().isString().isLength({ max: 500 })],
  validate,
  handler(async (req, res) => success(res, 200, 'Access updated', await dealRoom.decideAccess(req.params.id, req.body, req.user, meta(req))))
);

/**
 * @swagger
 * /deal-room/manage/documents/{id}:
 *   put:
 *     summary: Change a document's title / type / download / watermark / expiry, or archive it (staff)
 *     tags: [Deal Room]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Document } }
 */
router.put(
  '/manage/documents/:id',
  authorize(...STAFF),
  [
    param('id').isUUID(),
    body('documentType').optional().isIn(DOC_TYPES),
    body('downloadAllowed').optional().isBoolean(),
    body('watermark').optional().isBoolean(),
    body('isActive').optional().isBoolean(),
    body('expiresAt').optional({ nullable: true, checkFalsy: true }).isISO8601(),
  ],
  validate,
  handler(async (req, res) => success(res, 200, 'Document updated', await dealRoom.updateDocument(req.params.id, req.body)))
);

/**
 * @swagger
 * /deal-room/manage/documents/{id}/versions:
 *   post:
 *     summary: Upload a new version of a document (staff; auto-approved when an admin uploads)
 *     tags: [Deal Room]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema: { type: object, required: [file], properties: { file: { type: string, format: binary }, notes: { type: string } } }
 *     responses: { 201: { description: Version } }
 */
router.post(
  '/manage/documents/:id/versions',
  authorize(...STAFF),
  uploadDocumentFile.single('file'),
  [param('id').isUUID()],
  validate,
  handler(async (req, res) => success(res, 201, 'Version uploaded', await dealRoom.addVersion(req.params.id, req.file, req.body, req.user, meta(req))))
);

/**
 * @swagger
 * /deal-room/manage/versions/{id}/approve:
 *   put:
 *     summary: Approve a pending document version so buyers see it (admin)
 *     tags: [Deal Room]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Version } }
 */
router.put(
  '/manage/versions/:id/approve',
  authorize(...ADMINS),
  [param('id').isUUID()],
  validate,
  handler(async (req, res) => success(res, 200, 'Version approved', await dealRoom.approveVersion(req.params.id, req.user, meta(req))))
);

/**
 * @swagger
 * /deal-room/documents/{id}/url:
 *   get:
 *     summary: Signed URL to view or download a deal room document (Module 39 presigned URL)
 *     description: Re-checks verified buyer + NDA + approval. Valid for deal_room.presigned_url_ttl_minutes (default 15). PDFs with watermarking on are served as a copy stamped with the viewer's identity. A download of a view-only document is refused and logged as download_blocked.
 *     tags: [Deal Room]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *       - { in: query, name: purpose, schema: { type: string, enum: [view, download], default: view } }
 *       - { in: query, name: fp, schema: { type: string }, description: Client device fingerprint (logged) }
 *     responses:
 *       200: { description: "{ url, expiresInMinutes, fileName, mimeType, watermarked }" }
 *       403: { description: Access not granted / download not allowed }
 */
router.get(
  '/documents/:id/url',
  [param('id').isUUID(), query('purpose').optional().isIn(['view', 'download']), query('fp').optional().isString().isLength({ max: 128 })],
  validate,
  handler(async (req, res) =>
    success(res, 200, 'Document link generated', await dealRoom.getDocumentUrl(req.params.id, req.user, { purpose: req.query.purpose, fingerprint: req.query.fp }, meta(req)))
  )
);

// ------------------------------------------------------------ per deal

/**
 * @swagger
 * /deal-room/{propertyId}:
 *   get:
 *     summary: The caller's view of a deal room - gate status, NDA text, documents once unlocked
 *     tags: [Deal Room]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: propertyId, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: "{ deal, access: { verified, ndaSigned, approved, status, open }, nda, documentCount, documents }" } }
 */
router.get('/:propertyId', [param('propertyId').isUUID()], validate, handler(async (req, res) => success(res, 200, 'Deal room fetched', await dealRoom.getRoom(req.params.propertyId, req.user))));

/**
 * @swagger
 * /deal-room/{propertyId}/nda:
 *   post:
 *     summary: Sign the NDA (typed full name) - creates the access request for admin approval
 *     tags: [Deal Room]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: propertyId, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, required: [fullName, accept], properties: { fullName: { type: string }, accept: { type: boolean } } }
 *     responses:
 *       200: { description: Updated deal room view (status pending_approval) }
 *       403: { description: Not a verified buyer }
 */
router.post(
  '/:propertyId/nda',
  [param('propertyId').isUUID(), body('fullName').trim().isLength({ min: 3, max: 150 }).withMessage('Type your full name to sign'), body('accept').isBoolean()],
  validate,
  handler(async (req, res) => success(res, 200, 'NDA signed - awaiting approval', await dealRoom.signNda(req.params.propertyId, req.user, req.body, meta(req))))
);

/**
 * @swagger
 * /deal-room/{propertyId}/manage:
 *   get:
 *     summary: Full deal room for staff - documents with every version, access requests, activity counts
 *     tags: [Deal Room]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: propertyId, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Room } }
 */
router.get('/:propertyId/manage', authorize(...STAFF), [param('propertyId').isUUID()], validate, handler(async (req, res) => success(res, 200, 'Deal room fetched', await dealRoom.getRoomForStaff(req.params.propertyId))));

/**
 * @swagger
 * /deal-room/{propertyId}/documents:
 *   post:
 *     summary: Add a document to a deal room (staff)
 *     tags: [Deal Room]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: propertyId, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file]
 *             properties:
 *               file: { type: string, format: binary }
 *               title: { type: string }
 *               documentType: { type: string, enum: [auction_notice, sale_notice, emd_receipt, title_documents, valuation_report, legal_opinion, inspection_report, term_sheet, financials, photos, other] }
 *               description: { type: string }
 *               downloadAllowed: { type: boolean }
 *               watermark: { type: boolean }
 *               expiresAt: { type: string, format: date-time }
 *     responses: { 201: { description: Document } }
 */
router.post(
  '/:propertyId/documents',
  authorize(...STAFF),
  uploadDocumentFile.single('file'),
  [param('propertyId').isUUID(), body('documentType').optional().isIn(DOC_TYPES), body('expiresAt').optional({ checkFalsy: true }).isISO8601()],
  validate,
  handler(async (req, res) => success(res, 201, 'Document added', await dealRoom.addDocument(req.params.propertyId, req.file, req.body, req.user, meta(req))))
);

/**
 * @swagger
 * /deal-room/{propertyId}/access-log:
 *   get:
 *     summary: Immutable access log for a deal room (admin). ?format=csv downloads it.
 *     tags: [Deal Room]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: propertyId, required: true, schema: { type: string, format: uuid } }
 *       - { in: query, name: format, schema: { type: string, enum: [json, csv] } }
 *     responses: { 200: { description: Log entries } }
 */
router.get(
  '/:propertyId/access-log',
  authorize(...ADMINS),
  [param('propertyId').isUUID(), query('format').optional().isIn(['json', 'csv'])],
  validate,
  handler(async (req, res) => {
    const rows = await dealRoom.listLog(req.params.propertyId, { limit: req.query.format === 'csv' ? 5000 : 500 });
    if (req.query.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="deal-room-${req.params.propertyId}-access-log.csv"`);
      return res.send(dealRoom.logToCsv(rows));
    }
    return success(res, 200, 'Access log fetched', rows);
  })
);

module.exports = router;
