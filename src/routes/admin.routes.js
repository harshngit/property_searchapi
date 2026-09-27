const express = require('express');
const { body, param, query } = require('express-validator');
const router = express.Router();

const adminController = require('../controllers/admin.controller');
const validate = require('../middlewares/validate');
const { authenticate, authorize } = require('../middlewares/auth');
const { uploadCsv } = require('../middlewares/upload');
const { ENTITIES } = require('../services/masterData.service');

const ADMIN_ROLES = ['admin', 'super_admin'];
const ENTITY_NAMES = Object.keys(ENTITIES);

router.use(authenticate, authorize(...ADMIN_ROLES));

/**
 * @swagger
 * tags:
 *   name: Admin
 *   description: >
 *     Super Admin / Admin control panel APIs - geographic & compliance master
 *     data (states, cities, localities, pincodes, stamp duty, circle rates,
 *     sub-registrar offices), feature flags, disclaimers library, app
 *     configuration (every rate/threshold/weight), and the append-only audit
 *     log explorer. Every write is audit-logged with before/after JSON.
 *     Entities: countries, states, cities, localities, pincodes,
 *     stamp_duty_rules, circle_rates, sub_registrar_offices, feature_flags,
 *     disclaimers.
 */

/**
 * @swagger
 * /admin/master:
 *   get:
 *     summary: List master-data entities and their field definitions (drives the admin forms)
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Entity catalogue }
 */
router.get('/master', adminController.listEntities);

/**
 * @swagger
 * /admin/master/{entity}:
 *   get:
 *     summary: List records of a master-data entity
 *     description: Supports the entity's filters as query params (e.g. cities?stateId=..&status=active, localities?cityId=..) plus `search`, `page`, `limit`.
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: entity, required: true, schema: { type: string, example: cities } }
 *       - { in: query, name: search, schema: { type: string } }
 *       - { in: query, name: page, schema: { type: integer } }
 *       - { in: query, name: limit, schema: { type: integer } }
 *     responses:
 *       200: { description: Paginated records }
 *   post:
 *     summary: Create a master-data record
 *     description: >
 *       Parent references accept either a UUID or a human key - e.g. a city can
 *       be created with `{ "state": "TG", "cityName": "Hyderabad" }`, a locality
 *       with `{ "city": "hyderabad", "localityName": "Gachibowli", "pincode": "500032" }`.
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: entity, required: true, schema: { type: string, example: cities } }
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { type: object } } }
 *     responses:
 *       201: { description: Created }
 *       400: { description: Missing/invalid field or unresolvable reference }
 *       422: { description: Duplicate unique key / content validation failed }
 */
router.get(
  '/master/:entity',
  [param('entity').isIn(ENTITY_NAMES).withMessage('Unknown entity')],
  validate,
  adminController.listRecords
);
router.post(
  '/master/:entity',
  [param('entity').isIn(ENTITY_NAMES).withMessage('Unknown entity')],
  validate,
  adminController.createRecord
);

/**
 * @swagger
 * /admin/master/{entity}/import:
 *   post:
 *     summary: Bulk import records from CSV (all-or-nothing)
 *     description: >
 *       Multipart `file` (CSV, header row required), or JSON `{ "csv": "..." }`
 *       or `{ "rows": [ {...} ] }`. Header names may be snake_case or camelCase.
 *       Rows are upserted on the entity's natural key where it has one. If any
 *       row is invalid, nothing is saved and every failing row is reported.
 *       Pass `?dryRun=true` to validate only.
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: entity, required: true, schema: { type: string, example: localities } }
 *       - { in: query, name: dryRun, schema: { type: boolean } }
 *     requestBody:
 *       content:
 *         multipart/form-data:
 *           schema: { type: object, properties: { file: { type: string, format: binary } } }
 *         application/json:
 *           schema: { type: object, properties: { csv: { type: string }, rows: { type: array, items: { type: object } } } }
 *     responses:
 *       201: { description: Imported }
 *       422: { description: One or more invalid rows - nothing saved }
 */
router.post(
  '/master/:entity/import',
  uploadCsv.single('file'),
  [param('entity').isIn(ENTITY_NAMES).withMessage('Unknown entity')],
  validate,
  adminController.importRecords
);

/**
 * @swagger
 * /admin/master/{entity}/{id}:
 *   get:
 *     summary: Get one master-data record
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: entity, required: true, schema: { type: string } }
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Record }
 *       404: { description: Not found }
 *   put:
 *     summary: Update a master-data record (partial)
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: entity, required: true, schema: { type: string } }
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     requestBody:
 *       content: { application/json: { schema: { type: object } } }
 *     responses:
 *       200: { description: Updated }
 *   delete:
 *     summary: Delete a master-data record
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: entity, required: true, schema: { type: string } }
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Deleted }
 *       422: { description: Record is still referenced }
 */
const recordValidators = [
  param('entity').isIn(ENTITY_NAMES).withMessage('Unknown entity'),
  param('id').isUUID().withMessage('Invalid id'),
];
router.get('/master/:entity/:id', recordValidators, validate, adminController.getRecord);
router.put('/master/:entity/:id', recordValidators, validate, adminController.updateRecord);
router.delete('/master/:entity/:id', recordValidators, validate, adminController.deleteRecord);

/**
 * @swagger
 * /admin/config:
 *   get:
 *     summary: List all admin-configurable parameters (rates, thresholds, weights, word lists)
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: category, schema: { type: string, example: opportunity } }
 *     responses:
 *       200: { description: Config entries }
 */
router.get('/config', [query('category').optional().isString()], validate, adminController.listConfig);

/**
 * @swagger
 * /admin/config/{key}:
 *   get:
 *     summary: Get one configuration entry
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: key, required: true, schema: { type: string, example: opportunity.scoring_weights } }
 *     responses:
 *       200: { description: Config entry }
 *   put:
 *     summary: Update a configuration value
 *     description: Statutory entries (is_statutory=true, e.g. tax rates) require super_admin. Every change is audit-logged with before/after values and the optional reason.
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: key, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [value]
 *             properties:
 *               value: { description: Any JSON value }
 *               reason: { type: string, example: "Finance Act 2026 amendment" }
 *     responses:
 *       200: { description: Updated }
 *       403: { description: Statutory parameter - super_admin only }
 */
router.get('/config/:key', adminController.getConfig);
router.put(
  '/config/:key',
  [body('value').exists().withMessage('value is required'), body('reason').optional().isString()],
  validate,
  adminController.updateConfig
);

/**
 * @swagger
 * /admin/audit-logs:
 *   get:
 *     summary: Audit log explorer (append-only, newest first)
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: entityType, schema: { type: string } }
 *       - { in: query, name: entityId, schema: { type: string } }
 *       - { in: query, name: actorId, schema: { type: string, format: uuid } }
 *       - { in: query, name: action, schema: { type: string } }
 *       - { in: query, name: dateFrom, schema: { type: string, format: date-time } }
 *       - { in: query, name: dateTo, schema: { type: string, format: date-time } }
 *     responses:
 *       200: { description: Paginated audit entries }
 */
router.get(
  '/audit-logs',
  [
    query('actorId').optional().isUUID(),
    query('dateFrom').optional().isISO8601(),
    query('dateTo').optional().isISO8601(),
  ],
  validate,
  adminController.listAuditLogs
);

module.exports = router;
