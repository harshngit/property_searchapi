const portalService = require('../services/portal.service');
const rentalService = require('../services/rental.service');
const auditService = require('../services/audit.service');
const { success } = require('../utils/response');
const handler = require('../utils/asyncHandler');

// Customer portal (website Lite Dashboard) - thin wrappers over
// portal.service / rental.service. Every call is scoped to req.user.

const meta = (req) => auditService.requestMeta(req);

module.exports = {
  getProfile: handler(async (req, res) => success(res, 200, 'Profile fetched', await portalService.getProfile(req.user))),
  saveProfile: handler(async (req, res) =>
    success(res, 200, 'Profile saved', await portalService.saveProfile(req.user, req.body, meta(req)))
  ),
  overview: handler(async (req, res) => success(res, 200, 'Dashboard fetched', await portalService.getOverview(req.user))),

  listRequirements: handler(async (req, res) =>
    success(res, 200, 'Requirements fetched', await portalService.listRequirements(req.user))
  ),
  createRequirement: handler(async (req, res) =>
    success(res, 201, 'Requirement posted', await portalService.createRequirement(req.user, req.body, meta(req)))
  ),
  updateRequirement: handler(async (req, res) =>
    success(res, 200, 'Requirement updated', await portalService.updateRequirement(req.user, req.params.id, req.body, meta(req)))
  ),
  matches: handler(async (req, res) =>
    success(res, 200, 'Matches fetched', await portalService.getMatches(req.user, { requirementId: req.query.requirementId }))
  ),

  listFavourites: handler(async (req, res) => success(res, 200, 'Favourites fetched', await portalService.listFavourites(req.user))),

  listSavedSearches: handler(async (req, res) =>
    success(res, 200, 'Saved searches fetched', await portalService.listSavedSearches(req.user))
  ),
  createSavedSearch: handler(async (req, res) =>
    success(res, 201, 'Search saved', await portalService.createSavedSearch(req.user, req.body))
  ),
  updateSavedSearch: handler(async (req, res) =>
    success(res, 200, 'Saved search updated', await portalService.updateSavedSearch(req.user, req.params.id, req.body))
  ),
  deleteSavedSearch: handler(async (req, res) => {
    await portalService.deleteSavedSearch(req.user, req.params.id);
    return success(res, 200, 'Saved search deleted', null);
  }),

  listEnquiries: handler(async (req, res) => success(res, 200, 'Enquiries fetched', await portalService.listEnquiries(req.user))),
  requestVisit: handler(async (req, res) =>
    success(res, 200, 'Visit request sent to your representative', await portalService.requestVisit(req.user, req.params.id, req.body))
  ),
  listVisits: handler(async (req, res) => success(res, 200, 'Visits fetched', await portalService.listVisits(req.user))),

  listListings: handler(async (req, res) => success(res, 200, 'Listings fetched', await portalService.listListings(req.user))),
  createListing: handler(async (req, res) =>
    success(res, 201, 'Property submitted for approval', await portalService.createListing(req.user, req.body, meta(req)))
  ),
  updateListing: handler(async (req, res) =>
    success(res, 200, 'Listing updated and sent for approval', await portalService.updateListing(req.user, req.params.id, req.body, meta(req)))
  ),
  listingAction: handler(async (req, res) =>
    success(res, 200, 'Listing updated', await portalService.setListingState(req.user, req.params.id, req.params.action, meta(req)))
  ),
  listingEnquiries: handler(async (req, res) =>
    success(res, 200, 'Listing enquiries fetched', await portalService.listListingEnquiries(req.user, req.params.id))
  ),

  listDocuments: handler(async (req, res) => success(res, 200, 'Documents fetched', await portalService.listDocuments(req.user))),
  uploadDocument: handler(async (req, res) =>
    success(res, 201, 'Document uploaded', await portalService.uploadDocument(req.user, req.file, req.body))
  ),

  listLeases: handler(async (req, res) => success(res, 200, 'Rentals fetched', await rentalService.listLeases(req.user))),
  getLease: handler(async (req, res) => success(res, 200, 'Lease fetched', await rentalService.getLease(req.user, req.params.id))),
  createLease: handler(async (req, res) =>
    success(res, 201, 'Lease added', await rentalService.createLease(req.user, req.body, meta(req)))
  ),
  updateLease: handler(async (req, res) =>
    success(res, 200, 'Lease updated', await rentalService.updateLease(req.user, req.params.id, req.body, meta(req)))
  ),
  confirmLease: handler(async (req, res) =>
    success(res, 200, 'Lease confirmed', await rentalService.confirmLease(req.user, req.params.id, meta(req)))
  ),
  reportRent: handler(async (req, res) =>
    success(res, 200, 'Payment reported to the owner', await rentalService.reportRent(req.user, req.params.id, req.params.paymentId, req.body, meta(req)))
  ),
  reviewRent: handler(async (req, res) =>
    success(res, 200, 'Payment updated', await rentalService.reviewRent(req.user, req.params.id, req.params.paymentId, req.body, meta(req)))
  ),
  createMaintenance: handler(async (req, res) =>
    success(res, 201, 'Request raised', await rentalService.createMaintenance(req.user, req.params.id, req.body, meta(req)))
  ),
  updateMaintenance: handler(async (req, res) =>
    success(res, 200, 'Request updated', await rentalService.updateMaintenance(req.user, req.params.id, req.params.requestId, req.body, meta(req)))
  ),
};
