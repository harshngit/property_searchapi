const propertyService = require('../services/property.service');
const { success, error } = require('../utils/response');
const { assertOwnerOrAdmin, assertTenantVisible } = require('../utils/ownership');
const { bulkDelete } = require('../utils/bulkDelete');

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
      minRate: req.query.minRate,
      maxRate: req.query.maxRate,
      listingCategory: req.query.listingCategory,
      search: req.query.search,
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
    const message =
      property.status === 'approved'
        ? 'Property created, verified and published'
        : 'Property created successfully, pending approval';
    return success(res, 201, message, property);
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
async function deleteOneProperty(id, actingUser) {
  const existing = await propertyService.getPropertyById(id);
  assertOwnerOrAdmin(actingUser, existing, { allowTenantManagers: ['agency_admin'] });
  await propertyService.deleteProperty(id);
}

async function deleteProperty(req, res, next) {
  try {
    await deleteOneProperty(req.params.id, req.user);
    return success(res, 200, 'Property deleted successfully');
  } catch (err) {
    next(err);
  }
}

// POST /api/properties/bulk-delete
async function bulkDeleteProperties(req, res, next) {
  try {
    const result = await bulkDelete(req.body.ids, (id) => deleteOneProperty(id, req.user));
    return success(res, 200, `${result.deletedCount} property(ies) deleted`, result);
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

// POST /api/properties/:id/media/upload
async function uploadMedia(req, res, next) {
  try {
    if (!req.file) return error(res, 400, 'A file is required (field name: file)');

    const existing = await propertyService.getPropertyById(req.params.id);
    assertOwnerOrAdmin(req.user, existing, { allowTenantManagers: ['agency_admin'] });

    const media = await propertyService.uploadMedia(req.params.id, req.file, {
      isPrimary: req.body.isPrimary === 'true' || req.body.isPrimary === true,
      displayOrder: Number(req.body.displayOrder) || 0,
    });
    return success(res, 201, 'Media uploaded successfully', media);
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

// PUT /api/properties/:id/media/:mediaId/primary
async function setPrimaryMedia(req, res, next) {
  try {
    const existing = await propertyService.getPropertyById(req.params.id);
    assertOwnerOrAdmin(req.user, existing, { allowTenantManagers: ['agency_admin'] });

    const media = await propertyService.setPrimaryMedia(req.params.id, req.params.mediaId);
    return success(res, 200, 'Cover photo updated successfully', media);
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
// Every lead raised against the listing (website enquiries, portal
// requirements, WhatsApp, manual) with its status, owner and deal stage.
// Staff with access to the property only - customers use /me/listings.
async function getPropertyInquiries(req, res, next) {
  try {
    const property = await propertyService.getPropertyById(req.params.id);
    assertTenantVisible(req.user, property, 'Property not found', { ownerFields: ['created_by', 'broker_id', 'builder_id'] });
    if (req.user.role === 'customer') {
      const err = new Error('Customers see enquiries on their listings in their dashboard');
      err.statusCode = 403;
      throw err;
    }
    const inquiries = await propertyService.listPropertyInquiries(req.params.id);
    return success(res, 200, 'Property inquiries fetched successfully', inquiries);
  } catch (err) {
    next(err);
  }
}

// POST /api/properties/:id/favorite
async function addFavorite(req, res, next) {
  try {
    await propertyService.addFavorite(req.params.id, req.user);
    return success(res, 200, 'Property added to favorites');
  } catch (err) {
    next(err);
  }
}

// DELETE /api/properties/:id/favorite
async function removeFavorite(req, res, next) {
  try {
    await propertyService.removeFavorite(req.params.id, req.user);
    return success(res, 200, 'Property removed from favorites');
  } catch (err) {
    next(err);
  }
}

// GET /api/properties/favorites
async function listFavorites(req, res, next) {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const { items, pagination } = await propertyService.listFavorites(req.user, page, limit);
    return success(res, 200, 'Favorites fetched successfully', { items, pagination });
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
  bulkDeleteProperties,
  addMedia,
  uploadMedia,
  deleteMedia,
  setPrimaryMedia,
  updateAvailability,
  updatePricing,
  approveProperty,
  rejectProperty,
  getPropertyInquiries,
  addFavorite,
  removeFavorite,
  listFavorites,
};
