const express = require('express');
const { body, param } = require('express-validator');
const validate = require('../middlewares/validate');
const { authenticate, authorize } = require('../middlewares/auth');
const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const auditService = require('../services/audit.service');
const templates = require('../services/template.service');

// Module 50 - Document Template Engine. Mounted at /api/templates.

const router = express.Router();
const ADMIN = ['admin', 'super_admin'];
const USERS = ['internal_sales', 'admin', 'super_admin', 'broker', 'agency_admin', 'builder', 'customer'];
const meta = (req) => auditService.requestMeta(req);
const h = asyncHandler;
const ok = (res, msg, data, code = 200) => success(res, code, msg, data);
const idp = [param('id').isUUID()];
const send = (res, file) => res.set({ 'Content-Type': file.contentType, 'Content-Disposition': `attachment; filename="${file.filename}"` }).send(file.buffer);

/**
 * @swagger
 * tags:
 *   name: Document Templates
 *   description: >
 *     Module 50 - blank master templates with named variables. Pick a template, fill in only its variables (what the
 *     deal already knows is pre-filled; stamp duty, registration fee and amount-in-words compute themselves), and get
 *     the document as DOCX and PDF, or a blank version with underlined blanks. Every document carries the working-draft
 *     disclaimer and a DRAFT watermark until the assigned RM / DM marks advocate review complete. Templates are
 *     versioned; each generation records the version used and is audit-logged.
 */

/**
 * @swagger
 * /templates:
 *   get:
 *     summary: Templates I can use (admins - all, including drafts and retired)
 *     tags: [Document Templates]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Templates } }
 *   post:
 *     summary: Create a template, or save an edit as a new version (send id). Variables are sent with it. (admin)
 *     tags: [Document Templates]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 201: { description: Template saved }, 422: { description: The text failed the contact / forbidden-terms validators } }
 * /templates/{id}/form:
 *   get:
 *     summary: The template's variables as a form, pre-filled from a deal or listing (dealId / propertyId / stateCode)
 *     tags: [Document Templates]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Fields, computed variables, how many are still missing } }
 * /templates/{id}/generate:
 *   post:
 *     summary: Generate a document - { dealId?, propertyId?, stateCode?, values, blank? }
 *     tags: [Document Templates]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 201: { description: Generated; download it as pdf or docx }, 422: { description: A variable failed validation } }
 * /templates/generated/{id}/download:
 *   get:
 *     summary: Download a generated document (?format=pdf|docx) - always from the template version it was made with
 *     tags: [Document Templates]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: The file } }
 * /templates/generated/{id}/advocate-reviewed:
 *   post:
 *     summary: Assigned RM / DM marks advocate review complete - removes the DRAFT watermark
 *     tags: [Document Templates]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Marked } }
 */
router.use(authenticate, authorize(...USERS));

router.get('/', h(async (req, res) => ok(res, 'Templates', await templates.listTemplates(req.user))));
router.get('/meta', h(async (req, res) => ok(res, 'Template options', { fieldTypes: templates.FIELD_TYPES, computedKinds: templates.COMPUTED_KINDS, prefillSources: templates.PREFILL })));
router.get('/generated', h(async (req, res) => ok(res, 'Generated documents', await templates.listGenerated(req.user, { dealId: req.query.dealId, templateId: req.query.templateId }))));
router.get('/generated/:id/download', idp, validate, h(async (req, res) => send(res, await templates.download(req.user, req.params.id, req.query.format || 'pdf'))));
router.post('/generated/:id/advocate-reviewed', idp, validate, h(async (req, res) => ok(res, 'Advocate review recorded', await templates.markReviewed(req.user, req.params.id, meta(req)))));
router.post('/', authorize(...ADMIN), [body('body').isString().isLength({ min: 40, max: 200000 }), body('variables').optional().isArray()], validate, h(async (req, res) => ok(res, 'Template saved', await templates.saveTemplate(req.user, req.body, meta(req)), 201)));
router.get('/:id', idp, validate, h(async (req, res) => ok(res, 'Template', await templates.templateDetail(req.user, req.params.id))));
router.put('/:id/status', authorize(...ADMIN), [...idp, body('status').isIn(['draft', 'active', 'retired'])], validate, h(async (req, res) => ok(res, 'Template updated', await templates.setStatus(req.user, req.params.id, req.body.status, meta(req)))));
router.get('/:id/form', idp, validate, h(async (req, res) => ok(res, 'Template form', await templates.form(req.user, req.params.id, req.query))));
router.post('/:id/generate', idp, validate, h(async (req, res) => ok(res, 'Document generated', await templates.generate(req.user, req.params.id, req.body, meta(req)), 201)));

module.exports = router;
