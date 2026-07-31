const dealService = require('../services/deal.service');
const { success } = require('../utils/response');
const { assertOwnerOrAdmin, assertTenantVisible } = require('../utils/ownership');

const DEAL_OWNER_FIELDS = ['broker_id'];

// GET /api/deals
async function listDeals(req, res, next) {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);

    const filters = {
      stage: req.query.stage,
      brokerId: req.query.brokerId,
      dateFrom: req.query.dateFrom,
      dateTo: req.query.dateTo,
    };

    const { items, pagination } = await dealService.listDeals(req.user, filters, page, limit);
    return success(res, 200, 'Deals fetched successfully', { items, pagination });
  } catch (err) {
    next(err);
  }
}

// GET /api/deals/:id
async function getDeal(req, res, next) {
  try {
    const deal = await dealService.getDealById(req.params.id);
    assertTenantVisible(req.user, deal, 'Deal not found', { ownerFields: DEAL_OWNER_FIELDS });
    return success(res, 200, 'Deal fetched successfully', deal);
  } catch (err) {
    next(err);
  }
}

// POST /api/deals
async function createDeal(req, res, next) {
  try {
    const deal = await dealService.createDeal(req.body, req.user);
    return success(res, 201, 'Deal created successfully', deal);
  } catch (err) {
    next(err);
  }
}

// PUT /api/deals/:id
async function updateDeal(req, res, next) {
  try {
    const existing = await dealService.getDealById(req.params.id);
    assertOwnerOrAdmin(req.user, existing, {
      allowTenantManagers: ['agency_admin'],
      ownerFields: DEAL_OWNER_FIELDS,
    });

    const deal = await dealService.updateDeal(req.params.id, req.body);
    return success(res, 200, 'Deal updated successfully', deal);
  } catch (err) {
    next(err);
  }
}

// PUT /api/deals/:id/stage
async function changeStage(req, res, next) {
  try {
    const existing = await dealService.getDealById(req.params.id);
    assertOwnerOrAdmin(req.user, existing, {
      allowTenantManagers: ['agency_admin'],
      ownerFields: DEAL_OWNER_FIELDS,
    });

    const deal = await dealService.changeStage(req.params.id, req.body.stage, req.user, req.body.notes);
    return success(res, 200, 'Deal stage updated successfully', deal);
  } catch (err) {
    next(err);
  }
}

// POST /api/deals/:id/site-visit
async function scheduleSiteVisit(req, res, next) {
  try {
    const existing = await dealService.getDealById(req.params.id);
    assertOwnerOrAdmin(req.user, existing, {
      allowTenantManagers: ['agency_admin'],
      ownerFields: DEAL_OWNER_FIELDS,
    });

    const visit = await dealService.scheduleSiteVisit(req.params.id, req.body, req.user);
    return success(res, 201, 'Site visit scheduled successfully', visit);
  } catch (err) {
    next(err);
  }
}

// PUT /api/deals/:id/site-visit/:visitId
async function updateSiteVisit(req, res, next) {
  try {
    const existing = await dealService.getDealById(req.params.id);
    assertOwnerOrAdmin(req.user, existing, {
      allowTenantManagers: ['agency_admin'],
      ownerFields: DEAL_OWNER_FIELDS,
    });

    const visit = await dealService.updateSiteVisit(req.params.id, req.params.visitId, req.body);
    return success(res, 200, 'Site visit updated successfully', visit);
  } catch (err) {
    next(err);
  }
}

// POST /api/deals/:id/negotiation
async function logNegotiation(req, res, next) {
  try {
    const existing = await dealService.getDealById(req.params.id);
    assertOwnerOrAdmin(req.user, existing, {
      allowTenantManagers: ['agency_admin'],
      ownerFields: DEAL_OWNER_FIELDS,
    });

    const deal = await dealService.logNegotiation(req.params.id, req.body, req.user);
    return success(res, 201, 'Negotiation logged successfully', deal);
  } catch (err) {
    next(err);
  }
}

// POST /api/deals/:id/booking
async function recordBooking(req, res, next) {
  try {
    const existing = await dealService.getDealById(req.params.id);
    assertOwnerOrAdmin(req.user, existing, {
      allowTenantManagers: ['agency_admin'],
      ownerFields: DEAL_OWNER_FIELDS,
    });

    const deal = await dealService.recordBooking(req.params.id, req.body, req.user);
    return success(res, 200, 'Booking recorded, deal moved to booking stage', deal);
  } catch (err) {
    next(err);
  }
}

// PUT /api/deals/:id/close
async function closeDeal(req, res, next) {
  try {
    const existing = await dealService.getDealById(req.params.id);
    assertOwnerOrAdmin(req.user, existing, {
      allowTenantManagers: ['agency_admin'],
      ownerFields: DEAL_OWNER_FIELDS,
    });

    const deal = await dealService.closeDeal(req.params.id, req.body, req.user);
    return success(res, 200, `Deal closed as ${req.body.outcome}`, deal);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listDeals,
  getDeal,
  createDeal,
  updateDeal,
  changeStage,
  scheduleSiteVisit,
  updateSiteVisit,
  logNegotiation,
  recordBooking,
  closeDeal,
};
