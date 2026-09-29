const express = require('express');
const { body, param, query } = require('express-validator');
const router = express.Router();

const documentController = require('../controllers/document.controller');
const validate = require('../middlewares/validate');
const { authenticate, authorize } = require('../middlewares/auth');
const { uploadDocumentFile } = require('../middlewares/upload');

// Module 20 document types (sec. Engine 5) - matches the document_category enum.
const DOCUMENT_TYPES = [
  'kyc', 'agreement', 'payment_receipt', 'noc', 'other', 'sale_deed', 'agreement_to_sell', 'id_proof', 'tax_receipt',
  'encumbrance_certificate', 'title_document', 'allotment_letter', 'occupancy_certificate', 'completion_certificate',
  'approved_plan', 'mutation_record', 'society_noc', 'bank_noc', 'power_of_attorney', 'possession_letter',
  'rent_agreement', 'utility_bill', 'rera_certificate',
];
const DOCUMENT_STATUSES = ['pending', 'approved', 'rejected'];
const REVIEW_ROLES = ['admin', 'agency_admin', 'super_admin'];

/**
 * @swagger
 * tags:
 *   name: Documents
 *   description: >
 *     General-purpose, deal-aware document store with a review workflow.
 *     All endpoints require authentication and are tenant-scoped for
 *     non-admin roles (own tenant or own uploads).
 */

/**
 * @swagger
 * /documents:
 *   get:
 *     summary: List documents (tenant-scoped for non-admin roles)
 *     tags: [Documents]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *       - in: query
 *         name: documentType
 *         schema: { type: string, enum: [kyc, agreement, payment_receipt, noc, other] }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [pending, approved, rejected] }
 *       - in: query
 *         name: customerId
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: dealId
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Paginated list of documents
 *       401:
 *         description: Not authenticated
 */
router.get(
  '/',
  authenticate,
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('documentType').optional().isIn(DOCUMENT_TYPES),
    query('status').optional().isIn(DOCUMENT_STATUSES),
    query('customerId').optional().isUUID(),
    query('dealId').optional().isUUID(),
  ],
  validate,
  documentController.listDocuments
);

/**
 * @swagger
 * /documents/customer/{customerId}:
 *   get:
 *     summary: List documents for a specific customer
 *     tags: [Documents]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: customerId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Documents fetched successfully
 */
router.get(
  '/customer/:customerId',
  authenticate,
  [param('customerId').isUUID().withMessage('Invalid customer id')],
  validate,
  documentController.getByCustomer
);

/**
 * @swagger
 * /documents/deal/{dealId}:
 *   get:
 *     summary: List documents for a specific deal
 *     tags: [Documents]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: dealId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Documents fetched successfully
 */
router.get(
  '/deal/:dealId',
  authenticate,
  [param('dealId').isUUID().withMessage('Invalid deal id')],
  validate,
  documentController.getByDeal
);

/**
 * @swagger
 * /documents/{id}:
 *   get:
 *     summary: Get a single document by id
 *     tags: [Documents]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Document fetched successfully
 *       404:
 *         description: Document not found
 */
router.get(
  '/:id',
  authenticate,
  [param('id').isUUID().withMessage('Invalid document id')],
  validate,
  documentController.getDocument
);

/**
 * @swagger
 * /documents:
 *   post:
 *     summary: Register a document (URL + metadata only - no upload infra)
 *     description: Accepts an already-hosted document URL. Starts at status `pending`.
 *     tags: [Documents]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/DocumentCreateRequest'
 *     responses:
 *       201:
 *         description: Document uploaded successfully
 *       422:
 *         description: Validation failed
 */
/**
 * @swagger
 * /documents/upload:
 *   post:
 *     summary: Upload a document file (stored privately in GCS; read back via short-lived signed URLs)
 *     description: Multipart form - `file` (PDF, Word, Excel or image, max 20MB) plus optional documentType, customerId, dealId, fileName. Starts in `pending` review status.
 *     tags: [Documents]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file]
 *             properties:
 *               file: { type: string, format: binary }
 *               documentType: { type: string, enum: [kyc, agreement, payment_receipt, noc, other] }
 *               customerId: { type: string, format: uuid }
 *               dealId: { type: string, format: uuid }
 *               fileName: { type: string }
 *     responses:
 *       201:
 *         description: Document uploaded successfully
 *       400:
 *         description: No file / unsupported file type
 */
router.post(
  '/upload',
  authenticate,
  uploadDocumentFile.single('file'),
  [
    body('documentType').optional().isIn(DOCUMENT_TYPES),
    body('customerId').optional({ checkFalsy: true }).isUUID(),
    body('dealId').optional({ checkFalsy: true }).isUUID(),
    body('fileName').optional().isString(),
  ],
  validate,
  documentController.uploadDocument
);

router.post(
  '/',
  authenticate,
  [
    body('documentUrl').notEmpty().withMessage('documentUrl is required'),
    body('documentType').optional().isIn(DOCUMENT_TYPES),
    body('fileName').optional().isString(),
    body('customerId').optional().isUUID(),
    body('dealId').optional().isUUID(),
  ],
  validate,
  documentController.createDocument
);

/**
 * @swagger
 * /documents/{id}:
 *   put:
 *     summary: Update a document's metadata/link
 *     description: Only the uploader, an agency_admin within the same tenant, or admin/super_admin may update.
 *     tags: [Documents]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/DocumentUpdateRequest'
 *     responses:
 *       200:
 *         description: Document updated successfully
 *       403:
 *         description: Not the uploader/tenant manager/admin
 *       404:
 *         description: Document not found
 */
router.put(
  '/:id',
  authenticate,
  [
    param('id').isUUID().withMessage('Invalid document id'),
    body('documentType').optional().isIn(DOCUMENT_TYPES),
    body('customerId').optional().isUUID(),
    body('dealId').optional().isUUID(),
  ],
  validate,
  documentController.updateDocument
);

/**
 * @swagger
 * /documents/{id}:
 *   delete:
 *     summary: Delete a document
 *     description: Only the uploader or admin/super_admin may delete (no tenant-manager carve-out).
 *     tags: [Documents]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Document deleted successfully
 *       403:
 *         description: Not the uploader/admin
 *       404:
 *         description: Document not found
 */
router.delete(
  '/:id',
  authenticate,
  [param('id').isUUID().withMessage('Invalid document id')],
  validate,
  documentController.deleteDocument
);

/**
 * @swagger
 * /documents/bulk-delete:
 *   post:
 *     summary: Delete multiple documents at once
 *     description: Runs the same per-document ownership check as DELETE /documents/{id} for each id (owner or admin only, no tenant-manager carve-out) - ids that fail that check are skipped and reported back, not treated as a fatal error for the whole batch.
 *     tags: [Documents]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [ids]
 *             properties:
 *               ids:
 *                 type: array
 *                 items: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Returns deletedCount, deletedIds, and failed (array of {id, reason})
 */
router.post(
  '/bulk-delete',
  authenticate,
  [
    body('ids').isArray({ min: 1 }).withMessage('ids must be a non-empty array'),
    body('ids.*').isUUID().withMessage('Each id must be a valid UUID'),
  ],
  validate,
  documentController.bulkDeleteDocuments
);

/**
 * @swagger
 * /documents/{id}/review:
 *   put:
 *     summary: Approve or reject a document
 *     description: Allowed roles admin, agency_admin, super_admin.
 *     tags: [Documents]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [status]
 *             properties:
 *               status: { type: string, enum: [approved, rejected] }
 *               reviewNotes: { type: string, example: "PAN number does not match KYC records." }
 *     responses:
 *       200:
 *         description: Document reviewed successfully
 *       403:
 *         description: Role not permitted to review documents
 *       404:
 *         description: Document not found
 */
router.put(
  '/:id/review',
  authenticate,
  authorize(...REVIEW_ROLES),
  [
    param('id').isUUID().withMessage('Invalid document id'),
    body('status').isIn(['approved', 'rejected']).withMessage('status must be "approved" or "rejected"'),
    body('reviewNotes').optional().isString(),
  ],
  validate,
  documentController.reviewDocument
);

module.exports = router;
