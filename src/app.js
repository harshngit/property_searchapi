const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const swaggerUi = require('swagger-ui-express');

const swaggerSpec = require('./config/swagger');
const authRoutes = require('./routes/auth.routes');
const userRoutes = require('./routes/user.routes');
const tenantRoutes = require('./routes/tenant.routes');
const propertyRoutes = require('./routes/property.routes');
const searchRoutes = require('./routes/search.routes');
const { projectRouter, unitRouter } = require('./routes/project.routes');
const leadRoutes = require('./routes/lead.routes');
const customerRoutes = require('./routes/customer.routes');
const { taskRouter, followupRouter } = require('./routes/task.routes');
const notificationRoutes = require('./routes/notification.routes');
const brokerRoutes = require('./routes/broker.routes');
const dealRoutes = require('./routes/deal.routes');
const documentRoutes = require('./routes/document.routes');
const paymentRoutes = require('./routes/payment.routes');
const reportRoutes = require('./routes/report.routes');
const whatsappRoutes = require('./routes/whatsapp.routes');
const aiRoutes = require('./routes/ai.routes');
const matchingRoutes = require('./routes/matching.routes');
const adminRoutes = require('./routes/admin.routes');
const { geoRouter, disclaimerRouter } = require('./routes/geo.routes');
const contentRoutes = require('./routes/content.routes');
const bdLeadRoutes = require('./routes/bdLead.routes');
const opportunityRoutes = require('./routes/opportunity.routes');
const { investorRouter, nriRouter, hniRouter, toolsRouter } = require('./routes/investor.routes');
const portalRoutes = require('./routes/portal.routes');
const dealRoomRoutes = require('./routes/dealRoom.routes');
const crawlerRoutes = require('./routes/crawler.routes');
const workspaceRoutes = require('./routes/workspace.routes');
const trustRoutes = require('./routes/trust.routes');
const fraudRoutes = require('./routes/fraud.routes');
const dueDiligenceRoutes = require('./routes/dueDiligence.routes');
const disputeRoutes = require('./routes/dispute.routes');
const orchestrationRoutes = require('./routes/orchestration.routes');
const reputationRoutes = require('./routes/reputation.routes');
const guestRoutes = require('./routes/guest.routes');
const enquiryRoutes = require('./routes/enquiry.routes');
const institutionalRoutes = require('./routes/institutional.routes');
const advertisingRoutes = require('./routes/advertising.routes');
const gamificationRoutes = require('./routes/gamification.routes');
const i18nRoutes = require('./routes/i18n.routes');
const privacyRoutes = require('./routes/privacy.routes');
const complianceRoutes = require('./routes/compliance.routes');
const chatRoutes = require('./routes/chat.routes');
const developerRoutes = require('./routes/developer.routes');
const exchangeRoutes = require('./routes/exchange.routes');
const wfhRoutes = require('./routes/wfh.routes');
const templateRoutes = require('./routes/template.routes');
const publicApiRoutes = require('./routes/publicApi.routes');
const marketRoutes = require('./routes/market.routes');
const mandateRoutes = require('./routes/mandate.routes');
const representativeRoutes = require('./routes/representative.routes');
const ingestRoutes = require('./routes/ingest.routes');
const leadSourceRoutes = require('./routes/leadSource.routes');
const telegramRoutes = require('./routes/telegram.routes');
const eventsRoutes = require('./routes/events.routes');
const { notFoundHandler, errorHandler } = require('./middlewares/errorHandler');

const app = express();

// The VPS deployment sits behind a reverse proxy (e.g. Nginx), which adds an
// X-Forwarded-For header. Without this, Express ignores that header (so
// req.ip is always the proxy's own IP) and express-rate-limit throws
// ERR_ERL_UNEXPECTED_X_FORWARDED_FOR since it can't safely tell which client
// is which. `1` means "trust exactly one hop in front of this app" - correct
// for a single reverse proxy on the same box; raise it if another layer
// (e.g. a load balancer) sits in front of that.
app.set('trust proxy', 1);

app.use(helmet());
app.use(cors());
// `verify` stashes the exact request bytes on req.rawBody before parsing -
// needed to check Meta's X-Hub-Signature-256 on the WhatsApp webhook.
// Translation files (Module 30) are larger than the default 100 kB body.
const jsonBody = express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } });
const largeJsonBody = express.json({ limit: '5mb' });
app.use((req, res, next) => (req.path.startsWith('/api/i18n/manage/') ? largeJsonBody : jsonBody)(req, res, next));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

// Basic rate limiting on auth routes to prevent brute force / OTP abuse
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please try again later.' },
});
app.use('/api/auth', authLimiter);

// Swagger docs
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.get('/api-docs.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.send(swaggerSpec);
});

// Health check
app.get('/health', (req, res) => {
  res.json({ success: true, message: 'PropertySerch Auth Service is running' });
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/tenants', tenantRoutes);
app.use('/api/properties', propertyRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/projects', projectRouter);
app.use('/api/units', unitRouter);
// Public ingestion webhooks first - they authenticate by source credential, not user.
app.use('/api/leads/ingest', ingestRoutes);
app.use('/api/leads', leadRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/tasks', taskRouter);
app.use('/api/followups', followupRouter);
app.use('/api/notifications', notificationRoutes);
app.use('/api/broker', brokerRoutes);
app.use('/api/deals', dealRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/matching', matchingRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/geo', geoRouter);
app.use('/api/disclaimers', disclaimerRouter);
app.use('/api/content', contentRoutes);
app.use('/api/bd-leads', bdLeadRoutes);
app.use('/api/opportunities', opportunityRoutes);
app.use('/api/investors', investorRouter);
app.use('/api/nri', nriRouter);
app.use('/api/hni', hniRouter);
app.use('/api/tools', toolsRouter);
app.use('/api/me', portalRoutes);
app.use('/api/deal-room', dealRoomRoutes);
app.use('/api/crawlers', crawlerRoutes);
app.use('/api/workspace', workspaceRoutes);
app.use('/api/trust', trustRoutes);
app.use('/api/fraud', fraudRoutes);
app.use('/api/due-diligence', dueDiligenceRoutes);
app.use('/api/disputes', disputeRoutes);
app.use('/api/orchestration', orchestrationRoutes);
app.use('/api/reputation', reputationRoutes);
app.use('/api/guest', guestRoutes);
app.use('/api/enquiries', enquiryRoutes);
app.use('/api/institutional', institutionalRoutes);
app.use('/api/ads', advertisingRoutes);
app.use('/api/gamification', gamificationRoutes);
app.use('/api/i18n', i18nRoutes);
app.use('/api/user', privacyRoutes);
app.use('/api/compliance', complianceRoutes);
app.use('/api/chat', chatRoutes.chatRouter);
app.use('/api/inquiry', chatRoutes.inquiryRouter);
app.use('/api/developer', developerRoutes);
app.use('/api/exchange', exchangeRoutes);
app.use('/api/wfh', wfhRoutes);
app.use('/api/templates', templateRoutes);
app.use('/api/v1', publicApiRoutes);
app.use('/api/market', marketRoutes);
app.use('/api/mandates', mandateRoutes);
app.use('/api/representatives', representativeRoutes);
app.use('/api/lead-sources', leadSourceRoutes);
app.use('/api/telegram', telegramRoutes);
app.use('/api', eventsRoutes);

// 404 + error handler (must be last)
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;