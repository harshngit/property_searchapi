const express = require('express');
const { body, param, query } = require('express-validator');
const router = express.Router();

const contentController = require('../controllers/content.controller');
const validate = require('../middlewares/validate');
const rateLimit = require('express-rate-limit');
const { authenticate, authorize, optionalAuthenticate } = require('../middlewares/auth');
const newsletterService = require('../services/newsletter.service');
const { success } = require('../utils/response');
const handler = require('../utils/asyncHandler');

const CONTENT_ROLES = ['admin', 'super_admin'];
const STATUSES = ['draft', 'published', 'archived'];
const PAGE_TYPES = ['buy', 'sell', 'rent', 'school_for_sale', 'acquire_college', 'university_campus_for_sale'];
const manage = [authenticate, authorize(...CONTENT_ROLES)];
const testimonials = require('../services/testimonial.service');
const asyncH = require('../utils/asyncHandler');
const { success: ok } = require('../utils/response');
const idParam = [param('id').isUUID().withMessage('Invalid id')];

/**
 * @swagger
 * tags:
 *   name: Content
 *   description: >
 *     Website CMS (Module 16) - blog / guides / investment reports, SEO city
 *     landing pages (/buy-property-in-[city] etc.) and sitemap.xml. Public
 *     GETs return published content only; /content/manage/* is admin-only.
 *     All copy passes the brand-spelling and forbidden-terms validator.
 */

/**
 * @swagger
 * /content/articles:
 *   get:
 *     summary: List published articles
 *     tags: [Content]
 *     parameters:
 *       - { in: query, name: category, schema: { type: string } }
 *       - { in: query, name: tag, schema: { type: string } }
 *       - { in: query, name: featured, schema: { type: boolean } }
 *       - { in: query, name: search, schema: { type: string } }
 *       - { in: query, name: page, schema: { type: integer } }
 *       - { in: query, name: limit, schema: { type: integer, default: 12 } }
 *     responses:
 *       200: { description: Paginated articles (featured first, newest first) }
 */
router.get(
  '/articles',
  [query('page').optional().isInt({ min: 1 }), query('limit').optional().isInt({ min: 1, max: 100 })],
  validate,
  contentController.listArticles
);

/**
 * @swagger
 * /content/articles/categories:
 *   get:
 *     summary: Published article categories with counts
 *     tags: [Content]
 *     responses:
 *       200: { description: Categories }
 */
router.get('/articles/categories', contentController.listCategories);

/**
 * @swagger
 * /content/articles/{slug}:
 *   get:
 *     summary: Get a published article by slug (with up to 3 related articles)
 *     tags: [Content]
 *     parameters:
 *       - { in: path, name: slug, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Article }
 *       404: { description: Not found / not published }
 */
router.get('/articles/:slug', contentController.getArticle);

/**
 * @swagger
 * /content/city-pages:
 *   get:
 *     summary: List published city landing pages (live cities only)
 *     tags: [Content]
 *     responses:
 *       200: { description: City pages }
 */
router.get('/city-pages', contentController.listCityPages);

/**
 * @swagger
 * /content/city-pages/{slug}:
 *   get:
 *     summary: Get a city landing page with live stats, top localities and featured listings
 *     tags: [Content]
 *     parameters:
 *       - { in: path, name: slug, required: true, schema: { type: string, example: buy-property-in-hyderabad } }
 *     responses:
 *       200: { description: City page }
 *       404: { description: Not found, unpublished, or city not active }
 */
router.get('/city-pages/:slug', contentController.getCityPage);

/**
 * @swagger
 * /content/sitemap.xml:
 *   get:
 *     summary: Auto-generated sitemap (static routes + published city pages + articles)
 *     tags: [Content]
 *     responses:
 *       200: { description: XML sitemap, content: { application/xml: {} } }
 */
router.get('/sitemap.xml', contentController.sitemap);

/**
 * @swagger
 * /content/testimonials:
 *   get:
 *     summary: Published testimonials for the home / city pages (a city's own first)
 *     tags: [Content]
 *     parameters:
 *       - { in: query, name: city, schema: { type: string } }
 *       - { in: query, name: limit, schema: { type: integer, default: 8 } }
 *     responses: { 200: { description: Testimonials } }
 */
router.get('/testimonials', asyncH(async (req, res) => ok(res, 200, 'Testimonials', await testimonials.listPublished(req.query))));

// ------------------------------- admin -------------------------------

const articleValidators = (isCreate) => [
  (isCreate ? body('title') : body('title').optional()).isString().notEmpty().withMessage('title is required'),
  body('slug').optional().isString(),
  body('status').optional().isIn(STATUSES),
  body('tags').optional().isArray(),
  body('faqs').optional().isArray(),
  body('isFeatured').optional().isBoolean(),
  body('readingMinutes').optional().isInt({ min: 1 }),
  body('publishedAt').optional().isISO8601(),
];

/**
 * @swagger
 * /content/manage/articles:
 *   get:
 *     summary: "[Admin] List articles in any status"
 *     tags: [Content]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: status, schema: { type: string, enum: [draft, published, archived] } }
 *       - { in: query, name: category, schema: { type: string } }
 *       - { in: query, name: search, schema: { type: string } }
 *     responses:
 *       200: { description: Paginated articles }
 *   post:
 *     summary: "[Admin] Create an article"
 *     tags: [Content]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [title]
 *             properties:
 *               title: { type: string }
 *               slug: { type: string, description: Derived from the title when omitted }
 *               excerpt: { type: string }
 *               contentHtml: { type: string }
 *               coverImageUrl: { type: string }
 *               category: { type: string, example: "Legal & Tax" }
 *               tags: { type: array, items: { type: string } }
 *               authorName: { type: string }
 *               seoTitle: { type: string }
 *               seoDescription: { type: string }
 *               faqs: { type: array, items: { type: object, properties: { question: { type: string }, answer: { type: string } } } }
 *               isFeatured: { type: boolean }
 *               status: { type: string, enum: [draft, published, archived] }
 *     responses:
 *       201: { description: Created }
 *       422: { description: Duplicate slug or content validation failed }
 */
/**
 * @swagger
 * /content/manage/testimonials:
 *   get:
 *     summary: All testimonials (content team)
 *     tags: [Content]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Testimonials } }
 *   post:
 *     summary: Add a testimonial (contact details and forbidden terms are blocked)
 *     tags: [Content]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [personName, quote]
 *             properties:
 *               personName: { type: string }
 *               personRole: { type: string, example: "Home buyer, Gurugram" }
 *               city: { type: string }
 *               quote: { type: string }
 *               rating: { type: integer, minimum: 1, maximum: 5 }
 *               photoUrl: { type: string }
 *               isPublished: { type: boolean }
 *               sortOrder: { type: integer }
 *     responses: { 201: { description: Created } }
 * /content/manage/testimonials/{id}:
 *   put:
 *     summary: Edit / publish / unpublish a testimonial
 *     tags: [Content]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Saved } }
 *   delete:
 *     summary: Delete a testimonial
 *     tags: [Content]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Deleted } }
 */
const testimonialRules = (create) => [
  create ? body('personName').isString().trim().isLength({ min: 2, max: 120 }) : body('personName').optional().isString().trim().isLength({ min: 2, max: 120 }),
  create ? body('quote').isString().trim().isLength({ min: 10, max: 600 }) : body('quote').optional().isString().trim().isLength({ min: 10, max: 600 }),
  body('personRole').optional({ nullable: true }).isString().isLength({ max: 160 }),
  body('city').optional({ nullable: true }).isString().isLength({ max: 120 }),
  body('rating').optional().isInt({ min: 1, max: 5 }).toInt(),
  body('photoUrl').optional({ nullable: true }).isString().isLength({ max: 1000 }),
  body('isPublished').optional().isBoolean().toBoolean(),
  body('sortOrder').optional().isInt({ min: 0, max: 9999 }).toInt(),
];
const auditMeta = (req) => require('../services/audit.service').requestMeta(req);
router.get('/manage/testimonials', manage, asyncH(async (req, res) => ok(res, 200, 'Testimonials', await testimonials.listAll())));
router.post('/manage/testimonials', manage, testimonialRules(true), validate, asyncH(async (req, res) => ok(res, 201, 'Testimonial added', await testimonials.save(req.user, null, req.body, auditMeta(req)))));
router.put('/manage/testimonials/:id', manage, idParam, testimonialRules(false), validate, asyncH(async (req, res) => ok(res, 200, 'Testimonial saved', await testimonials.save(req.user, req.params.id, req.body, auditMeta(req)))));
router.delete('/manage/testimonials/:id', manage, idParam, validate, asyncH(async (req, res) => ok(res, 200, 'Testimonial deleted', await testimonials.remove(req.user, req.params.id, auditMeta(req)))));

router.get('/manage/articles', manage, contentController.manageListArticles);
router.post('/manage/articles', manage, articleValidators(true), validate, contentController.manageCreateArticle);

/**
 * @swagger
 * /content/manage/articles/{id}:
 *   get:
 *     summary: "[Admin] Get an article"
 *     tags: [Content]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Article } }
 *   put:
 *     summary: "[Admin] Update an article (set status=published to publish)"
 *     tags: [Content]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody: { content: { application/json: { schema: { type: object } } } }
 *     responses: { 200: { description: Updated } }
 *   delete:
 *     summary: "[Admin] Delete an article"
 *     tags: [Content]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Deleted } }
 */
router.get('/manage/articles/:id', manage, idParam, validate, contentController.manageGetArticle);
router.put('/manage/articles/:id', manage, idParam, articleValidators(false), validate, contentController.manageUpdateArticle);
router.delete('/manage/articles/:id', manage, idParam, validate, contentController.manageDeleteArticle);

/**
 * @swagger
 * /content/manage/city-pages:
 *   get:
 *     summary: "[Admin] List city pages in any status"
 *     tags: [Content]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: status, schema: { type: string } }
 *       - { in: query, name: cityId, schema: { type: string, format: uuid } }
 *     responses: { 200: { description: Paginated city pages } }
 *   post:
 *     summary: "[Admin] Create a city landing page from the page-type template"
 *     description: >
 *       Only the city and page type are required - slug, title, hero, SEO and FAQ
 *       copy are filled from the admin-editable template (app_config
 *       `content.city_page_templates`); any field supplied overrides it.
 *     tags: [Content]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               cityId: { type: string, format: uuid }
 *               city: { type: string, description: City slug or name (alternative to cityId), example: hyderabad }
 *               pageType: { type: string, enum: [buy, sell, rent, school_for_sale, acquire_college, university_campus_for_sale] }
 *               status: { type: string, enum: [draft, published, archived] }
 *     responses:
 *       201: { description: Created }
 *       422: { description: Page of this type already exists for the city }
 */
router.get('/manage/city-pages', manage, [query('cityId').optional().isUUID()], validate, contentController.manageListCityPages);
router.post(
  '/manage/city-pages',
  manage,
  [
    body('cityId').optional().isUUID(),
    body('city').optional().isString(),
    body('pageType').optional().isIn(PAGE_TYPES),
    body('status').optional().isIn(STATUSES),
    body('faqs').optional().isArray(),
  ],
  validate,
  contentController.manageCreateCityPage
);

/**
 * @swagger
 * /content/manage/city-pages/{id}:
 *   get:
 *     summary: "[Admin] Get a city page"
 *     tags: [Content]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: City page } }
 *   put:
 *     summary: "[Admin] Update a city page"
 *     tags: [Content]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody: { content: { application/json: { schema: { type: object } } } }
 *     responses: { 200: { description: Updated } }
 *   delete:
 *     summary: "[Admin] Delete a city page"
 *     tags: [Content]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses: { 200: { description: Deleted } }
 */
router.get('/manage/city-pages/:id', manage, idParam, validate, contentController.manageGetCityPage);
router.put(
  '/manage/city-pages/:id',
  manage,
  idParam,
  [body('status').optional().isIn(STATUSES), body('faqs').optional().isArray()],
  validate,
  contentController.manageUpdateCityPage
);
router.delete('/manage/city-pages/:id', manage, idParam, validate, contentController.manageDeleteCityPage);

// ============================================================ Newsletter

// Public sign-up - same limit as the other public website forms.
const newsletterLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.PUBLIC_FORM_RATE_LIMIT_MAX) || 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please try again later.' },
});

/**
 * @swagger
 * /content/newsletter:
 *   post:
 *     summary: Subscribe an email to the market newsletter (website "Stay ahead of the market")
 *     description: Public. Re-subscribing an existing email reactivates it - never errors on a repeat.
 *     tags: [Content]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email]
 *             properties:
 *               email: { type: string, format: email }
 *               sourcePage: { type: string, example: /news-guide/insights-guides }
 *     responses:
 *       201: { description: Subscribed }
 *       422: { description: Invalid email }
 */
router.post(
  '/newsletter',
  newsletterLimiter,
  optionalAuthenticate,
  [body('email').trim().isEmail().withMessage('Enter a valid email address'), body('sourcePage').optional().isString().isLength({ max: 255 })],
  validate,
  handler(async (req, res) => success(res, 201, "You're subscribed", await newsletterService.subscribe(req.body, req.user)))
);

/**
 * @swagger
 * /content/manage/newsletter:
 *   get:
 *     summary: Newsletter subscribers with counts (admin)
 *     tags: [Content]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: status, schema: { type: string, enum: [subscribed, unsubscribed] } }
 *       - { in: query, name: search, schema: { type: string } }
 *       - { in: query, name: page, schema: { type: integer } }
 *       - { in: query, name: limit, schema: { type: integer } }
 *     responses: { 200: { description: "{ items, pagination, stats }" } }
 */
router.get(
  '/manage/newsletter',
  manage,
  [query('status').optional().isIn(['subscribed', 'unsubscribed'])],
  validate,
  handler(async (req, res) => success(res, 200, 'Subscribers fetched', await newsletterService.listSubscribers(req.query)))
);

/**
 * @swagger
 * /content/manage/newsletter/{id}:
 *   put:
 *     summary: Unsubscribe / resubscribe a newsletter subscriber (admin)
 *     tags: [Content]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, required: [status], properties: { status: { type: string, enum: [subscribed, unsubscribed] } } }
 *     responses: { 200: { description: Subscriber } }
 */
router.put(
  '/manage/newsletter/:id',
  manage,
  [...idParam, body('status').isIn(['subscribed', 'unsubscribed'])],
  validate,
  handler(async (req, res) => success(res, 200, 'Subscriber updated', await newsletterService.setStatus(req.params.id, req.body.status)))
);

module.exports = router;
