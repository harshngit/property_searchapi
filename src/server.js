require('dotenv').config();

// The VPS is dual-stack (IPv4 + IPv6). Outbound HTTPS calls (e.g. to MSG91)
// were nondeterministically going out over IPv6 depending on DNS resolution
// order, which isn't the address MSG91 has whitelisted - causing the same
// request to succeed or fail with "IP is not whitelisted" across identical
// calls. Forcing IPv4 first makes outbound connections consistent.
require('dns').setDefaultResultOrder('ipv4first');

const app = require('./app');

// Port 5000 is commonly occupied by macOS ControlCenter on local machines.
// Keep it configurable while using 5001 as the development fallback.
const PORT = process.env.PORT || 5001;

app.listen(PORT, () => {
  console.log(`PropertySerch Auth Service running on http://localhost:${PORT}`);
  console.log(`Swagger docs available at http://localhost:${PORT}/api-docs`);
});
