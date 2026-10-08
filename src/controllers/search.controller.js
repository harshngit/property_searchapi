const searchService = require('../services/search.service');
const { success } = require('../utils/response');

// GET /api/search/properties
async function searchProperties(req, res, next) {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);

    const filters = {
      city: req.query.city,
      locality: req.query.locality,
      propertyType: req.query.propertyType,
      transactionType: req.query.transactionType,
      listingCategory: req.query.listingCategory,
      purpose: req.query.purpose,
      q: req.query.q,
      minRate: req.query.minRate,
      maxRate: req.query.maxRate,
      minPrice: req.query.minPrice,
      maxPrice: req.query.maxPrice,
      bedrooms: req.query.bedrooms,
      maxBedrooms: req.query.maxBedrooms,
      tag: req.query.tag,
      furnishing: req.query.furnishing,
      possessionStatus: req.query.possessionStatus,
      verified: req.query.verified === 'true',
      bhk: req.query.bhk,
      parking: req.query.parking,
      rera: req.query.rera === 'true',
      amenities: req.query.amenities
        ? String(req.query.amenities).split(',').map((a) => a.trim())
        : undefined,
      // Module 28: area, lister trust, urgency, deal type, geo-radius.
      minArea: req.query.minArea,
      maxArea: req.query.maxArea,
      minTrust: req.query.minTrust,
      urgency: req.query.urgency,
      dealType: req.query.dealType,
      lat: req.query.lat !== undefined && req.query.lat !== '' ? Number(req.query.lat) : undefined,
      lng: req.query.lng !== undefined && req.query.lng !== '' ? Number(req.query.lng) : undefined,
      radiusKm: req.query.radiusKm,
    };

    const result = await searchService.searchProperties(filters, page, limit, req.query.sort, {
      userId: req.user?.id || null,
      viewerKey: req.query.viewer ? String(req.query.viewer).slice(0, 80) : null,
      facets: req.query.facets === 'true',
    });

    return success(res, 200, 'Properties fetched successfully', result);
  } catch (err) {
    next(err);
  }
}

// GET /api/search/filters
async function getFilters(req, res, next) {
  try {
    const filters = await searchService.getFilterOptions();
    return success(res, 200, 'Filter options fetched successfully', filters);
  } catch (err) {
    next(err);
  }
}

// GET /api/search/suggestions
async function getSuggestions(req, res, next) {
  try {
    const suggestions = await searchService.getSuggestions(req.query.q);
    return success(res, 200, 'Suggestions fetched successfully', suggestions);
  } catch (err) {
    next(err);
  }
}

// GET /api/search/properties/:id
async function getProperty(req, res, next) {
  try {
    const property = await searchService.getPublicPropertyById(req.params.id);
    return success(res, 200, 'Property fetched successfully', property);
  } catch (err) {
    next(err);
  }
}

// GET /api/search/home
async function getHome(req, res, next) {
  try {
    const data = await searchService.getHomeData();
    return success(res, 200, 'Home page data fetched successfully', data);
  } catch (err) {
    next(err);
  }
}

module.exports = { searchProperties, getFilters, getSuggestions, getProperty, getHome };
