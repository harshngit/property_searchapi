const customerService = require('../services/customer.service');
const { success } = require('../utils/response');
const { assertOwnerOrAdmin, assertTenantVisible } = require('../utils/ownership');

// GET /api/customers
async function listCustomers(req, res, next) {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const filters = { search: req.query.search };

    const { items, pagination } = await customerService.listCustomers(req.user, filters, page, limit);
    return success(res, 200, 'Customers fetched successfully', { items, pagination });
  } catch (err) {
    next(err);
  }
}

// GET /api/customers/:id
async function getCustomer(req, res, next) {
  try {
    const customer = await customerService.getCustomerById(req.params.id);
    assertTenantVisible(req.user, customer, 'Customer not found');
    return success(res, 200, 'Customer fetched successfully', customer);
  } catch (err) {
    next(err);
  }
}

// POST /api/customers
async function createCustomer(req, res, next) {
  try {
    const customer = await customerService.createCustomer(req.body, req.user);
    return success(res, 201, 'Customer created successfully', customer);
  } catch (err) {
    next(err);
  }
}

// PUT /api/customers/:id
async function updateCustomer(req, res, next) {
  try {
    const existing = await customerService.getCustomerById(req.params.id);
    assertOwnerOrAdmin(req.user, existing, { allowTenantManagers: ['agency_admin'] });

    const customer = await customerService.updateCustomer(req.params.id, req.body);
    return success(res, 200, 'Customer updated successfully', customer);
  } catch (err) {
    next(err);
  }
}

// GET /api/customers/:id/preferences
async function getPreferences(req, res, next) {
  try {
    const customer = await customerService.getCustomerById(req.params.id);
    assertTenantVisible(req.user, customer, 'Customer not found');

    const preferences = await customerService.getPreferences(req.params.id);
    return success(res, 200, 'Preferences fetched successfully', preferences);
  } catch (err) {
    next(err);
  }
}

// PUT /api/customers/:id/preferences
async function upsertPreferences(req, res, next) {
  try {
    const customer = await customerService.getCustomerById(req.params.id);
    assertOwnerOrAdmin(req.user, customer, { allowTenantManagers: ['agency_admin'] });

    const preferences = await customerService.upsertPreferences(req.params.id, req.body);
    return success(res, 200, 'Preferences saved successfully', preferences);
  } catch (err) {
    next(err);
  }
}

// GET /api/customers/:id/documents
async function getDocuments(req, res, next) {
  try {
    const customer = await customerService.getCustomerById(req.params.id);
    assertTenantVisible(req.user, customer, 'Customer not found');

    const documents = await customerService.getDocuments(req.params.id);
    return success(res, 200, 'Documents fetched successfully', documents);
  } catch (err) {
    next(err);
  }
}

// POST /api/customers/:id/documents
async function addDocument(req, res, next) {
  try {
    const customer = await customerService.getCustomerById(req.params.id);
    assertOwnerOrAdmin(req.user, customer, { allowTenantManagers: ['agency_admin'] });

    const document = await customerService.addDocument(req.params.id, req.body, req.user);
    return success(res, 201, 'Document added successfully', document);
  } catch (err) {
    next(err);
  }
}

// GET /api/customers/:id/conversations
async function getConversations(req, res, next) {
  try {
    const customer = await customerService.getCustomerById(req.params.id);
    assertTenantVisible(req.user, customer, 'Customer not found');

    // Placeholder - the WhatsApp module has not been built yet.
    return success(res, 200, 'Conversations fetched successfully', []);
  } catch (err) {
    next(err);
  }
}

// GET /api/customers/:id/deals
async function getDeals(req, res, next) {
  try {
    const customer = await customerService.getCustomerById(req.params.id);
    assertTenantVisible(req.user, customer, 'Customer not found');

    const deals = await customerService.getCustomerDeals(req.user, req.params.id);
    return success(res, 200, 'Deals fetched successfully', deals);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listCustomers,
  getCustomer,
  createCustomer,
  updateCustomer,
  getPreferences,
  upsertPreferences,
  getDocuments,
  addDocument,
  getConversations,
  getDeals,
};
