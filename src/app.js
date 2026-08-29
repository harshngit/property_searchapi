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
app.use(express.json());
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

// 404 + error handler (must be last)
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;