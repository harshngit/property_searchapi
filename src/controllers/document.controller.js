const documentService = require('../services/document.service');
const { success } = require('../utils/response');
const { assertOwnerOrAdmin, assertTenantVisible } = require('../utils/ownership');

const DOCUMENT_OWNER_FIELDS = ['uploaded_by'];

// GET /api/documents
async function listDocuments(req, res, next) {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);

    const filters = {
      documentType: req.query.documentType,
      status: req.query.status,
      customerId: req.query.customerId,
      dealId: req.query.dealId,
    };

    const { items, pagination } = await documentService.listDocuments(req.user, filters, page, limit);
    return success(res, 200, 'Documents fetched successfully', { items, pagination });
  } catch (err) {
    next(err);
  }
}

// GET /api/documents/:id
async function getDocument(req, res, next) {
  try {
    const document = await documentService.getDocumentById(req.params.id);
    assertTenantVisible(req.user, document, 'Document not found', { ownerFields: DOCUMENT_OWNER_FIELDS });
    return success(res, 200, 'Document fetched successfully', document);
  } catch (err) {
    next(err);
  }
}

// POST /api/documents
async function createDocument(req, res, next) {
  try {
    const document = await documentService.createDocument(req.body, req.user);
    return success(res, 201, 'Document uploaded successfully', document);
  } catch (err) {
    next(err);
  }
}

// PUT /api/documents/:id
async function updateDocument(req, res, next) {
  try {
    const existing = await documentService.getDocumentById(req.params.id);
    assertOwnerOrAdmin(req.user, existing, {
      allowTenantManagers: ['agency_admin'],
      ownerFields: DOCUMENT_OWNER_FIELDS,
    });

    const document = await documentService.updateDocument(req.params.id, req.body);
    return success(res, 200, 'Document updated successfully', document);
  } catch (err) {
    next(err);
  }
}

// DELETE /api/documents/:id
async function deleteDocument(req, res, next) {
  try {
    const existing = await documentService.getDocumentById(req.params.id);
    // Explicitly "owner or admin only" - no tenant-manager carve-out here.
    assertOwnerOrAdmin(req.user, existing, { ownerFields: DOCUMENT_OWNER_FIELDS });

    await documentService.deleteDocument(req.params.id);
    return success(res, 200, 'Document deleted successfully');
  } catch (err) {
    next(err);
  }
}

// GET /api/documents/customer/:customerId
async function getByCustomer(req, res, next) {
  try {
    const documents = await documentService.getByCustomer(req.user, req.params.customerId);
    return success(res, 200, 'Documents fetched successfully', documents);
  } catch (err) {
    next(err);
  }
}

// GET /api/documents/deal/:dealId
async function getByDeal(req, res, next) {
  try {
    const documents = await documentService.getByDeal(req.user, req.params.dealId);
    return success(res, 200, 'Documents fetched successfully', documents);
  } catch (err) {
    next(err);
  }
}

// PUT /api/documents/:id/review
async function reviewDocument(req, res, next) {
  try {
    await documentService.getDocumentById(req.params.id); // 404 if missing
    const document = await documentService.reviewDocument(req.params.id, req.body, req.user);
    return success(res, 200, `Document ${req.body.status}`, document);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listDocuments,
  getDocument,
  createDocument,
  updateDocument,
  deleteDocument,
  getByCustomer,
  getByDeal,
  reviewDocument,
};
