#!/usr/bin/env node
// Acceptance gate (sec. 29.1): no hardcoded city, locality, state or pincode in
// the code of any app. Places must come from master data. Comments, migrations
// (seed data) and translation catalogues are not code. The company's registered
// address is a fact about the company, not a city list, so it is allowed.
// Exits 1 and lists every hit; `npm run lint:geo`.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const APPS = ['property_searchapi/src', 'property_dashboard/src', 'propert_website/src'];
const PLACES = [
  'Delhi', 'Gurugram', 'Gurgaon', 'Noida', 'Ghaziabad', 'Faridabad', 'Dwarka', 'Mumbai', 'Bombay', 'Thane', 'Pune', 'Poona', 'Bengaluru', 'Bangalore', 'Hyderabad', 'Warangal',
  'Chennai', 'Madras', 'Kolkata', 'Calcutta', 'Ahmedabad', 'Jaipur', 'Chandigarh', 'Lucknow', 'Indore', 'Bhopal', 'Nagpur', 'Surat', 'Kochi', 'Goa', 'Vizag', 'Visakhapatnam',
  'Worli', 'Andheri', 'Bandra', 'Powai', 'Whitefield', 'Saket', 'Borivali', 'Maharashtra', 'Karnataka', 'Haryana', 'Telangana', 'Rajasthan', 'Uttar Pradesh', 'Tamil Nadu', 'Gujarat',
];
const NAME = new RegExp(`\\b(${PLACES.join('|')})\\b`, 'i');
const PINCODE = /["'`][1-9]\d{5}["'`]/;
const SKIP_DIRS = new Set(['migrations', 'node_modules', 'locales']);
const SKIP_FILES = new Set(['blogArticles.js']); // editorial articles, for the client to review
const ALLOW = [/Asia\/Kolkata/, /G-53/, /110027/, /Rajouri Garden, New Delhi/, /addressLocality/, /addressRegion/, /streetAddress/];

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* walk(path.join(dir, e.name));
    } else if (/\.(js|jsx|ts|tsx)$/.test(e.name) && !SKIP_FILES.has(e.name)) yield path.join(dir, e.name);
  }
}

const hits = [];
for (const app of APPS) {
  const dir = path.join(ROOT, app);
  if (!fs.existsSync(dir)) continue;
  for (const file of walk(dir)) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('{/*')) return;
      const code = line.replace(/\s\/\/ .*$/, '');
      if (ALLOW.some((re) => re.test(code))) return;
      const m = code.match(NAME) || code.match(PINCODE);
      if (m) hits.push(`${path.relative(ROOT, file)}:${i + 1}: ${m[0]}: ${t.slice(0, 100)}`);
    });
  }
}
if (hits.length) {
  console.error(`Hardcoded places found (${hits.length}):\n${hits.join('\n')}`);
  process.exit(1);
}
console.log('No hardcoded cities, localities, states or pincodes.');
