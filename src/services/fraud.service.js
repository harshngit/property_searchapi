const pool = require('../config/db');
const configService = require('./config.service');
const notificationService = require('./notification.service');
const auditService = require('./audit.service');
const { findViolations } = require('../utils/contentGuard');
const { badRequest, forbidden, notFound } = require('../utils/httpError');

// Annexure A sec. 9 / Module 19 - property verification, anti-duplicate
// detection and fraud risk scoring.
//
// Every non-admin residential listing is assessed when it is created, when
// it is edited and when photos are added (target < 5 s):
//   1. Duplicate detection, 4 layers: image fingerprint (near-duplicate by
//      Hamming distance), address / geo (50 m + fuzzy address), metadata
//      (same address + same lister = block, different lister + similar
//      price = flag), text similarity (> 95 % block, 85-95 % warn).
//   2. Fraud risk score 0-100 from the sec. 9.4 factors.
//   3. Action by band (sec. 9.5): Green - live instantly; Yellow - live with
//      an "Under Review" banner, 2 h review; Red - held, 24 h review, A R
//      contacts the lister; Critical - auto-rejected, lister flagged,
//      support notified, appeal allowed; repeat critical rejections suspend
//      the account.
//   4. L1 System Verified when the automatic checks pass; Legally Verified
//      (L3) auto-requested above the high-value threshold.
// The first valid listing (timestamp + user) always wins a duplicate: the
// newer lister chooses mandate-verification routing, updating the
// original, or cancelling.

const DEFAULT_WEIGHTS = {
  duplicate_images: 20, contact_in_text: 30, phone_visible: 15, url_link: 15, unusual_price: 25, new_lister_high_value: 20,
  suspicious_payment: 40, rapid_listings: 25, unverified_contact: 10, shared_accounts: 30, behaviour_anomaly: 15,
  stolen_content: 50, negative_reviews: 25,
};
const FACTOR_LABELS = {
  duplicate_images: 'Duplicate images detected',
  contact_in_text: 'Contact details in listing text',
  phone_visible: 'Phone number visible',
  url_link: 'URL / WhatsApp link',
  unusual_price: 'Unusual price vs circle rate',
  new_lister_high_value: 'New unverified lister with a high-value property',
  suspicious_payment: 'Suspicious payment request',
  rapid_listings: 'Many listings in 24 hours',
  unverified_contact: 'Lister contact not verified',
  shared_accounts: 'Multiple accounts from the same phone / IP',
  behaviour_anomaly: 'Behavioural anomaly',
  stolen_content: 'Images match another lister\'s listing',
  negative_reviews: 'Negative reviews from prior buyers / sellers',
};
const LEVEL_NAMES = { 1: 'Verified by System', 2: 'Seller Verified', 3: 'Legally Verified', 4: 'Site Verified' };
const LEVEL_CHECKS = {
  2: ['ownership_proof', 'id_verified', 'callback_done', 'photos_recent'],
  3: ['title_chain_3y', 'encumbrance_clear', 'no_litigation', 'tax_paid', 'regulatory_compliance'],
  4: ['photos_match', 'condition_ok', 'amenities_match', 'measurements_ok', 'inspection_report'],
};
const STAFF = ['internal_sales', 'admin', 'super_admin'];
const ADMIN = ['admin', 'super_admin'];
const INDIA = { latMin: 6, latMax: 37.6, lngMin: 68, lngMax: 97.5 };

async function cfg() {
  const [weights, bands, autoApprove, sla, suspendAfter, newDays, highValue, rapid, unusualPct, redFlags, dup, split, boosts, vsla, geoKm] = await Promise.all([
    configService.getConfig('fraud.weights', DEFAULT_WEIGHTS),
    configService.getConfig('fraud.bands', { yellow: 21, red: 41, critical: 71 }),
    configService.getConfig('fraud.auto_approve_green', true),
    configService.getConfig('fraud.review_sla_hours', { yellow: 2, red: 24 }),
    configService.getConfig('fraud.suspend_after_critical', 3),
    configService.getConfig('fraud.new_lister_days', 30),
    configService.getConfig('fraud.high_value_threshold', 10000000),
    configService.getConfig('fraud.rapid_listings_per_day', 10),
    configService.getConfig('fraud.unusual_price_percent', 50),
    configService.getConfig('fraud.payment_red_flags', []),
    configService.getConfig('duplicates.thresholds', {}),
    configService.getConfig('duplicates.routing_split', { original: 50, requester: 50 }),
    configService.getConfig('verification.search_boost', { 1: 5, 2: 15, 3: 25, 4: 35 }),
    configService.getConfig('verification.sla_hours', { 2: 24, 3: 72, 4: 120 }),
    configService.getConfig('fraud.geo_mismatch_km', 5),
  ]);
  return {
    weights: { ...DEFAULT_WEIGHTS, ...(weights || {}) },
    bands: { yellow: 21, red: 41, critical: 71, ...(bands || {}) },
    autoApprove: autoApprove !== false,
    sla: { yellow: 2, red: 24, ...(sla || {}) },
    suspendAfter: Number(suspendAfter) || 3,
    newDays: Number(newDays) || 30,
    highValue: Number(highValue) || 1e7,
    rapid: Number(rapid) || 10,
    unusualPct: Number(unusualPct) || 50,
    redFlags: redFlags || [],
    dup: { image_max_hamming: 6, geo_radius_m: 50, address_similarity: 0.6, price_similar_percent: 10, text_block: 0.95, text_warn: 0.85, ...(dup || {}) },
    split: split || { original: 50, requester: 50 },
    boosts: boosts || {},
    vsla: vsla || {},
    geoKm: Number(geoKm) || 5,
  };
}

// ------------------------------------------------------------------ helpers

const normText = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9ऀ-ॿ]+/g, ' ').trim();

function trigrams(s) {
  const t = `  ${normText(s)} `;
  const out = new Set();
  for (let i = 0; i < t.length - 2; i += 1) out.add(t.slice(i, i + 3));
  return out;
}
function trigramSimilarity(a, b) {
  if (!a || !b) return 0;
  const A = trigrams(a);
  const B = trigrams(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return inter / (A.size + B.size - inter || 1);
}
// Word 3-shingle Jaccard - "NLP text similarity" for title + description.
function shingles(s) {
  const w = normText(s).split(' ').filter(Boolean);
  const out = new Set();
  if (w.length < 3) {
    w.forEach((x) => out.add(x));
    return out;
  }
  for (let i = 0; i < w.length - 2; i += 1) out.add(`${w[i]} ${w[i + 1]} ${w[i + 2]}`);
  return out;
}
function textSimilarity(a, b) {
  const A = shingles(a);
  const B = shingles(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return inter / (A.size + B.size - inter);
}
function metres(a, b) {
  const R = 6371000;
  const toRad = (d) => (Number(d) * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
const inIndia = (lat, lng) => lat != null && lng != null && lat >= INDIA.latMin && lat <= INDIA.latMax && lng >= INDIA.lngMin && lng <= INDIA.lngMax;
const isPrivateIp = (ip) => !ip || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|::ffff:127\.|fc|fd|fe80)/i.test(String(ip).replace(/^::ffff:(?=\d)/, ''));

async function listerOf(p) {
  const id = p.broker_id || p.created_by;
  const r = await pool.query(
    `SELECT u.id, u.created_at, u.mobile_verified, u.status, r.name AS role,
            EXISTS (SELECT 1 FROM user_verifications v WHERE v.user_id = u.id AND v.kind = 'kyc' AND v.status = 'verified') AS kyc_verified
     FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`,
    [id]
  );
  return r.rows[0] || null;
}

async function notifyAdmins(title, message, propertyId) {
  const admins = await pool.query(`SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name IN ('admin', 'super_admin') AND u.status = 'active'`);
  for (const a of admins.rows) {
    await notificationService
      .createNotification({ userId: a.id, type: 'fraud_alert', title, message, relatedEntityType: 'property', relatedEntityId: propertyId })
      .catch(() => {});
  }
}

// ---------------------------------------------------------- duplicates (9.2)

async function findDuplicates(p, c) {
  const found = [];
  const push = (row) => {
    const key = `${row.original_id}|${row.layer}`;
    if (!found.some((f) => `${f.original_id}|${f.layer}` === key)) found.push(row);
  };
  const lister = p.broker_id || p.created_by;
  // Only earlier listings can be the "original" (first valid entry wins).
  // Listings that were themselves held / closed as duplicates never count as originals.
  const base = `o.id <> $1 AND o.status IN ('approved', 'pending_approval', 'inactive') AND o.created_at < $2
    AND (o.duplicate_status IS NULL OR o.duplicate_status = 'flagged')`;

  // Layer 1 - image fingerprints.
  const images = await pool.query(
    `SELECT DISTINCT ON (o.id) o.id, o.created_by, o.broker_id, bit_count((pm.phash # mine.phash)::bit(64))::int AS dist
     FROM property_media mine
     JOIN property_media pm ON pm.phash IS NOT NULL AND pm.property_id <> mine.property_id
       AND bit_count((pm.phash # mine.phash)::bit(64)) <= $3
     JOIN properties o ON o.id = pm.property_id
     WHERE mine.property_id = $1 AND mine.phash IS NOT NULL AND ${base}
     ORDER BY o.id, dist ASC`,
    [p.id, p.created_at, c.dup.image_max_hamming]
  );
  for (const r of images.rows) {
    const same = (r.broker_id || r.created_by) === lister;
    push({ original_id: r.id, layer: 'image', similarity: Math.round((1 - r.dist / 64) * 100), decision: same ? 'block' : 'flag', same_lister: same, detail: `Photo ${Math.round((1 - r.dist / 64) * 100)}% identical` });
  }

  // Candidates for geo / metadata / text: same city or within ~1 km.
  const params = [p.id, p.created_at, p.city];
  let near = '';
  if (p.latitude != null && p.longitude != null) {
    params.push(Number(p.latitude) - 0.01, Number(p.latitude) + 0.01, Number(p.longitude) - 0.01, Number(p.longitude) + 0.01);
    near = `OR (o.latitude BETWEEN $4 AND $5 AND o.longitude BETWEEN $6 AND $7)`;
  }
  const candidates = await pool.query(
    `SELECT o.id, o.title, o.description, o.address, o.locality, o.latitude, o.longitude, o.price_value, o.property_type,
            o.bedrooms, o.transaction_type, o.created_by, o.broker_id, o.created_at
     FROM properties o WHERE ${base} AND (o.city ILIKE $3 ${near})
     ORDER BY o.created_at DESC LIMIT 1000`,
    params
  );
  const myText = `${p.title} ${p.description || ''}`;
  for (const o of candidates.rows) {
    const same = (o.broker_id || o.created_by) === lister;
    const dist = p.latitude != null && o.latitude != null
      ? metres({ lat: Number(p.latitude), lng: Number(p.longitude) }, { lat: Number(o.latitude), lng: Number(o.longitude) })
      : null;
    const addrSim = p.address && o.address ? trigramSimilarity(p.address, o.address) : null;
    // Layer 2 - address / geo.
    const geoHit = dist != null && dist <= c.dup.geo_radius_m && (addrSim == null || addrSim >= c.dup.address_similarity);
    const addrHit = addrSim != null && addrSim >= 0.9;
    if (geoHit || addrHit) {
      push({ original_id: o.id, layer: 'geo', similarity: addrSim != null ? Math.round(addrSim * 100) : null, decision: 'flag', same_lister: same, detail: dist != null ? `${Math.round(dist)} m apart${addrSim != null ? `, address ${Math.round(addrSim * 100)}% similar` : ''}` : `Address ${Math.round(addrSim * 100)}% similar` });
      // Layer 3 - metadata: same address/spot + same type.
      const sameUnit = o.property_type === p.property_type && o.transaction_type === p.transaction_type && (o.bedrooms == null || p.bedrooms == null || o.bedrooms === p.bedrooms);
      if (sameUnit) {
        if (same) push({ original_id: o.id, layer: 'metadata', similarity: 100, decision: 'block', same_lister: true, detail: 'Same address and same lister' });
        else {
          const a = Number(p.price_value);
          const b = Number(o.price_value);
          if (a && b && Math.abs(a - b) / b <= c.dup.price_similar_percent / 100) {
            push({ original_id: o.id, layer: 'metadata', similarity: Math.round((1 - Math.abs(a - b) / b) * 100), decision: 'flag', same_lister: false, detail: 'Same address, different lister, similar price' });
          }
        }
      }
    }
    // Layer 4 - text similarity.
    const sim = textSimilarity(myText, `${o.title} ${o.description || ''}`);
    if (sim >= c.dup.text_warn) {
      push({ original_id: o.id, layer: 'text', similarity: Math.round(sim * 100), decision: sim > c.dup.text_block ? 'block' : 'flag', same_lister: same, detail: `Listing text ${Math.round(sim * 100)}% similar` });
    }
  }
  return found;
}

// ---------------------------------------------------------------- scoring

async function circleRateMedian(p) {
  const r = await pool.query(
    `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY cr.rate_per_sqft) AS median
     FROM circle_rates cr JOIN cities c ON c.id = cr.city_id
     LEFT JOIN localities l ON l.id = cr.locality_id
     WHERE LOWER(c.city_name) = LOWER($1)
       AND (cr.locality_id IS NULL OR LOWER(l.locality_name) = LOWER($2))
       AND (cr.property_type = 'any' OR cr.property_type = $3)
       AND cr.effective_from <= CURRENT_DATE AND (cr.effective_until IS NULL OR cr.effective_until >= CURRENT_DATE)`,
    [p.city, p.locality || '', p.property_type]
  );
  return r.rows[0]?.median != null ? Number(r.rows[0].median) : null;
}

async function computeFactors(p, c, duplicates) {
  const factors = [];
  const add = (key, detail) => {
    if (factors.some((f) => f.key === key)) return;
    factors.push({ key, points: Number(c.weights[key]) || 0, label: FACTOR_LABELS[key], detail });
  };
  const lister = await listerOf(p);
  const text = { title: p.title, description: p.description, about: p.about_extended };

  // Text: contact details, links, payment red flags.
  const violations = await findViolations(text, { blockContact: true });
  const contact = violations.filter((v) => ['phone', 'email', 'url', 'contact_phrase', 'mobile'].some((k) => String(v.rule).includes(k)));
  if (contact.length) add('contact_in_text', contact.map((v) => v.match).slice(0, 3).join(', '));
  if (violations.some((v) => /phone|mobile/.test(v.rule))) add('phone_visible', 'Phone number in listing text');
  if (violations.some((v) => /url|link/.test(v.rule)) || /wa\.me|whatsapp\.com|chat\.whatsapp/i.test(Object.values(text).join(' '))) add('url_link', 'Link in listing text');
  const joined = normText(Object.values(text).join(' '));
  const flag = (c.redFlags || []).find((f) => joined.includes(normText(f)));
  if (flag) add('suspicious_payment', `"${flag}"`);

  // Images: contact scan results.
  const media = await pool.query(`SELECT scan_status, scan_reasons, exif_lat, exif_lng FROM property_media WHERE property_id = $1`, [p.id]);
  const flaggedImg = media.rows.find((m) => m.scan_status && m.scan_status !== 'clean');
  if (flaggedImg && (flaggedImg.scan_reasons || []).some((r) => /phone|contact|visiting/i.test(r))) add('phone_visible', flaggedImg.scan_reasons.join('; '));

  // Duplicates.
  const imageDup = duplicates.filter((d) => d.layer === 'image');
  if (imageDup.some((d) => d.same_lister)) add('duplicate_images', 'Same photos as an earlier listing of yours');
  if (imageDup.some((d) => !d.same_lister)) {
    add('duplicate_images', 'Photos match another listing');
    add('stolen_content', 'Photos already used by a different lister');
  }
  const claims = duplicates.filter((d) => !d.same_lister && d.layer !== 'image');
  const anomalies = [];
  if (claims.length) anomalies.push('Another lister already listed this property');

  // Price vs circle rate (sale listings with area).
  if (p.transaction_type !== 'rent' && Number(p.price_value) > 0 && Number(p.area_sqft) > 0) {
    const median = await circleRateMedian(p);
    if (median) {
      const perSqft = Number(p.price_value) / Number(p.area_sqft);
      const dev = ((perSqft - median) / median) * 100;
      if (Math.abs(dev) >= c.unusualPct) add('unusual_price', `₹${Math.round(perSqft)}/sq.ft vs circle rate ₹${Math.round(median)} (${dev > 0 ? '+' : ''}${Math.round(dev)}%)`);
    }
  }

  if (lister) {
    const ageDays = (Date.now() - new Date(lister.created_at).getTime()) / 86400000;
    if (ageDays < c.newDays && !lister.kyc_verified && Number(p.price_value) > c.highValue) add('new_lister_high_value', `Account ${Math.floor(ageDays)} days old, KYC not verified`);
    if (!lister.mobile_verified) add('unverified_contact', 'Mobile number not verified');
    const [rapid, shared, negative, relist] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS n FROM properties WHERE (created_by = $1 OR broker_id = $1) AND created_at > now() - interval '24 hours'`, [lister.id]),
      pool.query(
        `SELECT COUNT(DISTINCT o.user_id)::int AS n FROM user_ips mine JOIN user_ips o ON o.ip = mine.ip AND o.user_id <> mine.user_id
         WHERE mine.user_id = $1 AND mine.last_seen > now() - interval '90 days'`,
        [lister.id]
      ),
      pool.query(`SELECT COUNT(*)::int AS n FROM reviews WHERE subject_user_id = $1 AND status = 'published' AND rating <= 2`, [lister.id]).catch(() => ({ rows: [{ n: 0 }] })),
      pool.query(
        `SELECT 1 FROM properties o WHERE o.id <> $1 AND (o.created_by = $2 OR o.broker_id = $2) AND o.status = 'rejected'
           AND o.updated_at > now() - interval '7 days' AND LOWER(o.title) = LOWER($3) LIMIT 1`,
        [p.id, lister.id, p.title]
      ),
    ]);
    if (rapid.rows[0].n >= c.rapid) add('rapid_listings', `${rapid.rows[0].n} listings in 24 hours`);
    if (shared.rows[0].n >= 2) add('shared_accounts', `${shared.rows[0].n} other accounts on the same network`);
    if (negative.rows[0].n >= 2) add('negative_reviews', `${negative.rows[0].n} reviews of 2 stars or less`);
    if (relist.rows.length) anomalies.push('Re-uploaded shortly after a rejection');
  }

  // Geo mismatch: photo GPS far from the listing location.
  if (p.latitude != null && p.longitude != null) {
    const far = media.rows.find((m) => m.exif_lat != null && metres({ lat: Number(p.latitude), lng: Number(p.longitude) }, { lat: Number(m.exif_lat), lng: Number(m.exif_lng) }) > c.geoKm * 1000);
    if (far) anomalies.push(`Photo location is more than ${c.geoKm} km from the listing`);
  }
  if (anomalies.length) add('behaviour_anomaly', anomalies.join('; '));

  const score = Math.min(100, factors.reduce((s, f) => s + f.points, 0));
  const band = score >= c.bands.critical ? 'critical' : score >= c.bands.red ? 'red' : score >= c.bands.yellow ? 'yellow' : 'green';
  return { score, band, factors, lister };
}

// L1 System Verified checks (sec. 9.1).
async function systemChecks(p, duplicates, c) {
  const images = await pool.query(`SELECT COUNT(*)::int AS n FROM property_media WHERE property_id = $1 AND media_type = 'image' AND COALESCE(scan_status, 'clean') <> 'blocked'`, [p.id]);
  const violations = await findViolations({ title: p.title, description: p.description }, { blockContact: true });
  const spam = violations.length > 0 || (c.redFlags || []).some((f) => normText(`${p.title} ${p.description || ''}`).includes(normText(f)));
  const checks = {
    min_3_images: images.rows[0].n >= 3,
    mandatory_fields: !!(p.title && p.property_type && p.transaction_type && Number(p.price_value) > 0 && p.city && p.locality && (p.area_sqft || p.bedrooms)),
    geo_in_india: inIndia(Number(p.latitude), Number(p.longitude)),
    no_duplicate: !duplicates.some((d) => d.decision === 'block'),
    no_spam: !spam,
  };
  return { passed: Object.values(checks).every(Boolean), checks, images: images.rows[0].n };
}

async function setLevel(propertyId) {
  const r = await pool.query(`SELECT COALESCE(MAX(level), 0)::int AS lvl FROM property_verifications WHERE property_id = $1 AND status = 'verified'`, [propertyId]);
  const lvl = r.rows[0].lvl;
  await pool.query(`UPDATE properties SET verification_level = $1::smallint, is_verified = (is_verified OR $1::smallint >= 2) WHERE id = $2`, [lvl, propertyId]);
  return lvl;
}

// ------------------------------------------------------------- assessment

// Assess a listing and apply the band / duplicate action. `trigger`:
// create | update | media | manual. Returns the assessment summary.
async function assess(propertyId, { trigger = 'manual', actor = null } = {}) {
  const c = await cfg();
  const p = (await pool.query('SELECT * FROM properties WHERE id = $1', [propertyId])).rows[0];
  if (!p) throw notFound('Listing not found');
  const duplicates = await findDuplicates(p, c);
  const { score, band, factors, lister } = await computeFactors(p, c, duplicates);

  // Record duplicate findings.
  for (const d of duplicates) {
    await pool.query(
      `INSERT INTO duplicate_matches (property_id, original_id, layer, similarity, decision, same_lister, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (property_id, original_id, layer) DO UPDATE SET similarity = EXCLUDED.similarity, decision = EXCLUDED.decision, detail = EXCLUDED.detail`,
      [p.id, d.original_id, d.layer, d.similarity, d.decision, d.same_lister, d.detail]
    );
  }
  const blocking = duplicates.find((d) => d.decision === 'block');
  const flaggedDup = duplicates.find((d) => d.decision === 'flag');

  // L1 System Verified.
  const l1 = await systemChecks(p, duplicates, c);
  await pool.query(
    `INSERT INTO property_verifications (property_id, level, status, checks, auto_requested, decided_at)
     VALUES ($1, 1, $2, $3, true, now())
     ON CONFLICT (property_id, level) DO UPDATE SET status = EXCLUDED.status, checks = EXCLUDED.checks, decided_at = now()`,
    [p.id, l1.passed ? 'verified' : 'rejected', JSON.stringify(l1.checks)]
  );
  // L3 Legally Verified auto-requested for high-value sales.
  if (p.transaction_type !== 'rent' && Number(p.price_value) > c.highValue) {
    await pool.query(
      `INSERT INTO property_verifications (property_id, level, status, auto_requested, due_at)
       VALUES ($1, 3, 'requested', true, now() + ($2 || ' hours')::interval) ON CONFLICT (property_id, level) DO NOTHING`,
      [p.id, String(c.vsla['3'] || 72)]
    );
  }
  const level = await setLevel(p.id);

  // Actions - residential listings from non-admin listers only.
  const managed = p.listing_category === 'residential' && lister && !ADMIN.includes(lister.role) && trigger !== 'manual_readonly';
  let action = 'none';
  let status = p.status;
  if (managed && p.status !== 'rejected' && p.status !== 'inactive') {
    // Critical outranks everything; then a blocking duplicate; then Red.
    if (band === 'critical') {
      action = 'auto_rejected';
      status = 'rejected';
      await pool.query(
        `UPDATE properties SET status = 'rejected', under_review = false,
           rejection_reason = $1 WHERE id = $2`,
        [`Automatically rejected by fraud checks (risk ${score}/100): ${factors.map((f) => f.label).join('; ')}. You can appeal with evidence.`, p.id]
      );
      await pool.query(`INSERT INTO user_flags (user_id, reason, property_id, detail) VALUES ($1, 'critical_listing', $2, $3)`, [lister.id, p.id, JSON.stringify({ score, factors })]);
      await notificationService.createNotification({
        userId: lister.id,
        type: 'listing_rejected',
        title: 'Listing rejected by fraud checks',
        message: `"${p.title}" scored ${score}/100 on our fraud checks and was not published. You can appeal with evidence from My Listings.`,
        relatedEntityType: 'property',
        relatedEntityId: p.id,
      });
      await notifyAdmins('Critical listing auto-rejected', `"${p.title}" - risk ${score}/100: ${factors.map((f) => f.label).join('; ')}`, p.id);
      const repeat = await pool.query(`SELECT COUNT(*)::int AS n FROM user_flags WHERE user_id = $1 AND reason = 'critical_listing' AND created_at > now() - interval '90 days'`, [lister.id]);
      if (repeat.rows[0].n >= c.suspendAfter && lister.status === 'active') {
        await pool.query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [lister.id]);
        await pool.query(`INSERT INTO user_flags (user_id, reason, detail) VALUES ($1, 'suspended_repeat_rejections', $2)`, [lister.id, JSON.stringify({ rejections: repeat.rows[0].n })]);
        await notifyAdmins('Account suspended for repeat fraud rejections', `A lister had ${repeat.rows[0].n} critical rejections in 90 days and was suspended.`, p.id);
        action = 'auto_rejected_and_suspended';
      }
    } else if (blocking) {
      action = 'duplicate_hold';
      status = 'pending_approval';
      await pool.query(
        `UPDATE properties SET status = 'pending_approval', duplicate_of = $1, duplicate_status = 'blocked', under_review = false WHERE id = $2`,
        [blocking.original_id, p.id]
      );
      if (p.duplicate_status !== 'blocked') {
        await notificationService.createNotification({
          userId: lister.id,
          type: 'duplicate_listing',
          title: 'This property is already listed',
          message: `"${p.title}" matches an earlier listing (${blocking.detail}). Choose: request mandate-verification routing with the original lister, update the existing listing, or cancel.`,
          relatedEntityType: 'property',
          relatedEntityId: p.id,
        });
      }
    } else if (band === 'red') {
      action = 'held';
      status = 'pending_approval';
      await pool.query(
        `UPDATE properties SET status = 'pending_approval', under_review = true,
           review_due_at = COALESCE(review_due_at, now() + ($1 || ' hours')::interval) WHERE id = $2`,
        [String(c.sla.red), p.id]
      );
      if (p.fraud_band !== 'red') {
        await notificationService.createNotification({
          userId: lister.id,
          type: 'listing_held',
          title: 'Listing held for review',
          message: `"${p.title}" needs a manual check (within ${c.sla.red} hours). An A R Buildwel representative will contact you - please keep ownership documents ready.`,
          relatedEntityType: 'property',
          relatedEntityId: p.id,
        });
        await notifyAdmins('Listing held (Red risk)', `"${p.title}" - risk ${score}/100: ${factors.map((f) => f.label).join('; ')}`, p.id);
      }
    } else {
      // Green / Yellow go live (auto-approval); Yellow carries the banner.
      const yellow = band === 'yellow' || !!flaggedDup;
      await pool.query(
        `UPDATE properties SET under_review = $1,
           review_due_at = CASE WHEN $1 THEN COALESCE(review_due_at, now() + ($2 || ' hours')::interval) ELSE NULL END,
           duplicate_status = CASE WHEN $3 THEN 'flagged' ELSE duplicate_status END,
           duplicate_of = CASE WHEN $3 THEN $4::uuid ELSE duplicate_of END
         WHERE id = $5`,
        [yellow, String(c.sla.yellow), !!flaggedDup, flaggedDup?.original_id || null, p.id]
      );
      if (p.status === 'pending_approval' && c.autoApprove && !(p.duplicate_status === 'blocked')) {
        action = yellow ? 'approved_under_review' : 'auto_approved';
        status = 'approved';
        const system = await require('./opportunity.service').getSystemUser();
        await require('./property.service').approveProperty(p.id, system);
      } else {
        action = yellow ? 'under_review' : 'cleared';
      }
    }
  }

  await pool.query(
    `UPDATE properties SET fraud_score = $1, fraud_band = $2, fraud_factors = $3, fraud_assessed_at = now() WHERE id = $4`,
    [score, band, JSON.stringify(factors), p.id]
  );
  await pool.query(
    `INSERT INTO fraud_assessments (property_id, score, band, factors, action, trigger) VALUES ($1, $2, $3, $4, $5, $6)`,
    [p.id, score, band, JSON.stringify(factors), action, trigger]
  );
  if (lister) require('./trust.service').safeRecompute(lister.id, 'listing_assessed');
  void actor;
  return { score, band, factors, action, status, duplicates, verificationLevel: level, systemChecks: l1.checks };
}

function safeAssess(propertyId, trigger) {
  return assess(propertyId, { trigger }).catch((err) => {
    console.error(`[fraud] assess ${propertyId} failed:`, err.message);
    return null;
  });
}

// ------------------------------------------------------ media intelligence

// Called before an upload is stored: reject images with contact details.
async function screenUpload(buffer) {
  const analysis = await require('./imageScan.service').analyse(buffer);
  if (analysis.scan.status === 'blocked') {
    const err = new Error(`Image rejected: ${analysis.scan.reasons.join('; ')}. Contact details are never shown on listings.`);
    err.statusCode = 422;
    throw err;
  }
  return analysis;
}

async function saveMediaAnalysis(mediaId, a) {
  await pool.query(
    `UPDATE property_media SET phash = $1, width = $2, height = $3, exif_lat = $4, exif_lng = $5, exif_taken_at = $6,
       scan_status = $7, scan_reasons = $8 WHERE id = $9`,
    [a.phash, a.width, a.height, a.exif?.lat ?? null, a.exif?.lng ?? null, a.exif?.takenAt ?? null, a.scan.status, JSON.stringify(a.scan.reasons || []), mediaId]
  );
}

// External image URLs (added by link): fetch and analyse in the background.
async function analyseRemoteMedia(mediaId, url) {
  try {
    if (!/^https?:\/\//i.test(url)) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 15 * 1024 * 1024) return;
    const a = await require('./imageScan.service').analyse(buf);
    await saveMediaAnalysis(mediaId, a);
  } catch (err) {
    console.error(`[fraud] remote media ${mediaId}:`, err.message);
  }
}

// ------------------------------------------------- verification levels (9.1)

async function ownListing(user, propertyId) {
  const p = (await pool.query('SELECT * FROM properties WHERE id = $1', [propertyId])).rows[0];
  if (!p) throw notFound('Listing not found');
  if (!STAFF.includes(user.role) && p.created_by !== user.id && p.broker_id !== user.id) throw forbidden('Not your listing');
  return p;
}

async function requestVerification(user, propertyId, level, { note, evidence = [] } = {}, meta = {}) {
  if (![2, 3, 4].includes(level)) throw badRequest('Levels 2 (Seller), 3 (Legal) and 4 (Site) can be requested');
  const p = await ownListing(user, propertyId);
  if (p.status !== 'approved') throw badRequest('Verification is available for live listings');
  const c = await cfg();
  const r = await pool.query(
    `INSERT INTO property_verifications (property_id, level, status, notes, evidence, requested_by, due_at)
     VALUES ($1, $2, 'requested', $3, $4, $5, now() + ($6 || ' hours')::interval)
     ON CONFLICT (property_id, level) DO UPDATE SET
       status = CASE WHEN property_verifications.status = 'verified' THEN 'verified' ELSE 'requested' END,
       evidence = property_verifications.evidence || EXCLUDED.evidence,
       notes = COALESCE(EXCLUDED.notes, property_verifications.notes), requested_by = EXCLUDED.requested_by,
       due_at = EXCLUDED.due_at, requested_at = now()
     RETURNING *`,
    [propertyId, level, note || null, JSON.stringify(evidence), user.id, String(c.vsla[String(level)] || 48)]
  );
  await auditService.log({ actor: user, action: 'listing.verification_requested', entityType: 'property', entityId: propertyId, after: { level }, ...meta });
  return r.rows[0];
}

async function listVerifications(propertyId) {
  const r = await pool.query(
    `SELECT v.*, u.full_name AS decided_by_name FROM property_verifications v LEFT JOIN users u ON u.id = v.decided_by
     WHERE v.property_id = $1 ORDER BY v.level`,
    [propertyId]
  );
  return r.rows.map((v) => ({ ...v, name: LEVEL_NAMES[v.level], requiredChecks: LEVEL_CHECKS[v.level] || [] }));
}

async function decideVerification(user, propertyId, level, { status, checks = {}, notes, evidence = [] }, meta = {}) {
  if (![2, 3, 4].includes(level)) throw badRequest('Levels 2-4 are decided by A R staff (level 1 is automatic)');
  const p = (await pool.query('SELECT p.*, u.id AS lister FROM properties p LEFT JOIN users u ON u.id = COALESCE(p.broker_id, p.created_by) WHERE p.id = $1', [propertyId])).rows[0];
  if (!p) throw notFound('Listing not found');
  if (level === 2) {
    const kyc = await pool.query(`SELECT 1 FROM user_verifications WHERE user_id = $1 AND kind = 'kyc' AND status = 'verified'`, [p.lister]);
    checks.id_verified = checks.id_verified ?? kyc.rows.length > 0;
  }
  const required = LEVEL_CHECKS[level];
  if (status === 'verified') {
    const missing = required.filter((k) => !checks[k]);
    if (missing.length) throw badRequest(`All checks must pass to verify: ${missing.join(', ')}`);
  }
  if (status === 'rejected' && !notes) throw badRequest('A reason is required to reject');
  const r = await pool.query(
    `INSERT INTO property_verifications (property_id, level, status, checks, notes, evidence, decided_by, decided_at)
     VALUES ($1, $2, $3::varchar, $4, $5, $6, $7, CASE WHEN $3::varchar IN ('verified', 'rejected') THEN now() END)
     ON CONFLICT (property_id, level) DO UPDATE SET status = EXCLUDED.status, checks = EXCLUDED.checks,
       notes = COALESCE(EXCLUDED.notes, property_verifications.notes),
       evidence = property_verifications.evidence || EXCLUDED.evidence, decided_by = EXCLUDED.decided_by, decided_at = EXCLUDED.decided_at
     RETURNING *`,
    [propertyId, level, status, JSON.stringify(checks), notes || null, JSON.stringify(evidence), user.id]
  );
  const lvl = await setLevel(propertyId);
  await auditService.log({ actor: user, action: `listing.verification_${status}`, entityType: 'property', entityId: propertyId, after: { level, checks, notes }, ...meta });
  if (['verified', 'rejected'].includes(status) && p.lister) {
    await notificationService.createNotification({
      userId: p.lister,
      type: 'listing_verification',
      title: status === 'verified' ? `${LEVEL_NAMES[level]}: ${p.title}` : `${LEVEL_NAMES[level]} not granted`,
      message: status === 'verified' ? `Your listing now carries the ${LEVEL_NAMES[level]} badge and ranks higher in search.` : notes,
      relatedEntityType: 'property',
      relatedEntityId: propertyId,
    });
  }
  require('./matchEngine.service').safeRefreshProperty(propertyId);
  return { ...r.rows[0], verificationLevel: lvl };
}

// ------------------------------------------------ duplicate resolution (9.3)

async function resolveDuplicate(user, propertyId, action, { note } = {}, meta = {}) {
  const p = await ownListing(user, propertyId);
  if (p.duplicate_status !== 'blocked' || !p.duplicate_of) throw badRequest('This listing is not held as a duplicate');
  const original = (await pool.query('SELECT * FROM properties WHERE id = $1', [p.duplicate_of])).rows[0];
  if (!original) throw notFound('Original listing not found');
  const originalLister = original.broker_id || original.created_by;
  const me = p.broker_id || p.created_by;
  let result;
  if (action === 'request_routing') {
    if (originalLister === me) throw badRequest('You listed the original - update it or cancel this one');
    const c = await cfg();
    result = (
      await pool.query(
        `INSERT INTO duplicate_routing_requests (property_id, original_id, requester_id, original_lister_id, split, note)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [p.id, original.id, me, originalLister, JSON.stringify(c.split), note || null]
      )
    ).rows[0];
    await notificationService.createNotification({
      userId: originalLister,
      type: 'routing_request',
      title: 'Mandate-verification routing request',
      message: `Another broker also has "${original.title}". Accept to work it together as routed partners (${c.split.original}/${c.split.requester} split).`,
      relatedEntityType: 'property',
      relatedEntityId: original.id,
    });
  } else if (action === 'update_existing') {
    if (originalLister === me) {
      const fields = ['title', 'description', 'price', 'price_value', 'area_sqft', 'bedrooms', 'bathrooms', 'amenities', 'furnishing', 'possession_status'];
      const set = fields.map((f, i) => `${f} = COALESCE($${i + 1}, ${f})`).join(', ');
      await pool.query(`UPDATE properties SET ${set} WHERE id = $${fields.length + 1}`, [...fields.map((f) => (f === 'amenities' ? JSON.stringify(p[f]) : p[f])), original.id]);
      // The updated original goes back through the checks (Green / Yellow re-publish).
      if (original.status === 'approved') await pool.query(`UPDATE properties SET status = 'pending_approval' WHERE id = $1`, [original.id]);
      await pool.query(`UPDATE properties SET status = 'inactive', duplicate_status = 'resolved' WHERE id = $1`, [p.id]);
      await assess(original.id, { trigger: 'update' });
      result = { merged: true, originalId: original.id };
    } else {
      // Newer info from a different lister goes to A R staff for the original.
      await notifyAdmins('Update suggested for an existing listing', `A second lister has newer information for "${original.title}". Review listing ${p.id} against the original.`, original.id);
      result = { suggested: true, originalId: original.id };
    }
    await pool.query(`UPDATE properties SET status = 'inactive', duplicate_status = 'resolved' WHERE id = $1`, [p.id]);
  } else if (action === 'cancel') {
    await pool.query(`UPDATE properties SET status = 'inactive', duplicate_status = 'resolved' WHERE id = $1`, [p.id]);
    result = { cancelled: true };
  } else {
    throw badRequest('action must be request_routing, update_existing or cancel');
  }
  if (action !== 'request_routing') {
    await pool.query(`UPDATE duplicate_matches SET status = 'resolved', resolution = $1, resolved_by = $2, resolved_at = now() WHERE property_id = $3 AND status = 'open'`, [action, user.id, p.id]);
  }
  await auditService.log({ actor: user, action: `listing.duplicate_${action}`, entityType: 'property', entityId: p.id, after: { originalId: original.id }, ...meta });
  return result;
}

async function listRoutingRequests(user) {
  const r = await pool.query(
    `SELECT rr.*, p.title AS property_title, o.title AS original_title, ur.full_name AS requester_name, uo.full_name AS original_lister_name
     FROM duplicate_routing_requests rr JOIN properties p ON p.id = rr.property_id JOIN properties o ON o.id = rr.original_id
     JOIN users ur ON ur.id = rr.requester_id JOIN users uo ON uo.id = rr.original_lister_id
     WHERE rr.requester_id = $1 OR rr.original_lister_id = $1 OR $2 ORDER BY rr.created_at DESC LIMIT 200`,
    [user.id, STAFF.includes(user.role)]
  );
  return r.rows;
}

async function respondRouting(user, requestId, action, meta = {}) {
  const rr = (await pool.query(`SELECT * FROM duplicate_routing_requests WHERE id = $1`, [requestId])).rows[0];
  if (!rr) throw notFound('Request not found');
  if (rr.original_lister_id !== user.id && !ADMIN.includes(user.role)) throw forbidden('Only the original lister can answer');
  if (rr.status !== 'pending') throw badRequest('Already answered');
  const status = action === 'accept' ? 'accepted' : 'declined';
  await pool.query(`UPDATE duplicate_routing_requests SET status = $1, responded_at = now() WHERE id = $2`, [status, requestId]);
  if (status === 'accepted') {
    const split = rr.split || {};
    await pool.query(
      `INSERT INTO property_partners (property_id, partner_user_id, split_percent) VALUES ($1, $2, $3), ($1, $4, $5)
       ON CONFLICT (property_id, partner_user_id) DO UPDATE SET split_percent = EXCLUDED.split_percent`,
      [rr.original_id, rr.original_lister_id, Number(split.original) || 50, rr.requester_id, Number(split.requester) || 50]
    );
    await pool.query(`UPDATE properties SET status = 'inactive', duplicate_status = 'resolved' WHERE id = $1`, [rr.property_id]);
    await pool.query(`UPDATE duplicate_matches SET status = 'resolved', resolution = 'routing_accepted', resolved_by = $1, resolved_at = now() WHERE property_id = $2 AND status = 'open'`, [user.id, rr.property_id]);
  } else {
    await pool.query(`UPDATE properties SET status = 'rejected', duplicate_status = 'resolved', rejection_reason = 'Duplicate of an existing listing - routing declined by the original lister' WHERE id = $1`, [rr.property_id]);
    await pool.query(`UPDATE duplicate_matches SET status = 'resolved', resolution = 'routing_declined', resolved_by = $1, resolved_at = now() WHERE property_id = $2 AND status = 'open'`, [user.id, rr.property_id]);
  }
  await notificationService.createNotification({
    userId: rr.requester_id,
    type: 'routing_response',
    title: `Routing request ${status}`,
    message: status === 'accepted' ? 'You are now a routed partner broker on the original listing.' : 'The original lister declined; your duplicate listing was closed.',
    relatedEntityType: 'property',
    relatedEntityId: rr.original_id,
  });
  await auditService.log({ actor: user, action: `listing.routing_${status}`, entityType: 'property', entityId: rr.original_id, after: { requestId }, ...meta });
  return { ...rr, status };
}

// ------------------------------------------------------------ appeals (9.5)

async function appeal(user, propertyId, reason, evidence = [], meta = {}) {
  const p = await ownListing(user, propertyId);
  if (!(p.status === 'rejected' && p.fraud_band === 'critical') && p.duplicate_status !== 'blocked') {
    throw badRequest('Appeals are for listings auto-rejected by fraud checks or held as duplicates');
  }
  const open = await pool.query(`SELECT 1 FROM listing_appeals WHERE property_id = $1 AND status = 'pending'`, [propertyId]);
  if (open.rows.length) throw badRequest('An appeal is already pending');
  const r = await pool.query(
    `INSERT INTO listing_appeals (property_id, user_id, reason, evidence) VALUES ($1, $2, $3, $4) RETURNING *`,
    [propertyId, user.id, reason, JSON.stringify(evidence)]
  );
  await notifyAdmins('Listing appeal submitted', `"${p.title}": ${reason.slice(0, 160)}`, propertyId);
  await auditService.log({ actor: user, action: 'listing.appealed', entityType: 'property', entityId: propertyId, ...meta });
  return r.rows[0];
}

async function decideAppeal(user, appealId, decision, note, meta = {}) {
  const a = (await pool.query(`SELECT * FROM listing_appeals WHERE id = $1`, [appealId])).rows[0];
  if (!a) throw notFound('Appeal not found');
  if (a.status !== 'pending') throw badRequest('Already decided');
  const status = decision === 'uphold' ? 'upheld' : 'dismissed';
  await pool.query(`UPDATE listing_appeals SET status = $1, decision_note = $2, decided_by = $3, decided_at = now() WHERE id = $4`, [status, note || null, user.id, appealId]);
  if (status === 'upheld') {
    await pool.query(`UPDATE properties SET duplicate_status = CASE WHEN duplicate_status = 'blocked' THEN 'resolved' ELSE duplicate_status END, under_review = false WHERE id = $1`, [a.property_id]);
    await require('./property.service').approveProperty(a.property_id, user);
    await pool.query(`UPDATE user_flags SET resolved_at = now(), resolved_by = $1 WHERE property_id = $2 AND resolved_at IS NULL`, [user.id, a.property_id]);
  }
  await notificationService.createNotification({
    userId: a.user_id,
    type: 'appeal_decided',
    title: `Appeal ${status}`,
    message: status === 'upheld' ? 'Your listing has been reinstated.' : `Your appeal was not upheld${note ? `: ${note}` : '.'}`,
    relatedEntityType: 'property',
    relatedEntityId: a.property_id,
  });
  await auditService.log({ actor: user, action: `listing.appeal_${status}`, entityType: 'property', entityId: a.property_id, after: { note }, ...meta });
  return { ...a, status };
}

// ------------------------------------------------------------ staff queue

async function queue() {
  const [listings, verifications, appeals, flags, duplicates] = await Promise.all([
    pool.query(
      `SELECT p.id, p.title, p.city, p.locality, p.status, p.price, p.price_value, p.fraud_score, p.fraud_band, p.fraud_factors,
              p.under_review, p.review_due_at, p.duplicate_status, p.duplicate_of, p.verification_level, p.created_at,
              u.full_name AS lister_name, r.name AS lister_role
       FROM properties p LEFT JOIN users u ON u.id = COALESCE(p.broker_id, p.created_by) LEFT JOIN roles r ON r.id = u.role_id
       WHERE (p.under_review AND p.status IN ('approved', 'pending_approval'))
          OR (p.duplicate_status = 'blocked' AND p.status = 'pending_approval')
          OR (p.fraud_band = 'critical' AND p.updated_at > now() - interval '30 days')
       ORDER BY p.review_due_at ASC NULLS LAST, p.fraud_score DESC NULLS LAST LIMIT 200`
    ),
    pool.query(
      `SELECT v.*, p.title, p.city, p.price_value FROM property_verifications v JOIN properties p ON p.id = v.property_id
       WHERE v.level >= 2 AND v.status IN ('requested', 'in_progress') ORDER BY v.due_at ASC NULLS LAST LIMIT 200`
    ),
    pool.query(
      `SELECT a.*, p.title, p.fraud_score, p.fraud_factors, u.full_name AS user_name FROM listing_appeals a
       JOIN properties p ON p.id = a.property_id JOIN users u ON u.id = a.user_id WHERE a.status = 'pending' ORDER BY a.created_at`
    ),
    pool.query(
      `SELECT f.*, u.full_name, u.status AS user_status FROM user_flags f JOIN users u ON u.id = f.user_id
       WHERE f.resolved_at IS NULL ORDER BY f.created_at DESC LIMIT 100`
    ),
    pool.query(
      `SELECT d.*, p.title, o.title AS original_title FROM duplicate_matches d JOIN properties p ON p.id = d.property_id
       JOIN properties o ON o.id = d.original_id WHERE d.status = 'open' ORDER BY d.created_at DESC LIMIT 200`
    ),
  ]);
  const now = Date.now();
  return {
    listings: listings.rows.map((l) => ({ ...l, overdue: l.review_due_at ? new Date(l.review_due_at).getTime() < now : false })),
    verifications: verifications.rows.map((v) => ({ ...v, name: LEVEL_NAMES[v.level], requiredChecks: LEVEL_CHECKS[v.level] })),
    appeals: appeals.rows,
    flags: flags.rows,
    duplicates: duplicates.rows,
  };
}

// Staff decision on a listing in the review queue.
async function review(user, propertyId, action, note, meta = {}) {
  const p = (await pool.query('SELECT * FROM properties WHERE id = $1', [propertyId])).rows[0];
  if (!p) throw notFound('Listing not found');
  if (action === 'clear') {
    await pool.query(`UPDATE properties SET under_review = false, review_due_at = NULL WHERE id = $1`, [propertyId]);
    if (p.status === 'pending_approval') await require('./property.service').approveProperty(propertyId, user);
    await pool.query(`UPDATE duplicate_matches SET status = 'dismissed', resolved_by = $1, resolved_at = now() WHERE property_id = $2 AND status = 'open' AND decision = 'flag'`, [user.id, propertyId]);
  } else if (action === 'hold') {
    await pool.query(`UPDATE properties SET status = 'pending_approval', under_review = true WHERE id = $1`, [propertyId]);
  } else if (action === 'reject') {
    if (!note) throw badRequest('A reason is required to reject');
    await pool.query(`UPDATE properties SET status = 'rejected', under_review = false, rejection_reason = $1 WHERE id = $2`, [note, propertyId]);
  } else if (action === 'contacted') {
    // A R has contacted the lister (red band) - logged only.
  } else {
    throw badRequest('action must be clear, hold, reject or contacted');
  }
  await auditService.log({ actor: user, action: `listing.review_${action}`, entityType: 'property', entityId: propertyId, after: { note }, ...meta });
  return (await pool.query('SELECT id, status, under_review, fraud_band, fraud_score FROM properties WHERE id = $1', [propertyId])).rows[0];
}

async function resolveFlag(user, flagId, meta = {}) {
  const f = (await pool.query(`UPDATE user_flags SET resolved_at = now(), resolved_by = $1 WHERE id = $2 AND resolved_at IS NULL RETURNING *`, [user.id, flagId])).rows[0];
  if (!f) throw notFound('Flag not found');
  await auditService.log({ actor: user, action: 'user_flag.resolved', entityType: 'user', entityId: f.user_id, ...meta });
  return f;
}

// Lister-facing summary for a listing (my listings / CRM detail).
async function listingSummary(user, propertyId) {
  const p = await ownListing(user, propertyId);
  const staff = STAFF.includes(user.role);
  const [verifications, appeals, matches, routing] = await Promise.all([
    listVerifications(propertyId),
    pool.query(`SELECT id, reason, status, decision_note, created_at, decided_at FROM listing_appeals WHERE property_id = $1 ORDER BY created_at DESC`, [propertyId]),
    pool.query(
      `SELECT d.layer, d.similarity, d.decision, d.detail, d.status, d.original_id, o.title AS original_title
       FROM duplicate_matches d JOIN properties o ON o.id = d.original_id WHERE d.property_id = $1 ORDER BY d.created_at`,
      [propertyId]
    ),
    pool.query(`SELECT id, status, created_at, responded_at FROM duplicate_routing_requests WHERE property_id = $1 ORDER BY created_at DESC`, [propertyId]),
  ]);
  return {
    id: p.id,
    status: p.status,
    verificationLevel: p.verification_level,
    verificationName: LEVEL_NAMES[p.verification_level] || null,
    underReview: p.under_review,
    duplicateStatus: p.duplicate_status,
    fraud: staff ? { score: p.fraud_score, band: p.fraud_band, factors: p.fraud_factors, assessedAt: p.fraud_assessed_at } : { band: p.fraud_band },
    verifications,
    appeals: appeals.rows,
    duplicates: matches.rows.map((m) => (staff ? m : { layer: m.layer, decision: m.decision, detail: m.detail, status: m.status })),
    routing: routing.rows,
  };
}

async function recordIp(userId, ip) {
  if (!userId || isPrivateIp(ip)) return;
  await pool
    .query(
      `INSERT INTO user_ips (user_id, ip) VALUES ($1, $2) ON CONFLICT (user_id, ip) DO UPDATE SET last_seen = now()`,
      [userId, String(ip).replace(/^::ffff:/, '').slice(0, 64)]
    )
    .catch(() => {});
}

module.exports = {
  FACTOR_LABELS,
  LEVEL_NAMES,
  LEVEL_CHECKS,
  assess,
  safeAssess,
  screenUpload,
  saveMediaAnalysis,
  analyseRemoteMedia,
  requestVerification,
  listVerifications,
  decideVerification,
  resolveDuplicate,
  listRoutingRequests,
  respondRouting,
  appeal,
  decideAppeal,
  queue,
  review,
  resolveFlag,
  listingSummary,
  recordIp,
  textSimilarity,
  trigramSimilarity,
};
