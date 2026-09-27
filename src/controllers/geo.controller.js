const geoService = require('../services/geo.service');
const disclaimerService = require('../services/disclaimer.service');
const { success } = require('../utils/response');

// GET /api/geo/states
async function listStates(req, res, next) {
  try {
    const states = await geoService.listStates({ includeInactive: req.query.includeInactive === 'true' });
    return success(res, 200, 'States fetched successfully', states);
  } catch (err) {
    next(err);
  }
}

// GET /api/geo/cities
async function listCities(req, res, next) {
  try {
    const cities = await geoService.listCities({
      stateCode: req.query.stateCode,
      status: req.query.status,
      search: req.query.search,
    });
    return success(res, 200, 'Cities fetched successfully', cities);
  } catch (err) {
    next(err);
  }
}

// GET /api/geo/cities/:slug
async function getCity(req, res, next) {
  try {
    const city = await geoService.getCityBySlug(req.params.slug);
    return success(res, 200, 'City fetched successfully', city);
  } catch (err) {
    next(err);
  }
}

// GET /api/geo/localities
async function listLocalities(req, res, next) {
  try {
    const localities = await geoService.listLocalities({
      cityId: req.query.cityId,
      citySlug: req.query.citySlug,
      search: req.query.search,
      limit: req.query.limit,
    });
    return success(res, 200, 'Localities fetched successfully', localities);
  } catch (err) {
    next(err);
  }
}

// GET /api/geo/pincodes/:pincode
async function lookupPincode(req, res, next) {
  try {
    const rows = await geoService.lookupPincode(req.params.pincode);
    return success(res, 200, 'Pincode fetched successfully', rows);
  } catch (err) {
    next(err);
  }
}

// GET /api/geo/stamp-duty
async function getStampDuty(req, res, next) {
  try {
    const [rules, disclaimers] = await Promise.all([
      geoService.getStampDutyRules({
        stateCode: req.query.stateCode,
        cityId: req.query.cityId,
        transactionType: req.query.transactionType,
      }),
      disclaimerService.getDisclaimers(['tax_legal'], req.query.stateCode),
    ]);
    return success(res, 200, 'Stamp duty rules fetched successfully', { rules, disclaimers });
  } catch (err) {
    next(err);
  }
}

// GET /api/geo/circle-rate
async function getCircleRate(req, res, next) {
  try {
    const rate = await geoService.getCircleRate({
      cityId: req.query.cityId,
      localityId: req.query.localityId,
      propertyType: req.query.propertyType,
    });
    return success(res, 200, rate ? 'Circle rate fetched successfully' : 'No circle rate on file', rate);
  } catch (err) {
    next(err);
  }
}

// GET /api/disclaimers
async function listDisclaimers(req, res, next) {
  try {
    const types = req.query.contentType ? String(req.query.contentType).split(',').map((s) => s.trim()) : [];
    const disclaimers = await disclaimerService.getDisclaimers(types, req.query.stateCode);
    return success(res, 200, 'Disclaimers fetched successfully', disclaimers);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listStates,
  listCities,
  getCity,
  listLocalities,
  lookupPincode,
  getStampDuty,
  getCircleRate,
  listDisclaimers,
};
