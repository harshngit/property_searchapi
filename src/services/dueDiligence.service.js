const Anthropic = require('@anthropic-ai/sdk');
const pool = require('../config/db');
const configService = require('./config.service');
const auditService = require('./audit.service');
const disclaimerService = require('./disclaimer.service');
const { signUrls } = require('../utils/storage');
const { badRequest, forbidden, notFound } = require('../utils/httpError');

// Engine 5 - Due Diligence Engine (Module 21) on top of the Document
// Repository (Module 20).
//   - Every document is classified (rule-based keywords always; an AI layer
//     when ANTHROPIC_API_KEY is set) and scanned for risk: mortgages /
//     charges, litigation, compliance notices, possession issues,
//     unsigned / expired / inconsistent papers.
//   - Each listing gets a checklist for its transaction (resale, under
//     construction, plot, rent, loan, NRI owner) with missing required
//     documents detected automatically.
//   - Ownership chain (basic): transfers from deeds (+ staff-entered links)
//     ordered by date, years covered and gaps; encumbrance status;
//     possession risk; NRI considerations (non-advisory, disclaimered).
//   - Role visibility: owner / broker / buyer / admin each see only the
//     documents shared with their role.

const AI_MODEL = 'claude-sonnet-5';
const aiClient = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;
const STAFF = ['internal_sales', 'admin', 'super_admin'];
const TRANSFER_TYPES = ['sale_deed', 'title_document'];

const TYPE_KEYWORDS = {
  sale_deed: ['sale deed', 'deed of sale', 'conveyance deed', 'absolute sale', 'deed of conveyance'],
  agreement_to_sell: ['agreement to sell', 'agreement for sale', 'builder buyer agreement', 'builder-buyer agreement'],
  encumbrance_certificate: ['encumbrance certificate', 'nil encumbrance', 'form no. 15', 'form no. 16', 'statement of encumbrances'],
  tax_receipt: ['property tax', 'house tax', 'municipal tax', 'tax receipt', 'assessment year'],
  id_proof: ['income tax department', 'permanent account number', 'aadhaar', 'unique identification authority', 'republic of india passport', 'election commission'],
  allotment_letter: ['allotment letter', 'letter of allotment'],
  occupancy_certificate: ['occupancy certificate', 'occupation certificate'],
  completion_certificate: ['completion certificate'],
  approved_plan: ['sanctioned plan', 'building plan approval', 'approved plan', 'sanction of building plan'],
  mutation_record: ['mutation', 'khata', 'jamabandi', 'record of rights', '7/12 extract', 'patta'],
  society_noc: ['society', 'resident welfare association', 'rwa'],
  bank_noc: ['loan closure', 'no dues certificate', 'loan account closed', 'release of charge'],
  power_of_attorney: ['power of attorney'],
  possession_letter: ['possession letter', 'handed over possession', 'handover of possession'],
  rent_agreement: ['rent agreement', 'leave and license', 'lease deed', 'tenancy agreement'],
  utility_bill: ['electricity bill', 'water bill', 'consumer number', 'units consumed'],
  rera_certificate: ['real estate regulatory authority', 'rera registration', 'registration certificate of project'],
  title_document: ['gift deed', 'partition deed', 'title deed', 'relinquishment deed', 'release deed', 'last will', 'succession certificate'],
  noc: ['no objection certificate', ' noc '],
};

const DATE_RE = /\b(\d{1,2})[./-](\d{1,2})[./-]((?:19|20)\d{2})\b|\b((?:19|20)\d{2})[./-](\d{1,2})[./-](\d{1,2})\b/g;

function extractDates(text) {
  const out = [];
  for (const m of String(text).matchAll(DATE_RE)) {
    const [d, mo, y] = m[1] ? [m[1], m[2], m[3]] : [m[6], m[5], m[4]];
    const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
    if (!Number.isNaN(date.getTime()) && Number(mo) <= 12 && Number(d) <= 31 && date <= new Date()) out.push(date.toISOString().slice(0, 10));
  }
  return [...new Set(out)].sort();
}

// Fallback PDF text reader for files pdf.js rejects: pulls the string
// operands of Tj / TJ / ' / " from each content stream (inflating Flate
// streams). Covers simple generated PDFs; scans and CID fonts go to the AI.
function rawPdfText(buffer) {
  const zlib = require('zlib');
  const src = buffer.toString('latin1');
  const out = [];
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(src))) {
    const start = m.index + m[0].length;
    const end = src.indexOf('endstream', start);
    if (end < 0) break;
    const raw = buffer.subarray(start, end);
    let content;
    try {
      content = zlib.inflateSync(raw).toString('latin1');
    } catch {
      content = raw.toString('latin1');
    }
    const strings = [];
    const unescape = (t) => t.replace(/\\([nrtbf()\\])/g, (_, c) => ({ n: '\n', r: '', t: ' ', b: '', f: '' }[c] ?? c));
    const hex = (h) => Buffer.from(h.replace(/\s+/g, '').padEnd(Math.ceil(h.replace(/\s+/g, '').length / 2) * 2, '0'), 'hex').toString('latin1');
    for (const op of content.matchAll(/(?:\((?:\\.|[^\\)])*\)|<[0-9A-Fa-f\s]+>)\s*(?:Tj|'|")|\[((?:\((?:\\.|[^\\)])*\)|[^\]])*)\]\s*TJ/g)) {
      const chunk = op[1] != null ? op[1] : op[0];
      for (const str of chunk.matchAll(/\(((?:\\.|[^\\)])*)\)|<([0-9A-Fa-f\s]+)>/g)) strings.push(str[1] != null ? unescape(str[1]) : hex(str[2]));
      strings.push('\n');
    }
    if (strings.length) out.push(strings.join(''));
    re.lastIndex = end;
  }
  return out.join('\n');
}

async function extractText(buffer, mimetype) {
  if (!buffer) return '';
  if (mimetype === 'application/pdf') {
    try {
      const pdfParse = require('pdf-parse/lib/pdf-parse.js');
      const text = (await pdfParse(buffer)).text || '';
      if (text.trim()) return text;
    } catch {
      // fall through to the raw reader
    }
    try {
      const raw = rawPdfText(buffer);
      if (raw.trim()) return raw;
    } catch {
      // fall through to OCR
    }
    // Scanned title documents: local OCR (the AI classifier reads the file itself).
    return (await require('./ocr.service').recognise(buffer, 'application/pdf', { allowAi: false })).text;
  }
  if (/^text\//.test(mimetype || '')) return buffer.toString('utf8');
  if (/^image\//.test(mimetype || '')) return (await require('./ocr.service').recognise(buffer, mimetype, { allowAi: false })).text;
  return '';
}

function ruleClassify(text, fileName) {
  const hay = ` ${String(text || '').toLowerCase()} ${String(fileName || '').toLowerCase().replace(/[_.-]+/g, ' ')} `;
  let best = null;
  for (const [type, words] of Object.entries(TYPE_KEYWORDS)) {
    const hits = words.filter((w) => hay.includes(w)).length;
    if (hits && (!best || hits > best.hits)) best = { type, hits };
  }
  if (best?.type === 'noc' && /bank|loan/.test(hay)) best.type = 'bank_noc';
  if (best?.type === 'noc') best.type = 'society_noc';
  return best ? { type: best.type, confidence: Math.min(90, 45 + best.hits * 15) } : { type: null, confidence: 0 };
}

async function ruleFlags(text) {
  const kw = await configService.getConfig('dd.risk_keywords', {});
  const lower = String(text || '').toLowerCase();
  const flags = [];
  for (const [category, words] of Object.entries(kw || {})) {
    const hit = (words || []).find((w) => lower.includes(String(w).toLowerCase()));
    if (hit) flags.push({ category, severity: category === 'litigation' ? 'high' : 'medium', detail: `Mentions "${hit}"`, source: 'rules' });
  }
  if (text && text.length > 200 && !/sign|signature|executant|witness/i.test(text) && /deed|agreement/i.test(text)) {
    flags.push({ category: 'anomaly', severity: 'medium', detail: 'No signature / execution block found', source: 'rules' });
  }
  return flags;
}

async function aiAnalyse(buffer, mimetype, text) {
  if (!aiClient || !(await configService.getConfig('dd.ai_enabled', true))) return null;
  const schema = {
    type: 'object',
    properties: {
      document_type: { type: 'string', enum: [...Object.keys(TYPE_KEYWORDS).filter((t) => t !== 'noc'), 'payment_receipt', 'kyc', 'other'] },
      confidence: { type: 'integer' },
      summary: { type: 'string' },
      execution_date: { type: ['string', 'null'] },
      transfer_from: { type: ['string', 'null'] },
      transfer_to: { type: ['string', 'null'] },
      property_identifiers: { type: 'array', items: { type: 'string' } },
      amounts: { type: 'array', items: { type: 'string' } },
      risk_flags: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            category: { type: 'string', enum: ['encumbrance', 'litigation', 'compliance', 'possession', 'anomaly', 'expiry', 'mismatch'] },
            severity: { type: 'string', enum: ['low', 'medium', 'high'] },
            detail: { type: 'string' },
          },
          required: ['category', 'severity', 'detail'],
          additionalProperties: false,
        },
      },
    },
    required: ['document_type', 'confidence', 'summary', 'execution_date', 'transfer_from', 'transfer_to', 'property_identifiers', 'amounts', 'risk_flags'],
    additionalProperties: false,
  };
  const content = [];
  if (mimetype === 'application/pdf' && buffer && buffer.length < 20 * 1024 * 1024) {
    content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } });
  } else if (/^image\/(jpeg|png|webp|gif)$/.test(mimetype || '') && buffer && buffer.length < 5 * 1024 * 1024) {
    content.push({ type: 'image', source: { type: 'base64', media_type: mimetype, data: buffer.toString('base64') } });
  } else if (text) {
    content.push({ type: 'text', text: text.slice(0, 20000) });
  } else return null;
  content.push({
    type: 'text',
    text:
      'This is an Indian property document submitted for due diligence. Classify it, summarise it in 2 sentences, give the execution date (YYYY-MM-DD) ' +
      'and, for transfers (sale / gift / partition deeds), who transferred to whom. Flag risks: mortgages or charges, litigation or court orders, ' +
      'compliance notices, possession issues, missing signatures or stamps, expired validity, or internal inconsistencies (dates, areas, names). ' +
      'This is facilitation support for A R Buildwel staff, not legal advice.',
  });
  try {
    const response = await aiClient.messages.create({
      model: AI_MODEL,
      max_tokens: 1200,
      output_config: { effort: 'low', format: { type: 'json_schema', schema } },
      messages: [{ role: 'user', content }],
    });
    const block = response.content.find((b) => b.type === 'text');
    return block ? JSON.parse(block.text) : null;
  } catch (err) {
    console.error('[dd] AI analysis failed:', err.message);
    return null;
  }
}

// Classify + risk-scan one document buffer (no storage).
async function analyse(buffer, mimetype, fileName) {
  const text = await extractText(buffer, mimetype);
  const rule = ruleClassify(text, fileName);
  const flags = await ruleFlags(text);
  const dates = extractDates(text);
  const ai = await aiAnalyse(buffer, mimetype, text);
  const type = ai?.document_type && ai.document_type !== 'other' ? ai.document_type : rule.type;
  const allFlags = [...flags, ...((ai?.risk_flags || []).map((f) => ({ ...f, source: 'ai' })))];
  return {
    type,
    confidence: ai ? Math.max(ai.confidence || 0, rule.type === ai.document_type ? rule.confidence : 0) : rule.confidence,
    method: ai ? 'ai' : 'rules',
    summary: ai?.summary || (text ? text.replace(/\s+/g, ' ').trim().slice(0, 240) : null),
    extracted: {
      dates,
      executionDate: ai?.execution_date || (TRANSFER_TYPES.includes(type) ? dates[dates.length - 1] || null : null),
      transferFrom: ai?.transfer_from || null,
      transferTo: ai?.transfer_to || null,
      propertyIdentifiers: ai?.property_identifiers || [],
      amounts: ai?.amounts || [],
      textLength: text.length,
    },
    flags: allFlags,
  };
}

async function saveAnalysis(documentId, a) {
  await pool.query(
    `UPDATE documents SET ai_type = $1, ai_confidence = $2, ai_summary = $3, ai_extracted = $4, ai_flags = $5, ai_method = $6, ai_checked_at = now()
     WHERE id = $7`,
    [a.type, a.confidence, a.summary, JSON.stringify(a.extracted), JSON.stringify(a.flags), a.method, documentId]
  );
}

// ------------------------------------------------------------------ access

// Relationship of the user to a listing -> which document roles they hold.
async function rolesFor(user, propertyId) {
  if (STAFF.includes(user.role)) return { roles: ['admin', 'owner', 'broker', 'buyer'], staff: true };
  const p = (await pool.query('SELECT id, created_by, broker_id, builder_id FROM properties WHERE id = $1', [propertyId])).rows[0];
  if (!p) throw notFound('Listing not found');
  const roles = [];
  if (p.created_by === user.id || p.builder_id === user.id) roles.push('owner');
  if (p.broker_id === user.id || (p.created_by === user.id && ['broker', 'agency_admin'].includes(user.role))) roles.push('broker');
  const partner = await pool.query('SELECT 1 FROM property_partners WHERE property_id = $1 AND partner_user_id = $2', [propertyId, user.id]);
  if (partner.rows.length) roles.push('broker');
  // A buyer on an active deal for this listing that has reached negotiation.
  const buyer = await pool.query(
    `SELECT 1 FROM deals d JOIN customers c ON c.id = d.customer_id
     WHERE d.property_id = $1 AND c.user_id = $2 AND d.stage::text = ANY(ARRAY['negotiation', 'legal_coordination', 'loan_referral', 'insurance_referral', 'payment', 'closed_won', 'booking', 'documentation'])`,
    [propertyId, user.id]
  );
  if (buyer.rows.length) roles.push('buyer');
  return { roles: [...new Set(roles)], staff: false };
}

async function listPropertyDocuments(user, propertyId) {
  const { roles, staff } = await rolesFor(user, propertyId);
  if (!roles.length) throw forbidden('You do not have access to this listing\'s documents');
  const r = await pool.query(
    `SELECT d.id, d.document_type, d.document_url, d.file_name, d.status, d.review_notes, d.visible_to, d.deal_id,
            d.ai_type, d.ai_confidence, d.ai_summary, d.ai_extracted, d.ai_flags, d.ai_method, d.created_at, u.full_name AS uploaded_by_name
     FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by
     WHERE (d.property_id = $1 OR d.deal_id IN (SELECT id FROM deals WHERE property_id = $1))
       AND ($2 OR d.visible_to ?| $3::text[])
     ORDER BY d.created_at DESC`,
    [propertyId, staff, roles]
  );
  const rows = await signUrls(r.rows, 'document_url');
  return { roles, documents: staff ? rows : rows.map(({ ai_flags, ...rest }) => ({ ...rest, ai_flags: roles.includes('owner') ? ai_flags : [] })) };
}

async function addPropertyDocument(user, propertyId, { documentType, visibleTo, documentUrl, fileName, file }, meta = {}) {
  const { roles, staff } = await rolesFor(user, propertyId);
  if (!staff && !roles.includes('owner') && !roles.includes('broker')) throw forbidden('Only the owner, the listing broker or A R staff can add documents');
  const visible = [...new Set(['admin', ...(visibleTo && visibleTo.length ? visibleTo : ['owner', 'broker'])])];
  let url = documentUrl;
  let analysis = null;
  if (file) {
    analysis = await analyse(file.buffer, file.mimetype, file.originalname);
    const { uploadBuffer } = require('../utils/storage');
    url = await uploadBuffer(file.buffer, `documents/properties/${propertyId}`, file.originalname, file.mimetype);
  }
  if (!url) throw badRequest('Attach a file');
  const type = documentType || analysis?.type || 'other';
  const r = await pool.query(
    `INSERT INTO documents (tenant_id, property_id, document_type, document_url, file_name, uploaded_by, status, visible_to)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7) RETURNING id`,
    [user.tenant_id || null, propertyId, type, url, fileName || file?.originalname || null, user.id, JSON.stringify(visible)]
  );
  if (analysis) await saveAnalysis(r.rows[0].id, analysis);
  await auditService.log({ actor: user, action: 'document.added', entityType: 'property', entityId: propertyId, after: { documentId: r.rows[0].id, type, visibleTo: visible }, ...meta });
  await recompute(propertyId);
  return { id: r.rows[0].id, documentType: type, analysis };
}

// ---------------------------------------------------------- due diligence

async function checklistFor(p, ctx) {
  const lists = await configService.getConfig('dd.checklists', {});
  let items = [];
  if (p.transaction_type === 'rent') items = [...(lists.rent || [])];
  else if (/under.?construction|new launch/i.test(p.possession_status || '')) items = [...(lists.sale_under_construction || [])];
  else items = [...(lists.sale || []), ...(p.property_type === 'plot' ? [] : lists.sale_ready_extra || [])];
  if (p.property_type === 'plot') items.push(...(lists.plot_extra || []));
  if (ctx.loan) items.push(...(lists.loan_extra || []));
  if (ctx.nriSeller) items.push(...(lists.nri_extra || []));
  const seen = new Set();
  return items.filter((i) => (seen.has(i.type) ? false : seen.add(i.type)));
}

function titleChain(docs, manual) {
  const links = [];
  for (const d of docs) {
    const t = d.document_type !== 'other' ? d.document_type : d.ai_type;
    if (!TRANSFER_TYPES.includes(t) && !TRANSFER_TYPES.includes(d.ai_type)) continue;
    const date = d.ai_extracted?.executionDate || (d.ai_extracted?.dates || []).slice(-1)[0];
    if (!date) continue;
    links.push({ date, from: d.ai_extracted?.transferFrom || null, to: d.ai_extracted?.transferTo || null, documentId: d.id, source: 'document' });
  }
  for (const m of manual || []) links.push({ ...m, source: 'manual' });
  links.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const gaps = [];
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
  for (let i = 1; i < links.length; i += 1) {
    const prevTo = norm(links[i - 1].to);
    const from = norm(links[i].from);
    if (prevTo && from && !prevTo.includes(from) && !from.includes(prevTo)) {
      gaps.push({ between: [links[i - 1].date, links[i].date], detail: `Chain breaks: "${links[i - 1].to}" then "${links[i].from}"` });
    }
  }
  const years = links.length ? Math.round(((Date.now() - new Date(links[0].date).getTime()) / (365.25 * 86400000)) * 10) / 10 : 0;
  return { links, years, gaps };
}

async function recompute(propertyId) {
  const p = (await pool.query('SELECT * FROM properties WHERE id = $1', [propertyId])).rows[0];
  if (!p) throw notFound('Listing not found');
  const existing = (await pool.query('SELECT * FROM property_due_diligence WHERE property_id = $1', [propertyId])).rows[0];
  const docs = (
    await pool.query(
      `SELECT d.* FROM documents d
       WHERE (d.property_id = $1 OR d.deal_id IN (SELECT id FROM deals WHERE property_id = $1)) AND d.status <> 'rejected'`,
      [propertyId]
    )
  ).rows;
  const lister = p.broker_id || p.created_by;
  const nriSeller = !!(await pool.query(`SELECT 1 FROM investor_profiles WHERE user_id = $1 AND is_nri`, [p.created_by])).rows.length;
  const nriBuyers = (
    await pool.query(
      `SELECT DISTINCT ip.user_id FROM deals d JOIN customers c ON c.id = d.customer_id JOIN investor_profiles ip ON ip.user_id = c.user_id
       WHERE d.property_id = $1 AND ip.is_nri`,
      [propertyId]
    )
  ).rows;
  const allFlags = docs.flatMap((d) => (d.ai_flags || []).map((f) => ({ ...f, documentId: d.id, documentType: d.document_type })));
  const loan = allFlags.some((f) => f.category === 'encumbrance');

  // Checklist + missing documents.
  const items = await checklistFor(p, { loan, nriSeller });
  const has = (type) => docs.some((d) => d.document_type === type || d.ai_type === type);
  const checklist = items.map((i) => ({ ...i, present: has(i.type) }));
  const missing = checklist.filter((i) => i.required && !i.present).map((i) => ({ type: i.type, label: i.label }));

  // Title chain.
  const requiredYears = Number(await configService.getConfig('dd.title_chain_years', 30)) || 30;
  const chain = titleChain(docs, existing?.manual_title_links || []);
  const riskFlags = [...allFlags];
  if (chain.links.length && chain.years < requiredYears) riskFlags.push({ category: 'title', severity: chain.years < 3 ? 'high' : 'medium', detail: `Title history covers ${chain.years} years (target ${requiredYears})` });
  for (const g of chain.gaps) riskFlags.push({ category: 'title', severity: 'high', detail: g.detail });
  if (!chain.links.length && p.transaction_type !== 'rent') riskFlags.push({ category: 'title', severity: 'medium', detail: 'No dated title documents yet' });

  // Encumbrance.
  const ec = docs.filter((d) => d.document_type === 'encumbrance_certificate' || d.ai_type === 'encumbrance_certificate');
  const ecCharged = ec.some((d) => (d.ai_flags || []).some((f) => f.category === 'encumbrance'));
  const bankNoc = has('bank_noc');
  const encumbrance = {
    status: !ec.length ? (loan ? 'charged' : 'unknown') : ecCharged ? 'charged' : 'clear',
    certificate: ec.length > 0,
    bankNoc,
    detail: !ec.length ? 'No encumbrance certificate yet' : ecCharged ? 'Charge / mortgage shown on the encumbrance certificate' : 'No charges shown',
  };
  if ((encumbrance.status === 'charged') && !bankNoc) riskFlags.push({ category: 'encumbrance', severity: 'high', detail: 'Mortgage / charge without a bank NOC or loan closure letter' });

  // Possession risk.
  const reasons = [];
  let level = 'low';
  const bump = (l, why) => {
    reasons.push(why);
    if (l === 'high' || (l === 'medium' && level === 'low')) level = l;
  };
  if (p.possession_type === 'symbolic') bump('high', 'Only symbolic possession taken');
  if ((p.risk_indicators || []).includes('possession_unclear')) bump('high', 'Possession marked unclear');
  if ((p.risk_indicators || []).includes('tenant_occupied')) bump('medium', 'Tenant occupied');
  if (allFlags.some((f) => f.category === 'possession')) bump('medium', 'Documents mention occupation / possession issues');
  if (/under.?construction/i.test(p.possession_status || '') && !has('possession_letter')) bump('medium', 'Under construction - no possession letter yet');
  if (p.transaction_type !== 'rent' && !/under.?construction/i.test(p.possession_status || '') && p.property_type !== 'plot' && !has('occupancy_certificate')) bump('medium', 'No occupancy certificate on file');

  // NRI considerations (non-advisory).
  const nri = { seller: nriSeller, buyers: nriBuyers.length, points: [] };
  if (nriSeller) {
    nri.points.push(
      'Seller is an NRI: the buyer deducts TDS under Section 195 on the capital gain (a lower-deduction certificate under Section 197 / Form 13 can reduce it).',
      'NRI seller needs a PAN; repatriation of sale proceeds needs Form 15CA / 15CB within the annual limit.',
      'If the seller signs through a power of attorney, it must be registered, and attested by the Indian consulate if executed abroad.'
    );
  }
  if (nriBuyers.length) {
    nri.points.push('NRI / OCI buyers may buy residential and commercial property; agricultural land, plantations and farmhouses generally need RBI approval.', 'Payment must come through normal banking channels or NRE / NRO / FCNR accounts.');
    if (['farmhouse'].includes(p.property_type) || /agricultur/i.test(`${p.title} ${p.description || ''}`)) {
      riskFlags.push({ category: 'compliance', severity: 'high', detail: 'NRI buyer on agricultural land / farmhouse - FEMA restriction' });
    }
  }

  // State RERA registry (crawler_rera.js): delayed / lapsed projects and complaints.
  const rera = await require('./market.service').reraCheck(p.rera_number).catch(() => ({ provided: !!p.rera_number, found: false, flags: [] }));
  riskFlags.push(...rera.flags);
  const high = riskFlags.some((f) => f.severity === 'high');
  const status = !docs.length ? 'not_started' : high || docs.some((d) => d.status === 'rejected') ? 'issues' : missing.length ? 'in_progress' : 'complete';
  const r = await pool.query(
    `INSERT INTO property_due_diligence (property_id, status, checklist, missing, title_chain, title_years, title_gaps, encumbrance,
       possession_risk, possession_reasons, risk_flags, nri, computed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
     ON CONFLICT (property_id) DO UPDATE SET status = EXCLUDED.status, checklist = EXCLUDED.checklist, missing = EXCLUDED.missing,
       title_chain = EXCLUDED.title_chain, title_years = EXCLUDED.title_years, title_gaps = EXCLUDED.title_gaps,
       encumbrance = EXCLUDED.encumbrance, possession_risk = EXCLUDED.possession_risk, possession_reasons = EXCLUDED.possession_reasons,
       risk_flags = EXCLUDED.risk_flags, nri = EXCLUDED.nri, computed_at = now()
     RETURNING *`,
    [propertyId, status, JSON.stringify(checklist), JSON.stringify(missing), JSON.stringify(chain.links), chain.years, JSON.stringify(chain.gaps),
      JSON.stringify(encumbrance), level, JSON.stringify(reasons), JSON.stringify(riskFlags), JSON.stringify(nri)]
  );
  void lister;
  return r.rows[0];
}

function safeRecompute(propertyId) {
  if (!propertyId) return;
  recompute(propertyId).catch((err) => console.error(`[dd] recompute ${propertyId} failed:`, err.message));
}

async function report(user, propertyId) {
  const { roles, staff } = await rolesFor(user, propertyId);
  if (!roles.length) throw forbidden('No access to this listing');
  const dd = await recompute(propertyId);
  const disclaimers = await disclaimerService.getDisclaimers(['due_diligence', 'tax_legal']);
  const p0 = (await pool.query('SELECT id, title, city, locality, property_type, transaction_type, price_value, rera_number FROM properties WHERE id = $1', [propertyId])).rows[0];
  const { rera_number: _rera, ...p } = p0;
  const view = {
    property: p,
    status: dd.status,
    checklist: dd.checklist,
    missing: dd.missing,
    titleChain: { links: dd.title_chain, years: Number(dd.title_years) || 0, gaps: dd.title_gaps },
    encumbrance: dd.encumbrance,
    possession: { risk: dd.possession_risk, reasons: dd.possession_reasons },
    riskFlags: dd.risk_flags,
    nri: dd.nri,
    rera: await require('./market.service').reraCheck(p0.rera_number).then((r) => ({ provided: r.provided, found: r.found, registryLoaded: r.registryLoaded, project: r.project || null })).catch(() => null),
    staffNotes: staff ? dd.staff_notes : undefined,
    reviewedAt: dd.reviewed_at,
    computedAt: dd.computed_at,
    disclaimers,
  };
  // Buyers see the checklist status and summary, not internal flags detail.
  if (!staff && !roles.includes('owner') && !roles.includes('broker')) {
    view.riskFlags = view.riskFlags.map((f) => ({ category: f.category, severity: f.severity }));
  }
  return view;
}

async function addTitleLink(user, propertyId, link, meta = {}) {
  if (!link?.date) throw badRequest('date is required');
  await recompute(propertyId);
  const r = await pool.query(
    `UPDATE property_due_diligence SET manual_title_links = manual_title_links || $1::jsonb WHERE property_id = $2 RETURNING property_id`,
    [JSON.stringify([{ date: link.date, from: link.from || null, to: link.to || null, note: link.note || null, addedBy: user.id }]), propertyId]
  );
  if (!r.rows[0]) throw notFound('Listing not found');
  await auditService.log({ actor: user, action: 'dd.title_link_added', entityType: 'property', entityId: propertyId, after: link, ...meta });
  return report(user, propertyId);
}

async function review(user, propertyId, { notes }, meta = {}) {
  await recompute(propertyId);
  await pool.query(`UPDATE property_due_diligence SET staff_notes = $1, reviewed_by = $2, reviewed_at = now() WHERE property_id = $3`, [notes || null, user.id, propertyId]);
  await auditService.log({ actor: user, action: 'dd.reviewed', entityType: 'property', entityId: propertyId, after: { notes }, ...meta });
  return report(user, propertyId);
}

async function reviewDocument(user, documentId, { status, notes }, meta = {}) {
  const r = await pool.query(`UPDATE documents SET status = $1, review_notes = $2, reviewed_by = $3 WHERE id = $4 RETURNING property_id, deal_id`, [status, notes || null, user.id, documentId]);
  if (!r.rows[0]) throw notFound('Document not found');
  await auditService.log({ actor: user, action: `document.${status}`, entityType: 'document', entityId: documentId, after: { notes }, ...meta });
  let pid = r.rows[0].property_id;
  if (!pid && r.rows[0].deal_id) pid = (await pool.query('SELECT property_id FROM deals WHERE id = $1', [r.rows[0].deal_id])).rows[0]?.property_id;
  if (pid) await recompute(pid);
  const orchestration = require('./orchestration.service');
  if (r.rows[0].deal_id) orchestration.safeEvaluate(r.rows[0].deal_id);
  if (pid) orchestration.evaluateForProperty(pid).catch(() => {});
  return { id: documentId, status };
}

async function queue() {
  const r = await pool.query(
    `SELECT dd.property_id, dd.status, dd.missing, dd.risk_flags, dd.possession_risk, dd.title_years, dd.computed_at, dd.reviewed_at,
            p.title, p.city, p.price_value, p.status AS listing_status,
            (SELECT COUNT(*)::int FROM documents d WHERE d.property_id = p.id AND d.status = 'pending') AS pending_docs
     FROM property_due_diligence dd JOIN properties p ON p.id = dd.property_id
     WHERE dd.status IN ('issues', 'in_progress') OR EXISTS (SELECT 1 FROM documents d WHERE d.property_id = p.id AND d.status = 'pending')
     ORDER BY (dd.status = 'issues') DESC, dd.computed_at DESC LIMIT 300`
  );
  return r.rows;
}

module.exports = {
  analyse,
  saveAnalysis,
  rolesFor,
  listPropertyDocuments,
  addPropertyDocument,
  recompute,
  safeRecompute,
  report,
  addTitleLink,
  review,
  reviewDocument,
  queue,
  extractDates,
  ruleClassify,
};
