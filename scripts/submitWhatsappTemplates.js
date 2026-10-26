// One-time script: creates the 29 client-approved WhatsApp templates on Meta
// (POST /{WABA_ID}/message_templates). Run from the VPS where the real
// WHATSAPP_ACCESS_TOKEN / WHATSAPP_BUSINESS_ACCOUNT_ID already live in .env.
//
// Usage:
//   node scripts/submitWhatsappTemplates.js            create every template not yet on Meta
//   node scripts/submitWhatsappTemplates.js --status    just list current status, create nothing
//
// 25 of the 29 templates (no document/image header) are created here via the
// API. The other 4 - ar_fee_consent_record, ar_benefit_delivered,
// ar_invoice_generated, ar_digest_sponsored - need a sample document/image
// uploaded with them; that upload is a separate Resumable Upload API flow
// this script does not implement. Create those 4 by hand in WhatsApp Manager
// (Message Templates -> Create Template) using the body/footer/button text
// this script prints for them, with any representative sample PDF/image
// attached as the header - the exact wording still has to match character
// for character, the header media is just a design preview for Meta's review.
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const WABA_ID = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
const TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const GRAPH_VERSION = 'v19.0';

if (!WABA_ID || !TOKEN) {
  console.error('Missing WHATSAPP_BUSINESS_ACCOUNT_ID or WHATSAPP_ACCESS_TOKEN in .env');
  process.exit(1);
}

const AUTH_TEMPLATE = {
  name: 'ar_otp_verification',
  language: 'en',
  category: 'AUTHENTICATION',
  components: [
    { type: 'BODY', add_security_recommendation: true },
    { type: 'FOOTER', code_expiration_minutes: 10 },
    { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'COPY_CODE' }] },
  ],
};

const templates = JSON.parse(fs.readFileSync(path.join(__dirname, 'meta_templates.json'), 'utf8'));
const apiTemplates = [AUTH_TEMPLATE, ...templates.filter((t) => !t.headerMedia)];
const manualTemplates = templates.filter((t) => t.headerMedia);

async function listExisting() {
  const map = new Map();
  let url = `https://graph.facebook.com/${GRAPH_VERSION}/${WABA_ID}/message_templates?fields=name,status,category&limit=100`;
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const data = await res.json();
    if (!res.ok) throw new Error(`List templates failed: ${data.error?.message || res.statusText}`);
    for (const t of data.data || []) map.set(t.name, t.status);
    url = data.paging?.next || null;
  }
  return map;
}

async function createTemplate(payload) {
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${WABA_ID}/message_templates`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  return { ok: res.ok, data };
}

async function main() {
  const statusOnly = process.argv.includes('--status');
  const existing = await listExisting();

  console.log(`\nCurrently on Meta (${existing.size}):`);
  for (const [name, status] of existing) console.log(`  ${status.padEnd(10)} ${name}`);

  if (statusOnly) return;

  console.log(`\nSubmitting via API (${apiTemplates.length} templates)...`);
  const results = [];
  for (const t of apiTemplates) {
    if (existing.has(t.name)) {
      console.log(`SKIP   ${t.name} (already ${existing.get(t.name)})`);
      continue;
    }
    const { ok, data } = await createTemplate(t);
    if (ok) {
      console.log(`OK     ${t.name} -> id ${data.id}, status ${data.status}`);
      results.push({ name: t.name, ok: true, status: data.status });
    } else {
      console.log(`FAIL   ${t.name}: ${data.error?.message || 'unknown error'}${data.error?.error_user_msg ? ` (${data.error.error_user_msg})` : ''}`);
      results.push({ name: t.name, ok: false, error: data.error?.message });
    }
    // Be polite to the rate limit between creates.
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`\nDone: ${results.filter((r) => r.ok).length} created, ${results.filter((r) => !r.ok).length} failed, ${apiTemplates.length - results.length} already existed.`);

  if (manualTemplates.length) {
    console.log(`\n${manualTemplates.length} templates need a sample document/image header - create these by hand in WhatsApp Manager:`);
    for (const t of manualTemplates) {
      console.log(`\n--- ${t.name} (${t.category}, ${t.headerMedia} header) ---`);
      console.log(`Body:\n${t.components.find((c) => c.type === 'BODY').text}`);
      const footer = t.components.find((c) => c.type === 'FOOTER');
      if (footer) console.log(`Footer: ${footer.text}`);
      const buttons = t.components.find((c) => c.type === 'BUTTONS');
      if (buttons) console.log(`Buttons: ${buttons.buttons.map((b) => `${b.type} "${b.text}"${b.url ? ` -> ${b.url}` : ''}`).join(', ')}`);
    }
  }

  console.log('\nRe-run with --status in a few minutes to check approval status.');
}

main().catch((err) => {
  console.error('Script failed:', err.message);
  process.exit(1);
});
