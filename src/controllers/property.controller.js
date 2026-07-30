const propertyService = require('../services/property.service');
const { success } = require('../utils/response');
const { assertOwnerOrAdmin, assertTenantVisible } = require('../utils/ownership');

// GET /api/properties
async function listProperties(req, res, next) {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);

    const filters = {
      city: req.query.city,
      propertyType: req.query.propertyType,
      transactionType: req.query.transactionType,
      status: req.query.status,
      minPrice: req.query.minPrice,
      maxPrice: req.query.maxPrice,
    };

    const { items, pagination } = await propertyService.listProperties(
      req.user,
      filters,
      page,
      limit
    );

    return success(res, 200, 'Properties fetched successfully', { items, pagination });
  } catch (err) {
    next(err);
  }
}

// GET /api/properties/:id
async function getProperty(req, res, next) {
  try {
    const property = await propertyService.getPropertyById(req.params.id);
    assertTenantVisible(req.user, property, 'Property not found');
    return success(res, 200, 'Property fetched successfully', property);
  } catch (err) {
    next(err);
  }
}

// POST /api/properties
async function createProperty(req, res, next) {
  try {
    const property = await propertyService.createProperty(req.body, req.user);
    return success(res, 201, 'Property created successfully, pending approval', property);
  } catch (err) {
    next(err);
  }
}

// PUT /api/properties/:id
async function updateProperty(req, res, next) {
  try {
    const existing = await propertyService.getPropertyById(req.params.id);
    assertOwnerOrAdmin(req.user, existing, { allowTenantManagers: ['agency_admin'] });

    const property = await propertyService.updateProperty(req.params.id, req.body);
    return success(res, 200, 'Property updated successfully', property);
  } catch (err) {
    next(err);
  }
}

// DELETE /api/properties/:id
async function deleteProperty(req, res, next) {
  try {
    const existing = await propertyService.getPropertyById(req.params.id);
    assertOwnerOrAdmin(req.user, existing, { allowTenantManagers: ['agency_admin'] });

    await propertyService.deleteProperty(req.params.id);
    return success(res, 200, 'Property deleted successfully');
  } catch (err) {
    next(err);
  }
}

// POST /api/properties/:id/media
async function addMedia(req, res, next) {
  try {
    const existing = await propertyService.getPropertyById(req.params.id);
    assertOwnerOrAdmin(req.user, existing, { allowTenantManagers: ['agency_admin'] });

    const media = await propertyService.addMedia(req.params.id, req.body.media);
    return success(res, 201, 'Media attached successfully', media);
  } catch (err) {
    next(err);
  }
}

// DELETE /api/properties/:id/media/:mediaId
async function deleteMedia(req, res, next) {
  try {
    const existing = await propertyService.getPropertyById(req.params.id);
    assertOwnerOrAdmin(req.user, existing, { allowTenantManagers: ['agency_admin'] });

    await propertyService.deleteMedia(req.params.id, req.params.mediaId);
    return success(res, 200, 'Media removed successfully');
  } catch (err) {
    next(err);
  }
}

// PUT /api/properties/:id/availability
async function updateAvailability(req, res, next) {
  try {
    const existing = await propertyService.getPropertyById(req.params.id);
    assertOwnerOrAdmin(req.user, existing, { allowTenantManagers: ['agency_admin'] });

    const property = await propertyService.updateAvailability(
      req.params.id,
      existing,
      req.body.isAvailable
    );
    return success(res, 200, 'Property availability updated', property);
  } catch (err) {
    next(err);
  }
}

// PUT /api/properties/:id/pricing
async function updatePricing(req, res, next) {
  try {
    const existing = await propertyService.getPropertyById(req.params.id);
    assertOwnerOrAdmin(req.user, existing, { allowTenantManagers: ['agency_admin'] });

    const property = await propertyService.updatePricing(req.params.id, req.body.price);
    return success(res, 200, 'Property pricing updated', property);
  } catch (err) {
    next(err);
  }
}

// PUT /api/properties/:id/approve
async function approveProperty(req, res, next) {
  try {
    const property = await propertyService.approveProperty(req.params.id, req.user);
    return success(res, 200, 'Property approved successfully', property);
  } catch (err) {
    next(err);
  }
}

// PUT /api/properties/:id/reject
async function rejectProperty(req, res, next) {
  try {
    const property = await propertyService.rejectProperty(req.params.id, req.body.reason, req.user);
    return success(res, 200, 'Property rejected', property);
  } catch (err) {
    next(err);
  }
}

// GET /api/properties/:id/inquiries
async function getPropertyInquiries(req, res, next) {
  try {
    // Placeholder - the Lead/Inquiry module has not been built yet.
    // Once it exists, this should list inquiries raised against this property.
    return success(res, 200, 'Property inquiries fetched successfully', []);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listProperties,
  getProperty,
  createProperty,
  updateProperty,
  deleteProperty,
  addMedia,
  deleteMedia,
  updateAvailability,
  updatePricing,
  approveProperty,
  rejectProperty,
  getPropertyInquiries,
};
