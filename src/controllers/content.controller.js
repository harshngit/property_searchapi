const contentService = require('../services/content.service');
const auditService = require('../services/audit.service');
const { success } = require('../utils/response');
const handler = require('../utils/asyncHandler');

module.exports = {
  // Public
  listArticles: handler(async (req, res) => {
    const data = await contentService.listPublishedArticles(req.query);
    return success(res, 200, 'Articles fetched successfully', data);
  }),
  getArticle: handler(async (req, res) => {
    const article = await contentService.getPublishedArticleBySlug(req.params.slug);
    return success(res, 200, 'Article fetched successfully', article);
  }),
  listCategories: handler(async (req, res) => {
    const categories = await contentService.listArticleCategories();
    return success(res, 200, 'Categories fetched successfully', categories);
  }),
  listCityPages: handler(async (req, res) => {
    const pages = await contentService.listPublishedCityPages();
    return success(res, 200, 'City pages fetched successfully', pages);
  }),
  getCityPage: handler(async (req, res) => {
    const page = await contentService.getPublishedCityPage(req.params.slug);
    return success(res, 200, 'City page fetched successfully', page);
  }),
  sitemap: handler(async (req, res) => {
    const xml = await contentService.buildSitemapXml();
    res.set('Content-Type', 'application/xml; charset=utf-8');
    return res.send(xml);
  }),

  // Admin - articles
  manageListArticles: handler(async (req, res) => {
    const data = await contentService.listAllArticles(req.query);
    return success(res, 200, 'Articles fetched successfully', data);
  }),
  manageGetArticle: handler(async (req, res) => {
    const article = await contentService.getArticleById(req.params.id);
    return success(res, 200, 'Article fetched successfully', article);
  }),
  manageCreateArticle: handler(async (req, res) => {
    const article = await contentService.createArticle(req.body, req.user, auditService.requestMeta(req));
    return success(res, 201, 'Article created successfully', article);
  }),
  manageUpdateArticle: handler(async (req, res) => {
    const article = await contentService.updateArticle(req.params.id, req.body, req.user, auditService.requestMeta(req));
    return success(res, 200, 'Article updated successfully', article);
  }),
  manageDeleteArticle: handler(async (req, res) => {
    await contentService.deleteArticle(req.params.id, req.user, auditService.requestMeta(req));
    return success(res, 200, 'Article deleted successfully');
  }),

  // Admin - city pages
  manageListCityPages: handler(async (req, res) => {
    const data = await contentService.listAllCityPages(req.query);
    return success(res, 200, 'City pages fetched successfully', data);
  }),
  manageGetCityPage: handler(async (req, res) => {
    const page = await contentService.getCityPageById(req.params.id);
    return success(res, 200, 'City page fetched successfully', page);
  }),
  manageCreateCityPage: handler(async (req, res) => {
    const page = await contentService.createCityPage(req.body, req.user, auditService.requestMeta(req));
    return success(res, 201, 'City page created successfully', page);
  }),
  manageUpdateCityPage: handler(async (req, res) => {
    const page = await contentService.updateCityPage(req.params.id, req.body, req.user, auditService.requestMeta(req));
    return success(res, 200, 'City page updated successfully', page);
  }),
  manageDeleteCityPage: handler(async (req, res) => {
    await contentService.deleteCityPage(req.params.id, req.user, auditService.requestMeta(req));
    return success(res, 200, 'City page deleted successfully');
  }),
};
