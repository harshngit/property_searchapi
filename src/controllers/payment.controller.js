const paymentService = require('../services/payment.service');
const { success } = require('../utils/response');

// POST /api/payments/initiate
async function initiatePayment(req, res, next) {
  try {
    const { payment, gatewayOrder } = await paymentService.initiatePayment(req.body, req.user);
    return success(res, 201, 'Payment initiated successfully', { payment, gatewayOrder });
  } catch (err) {
    next(err);
  }
}

// POST /api/payments/webhook (public)
async function handleWebhook(req, res, next) {
  try {
    const payment = await paymentService.handleWebhook(req.body);
    return success(res, 200, 'Webhook processed successfully', payment);
  } catch (err) {
    next(err);
  }
}

// GET /api/payments/:id
async function getPayment(req, res, next) {
  try {
    const payment = await paymentService.getPaymentById(req.params.id, req.user);
    return success(res, 200, 'Payment fetched successfully', payment);
  } catch (err) {
    next(err);
  }
}

// GET /api/payments/deal/:dealId
async function getPaymentsByDeal(req, res, next) {
  try {
    const payments = await paymentService.getPaymentsByDeal(req.params.dealId, req.user);
    return success(res, 200, 'Payments fetched successfully', payments);
  } catch (err) {
    next(err);
  }
}

// GET /api/payments/milestones/:dealId
async function getMilestonesByDeal(req, res, next) {
  try {
    const milestones = await paymentService.getMilestonesByDeal(req.params.dealId, req.user);
    return success(res, 200, 'Milestones fetched successfully', milestones);
  } catch (err) {
    next(err);
  }
}

// POST /api/payments/milestones
async function createMilestone(req, res, next) {
  try {
    const milestone = await paymentService.createMilestone(req.body, req.user);
    return success(res, 201, 'Milestone created successfully', milestone);
  } catch (err) {
    next(err);
  }
}

// PUT /api/payments/milestones/:id
async function updateMilestone(req, res, next) {
  try {
    const milestone = await paymentService.updateMilestone(req.params.id, req.body, req.user);
    return success(res, 200, 'Milestone updated successfully', milestone);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  initiatePayment,
  handleWebhook,
  getPayment,
  getPaymentsByDeal,
  getMilestonesByDeal,
  createMilestone,
  updateMilestone,
};
