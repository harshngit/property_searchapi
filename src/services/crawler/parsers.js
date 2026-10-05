const cheerio = require('cheerio');
const pdfParse = require('pdf-parse/lib/pdf-parse.js');
const Anthropic = require('@anthropic-ai/sdk');
const { politeFetch, CrawlerError } = require('./fetcher');

// Layer 2 - parsers. Each crawler source has an adapter and a field mapping
// in crawler_sources.config (admin-editable, no code change per portal):
//
//   html_list  { itemSelector, fields: { title: "td:nth-child(2)",
//                auction_portal_url: { selector: "a", attr: "href" }, ... },
//                nextPageSelector, constants: { source_bank: "..." } }
//   json_api   { itemsPath: "data.items", fields: { title: "propertyName" },
//                pageParam: "page", constants }
//   rss        { fields (optional overrides), constants }
//   pdf_links  { linkSelector: "a[href$='.pdf']", maxPdfs: 10, constants }
//
// Output items are plain objects with the field names the normaliser
// (Layer 3) understands: title, description, city, locality, pincode,
// reserve_price, emd_amount, auction_date, emd_deadline, inspection_date,
// source_bank, auction_reference_id, auction_portal_url, possession, area.
// Contact details are never kept - the normaliser strips them anyway.

const AI_MODEL = 'claude-sonnet-5';
const aiClient = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

const clean = (v) => (v == null ? null : String(v).replace(/\s+/g, ' ').trim() || null);

function absolutise(href, baseUrl) {
  if (!href) return null;
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

function getPath(obj, path) {
  return String(path || '')
    .split('.')
    .filter(Boolean)
    .reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

// ------------------------------------------------------------ text notices

const MONEY = '(?:rs\\.?|inr|₹)\\s*([0-9][0-9,]*(?:\\.[0-9]+)?)\\s*(crores?|cr|lakhs?|lacs?|l)?';
const DATE = '([0-3]?[0-9][./-][01]?[0-9][./-](?:20)?[0-9]{2}|[0-3]?[0-9](?:st|nd|rd|th)?\\s+[a-z]{3,9},?\\s+20[0-9]{2})';

function moneyAfter(label, text) {
  const m = new RegExp(`${label}[^0-9₹]{0,40}${MONEY}`, 'i').exec(text);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  const unit = (m[2] || '').toLowerCase();
  if (unit.startsWith('cr')) return n * 1e7;
  if (unit.startsWith('l')) return n * 1e5;
  return n;
}

function dateAfter(label, text) {
  const m = new RegExp(`${label}[^0-9a-z]{0,40}${DATE}`, 'i').exec(text);
  return m ? m[1] : null;
}

// Regex extraction from notice text (SARFAESI sale notices, DRT / NCLT
// notices, newspaper public notices). Good enough for the standard
// formats; anything missing is left for the AI parser or human review.
function extractFromText(text) {
  const t = String(text || '');
  const pin = /\b([1-9][0-9]{5})\b/.exec(t);
  const area = /([0-9][0-9,]*(?:\.[0-9]+)?)\s*(sq\.?\s*(?:ft|feet|mtrs?|metres?|yds?|yards?)|square\s+(?:feet|metres|yards))/i.exec(t);
  const firstLine = t.split(/\n/).map((l) => l.trim()).find((l) => l.length > 15 && l.length < 200);
  return {
    title: firstLine || null,
    description: t.slice(0, 1500),
    reserve_price: moneyAfter('reserve\\s*price', t),
    emd_amount: moneyAfter('(?:emd|earnest\\s*money)', t),
    auction_date: dateAfter('(?:date\\s*(?:and|&)?\\s*time\\s*of\\s*(?:e-?)?auction|(?:e-?)?auction\\s*date|date\\s*of\\s*(?:e-?)?auction)', t),
    emd_deadline: dateAfter('(?:last\\s*date\\s*(?:for|of)\\s*(?:submission\\s*of\\s*)?(?:emd|bid))', t),
    inspection_date: dateAfter('(?:date\\s*(?:of|for)\\s*inspection|inspection\\s*date)', t),
    possession: /physical\s+possession/i.test(t) ? 'physical' : /symbolic\s+possession/i.test(t) ? 'symbolic' : null,
    pincode: pin ? pin[1] : null,
    area: area ? `${area[1]} ${area[2]}` : null,
    source_type: /sarfaesi/i.test(t) ? 'sarfaesi' : /nclt|insolvency|liquidat/i.test(t) ? 'nclt' : /drt|recovery\s+tribunal/i.test(t) ? 'drt' : null,
  };
}

const AI_SCHEMA = {
  type: 'object',
  properties: {
    title: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    property_type: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    city: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    locality: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    pincode: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    area: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    reserve_price: { anyOf: [{ type: 'number' }, { type: 'null' }] },
    emd_amount: { anyOf: [{ type: 'number' }, { type: 'null' }] },
    auction_date: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    emd_deadline: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    inspection_date: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    source_bank: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    auction_reference_id: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    possession: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
  required: ['title', 'reserve_price', 'auction_date', 'city'],
  additionalProperties: false,
};

// AI parser for notices the regexes can't read (Layer 2, "complex
// documents"). Returns null when no AI key is configured. Never asked for -
// and the schema has no place for - names, phone numbers or emails.
async function aiExtract(text) {
  if (!aiClient || !text || text.trim().length < 40) return null;
  const response = await aiClient.messages.create({
    model: AI_MODEL,
    max_tokens: 1024,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: AI_SCHEMA } },
    messages: [
      {
        role: 'user',
        content:
          'Extract the property sale / auction details from this Indian bank auction or public sale notice. ' +
          'Prices in rupees as plain numbers (convert lakh / crore). Dates as YYYY-MM-DD (use DD-MM-YYYY Indian order when reading). ' +
          'Use null for anything not stated. Do not include any person names, phone numbers or email addresses.\n\n' +
          text.slice(0, 12000),
      },
    ],
  });
  const block = response.content.find((b) => b.type === 'text');
  try {
    return block ? JSON.parse(block.text) : null;
  } catch {
    return null;
  }
}

// Fill gaps in a regex/HTML-parsed item from the AI parser when enabled.
async function enrichWithAi(item, text, useAi) {
  if (!useAi) return item;
  const missing = ['reserve_price', 'auction_date', 'city', 'title'].some((k) => item[k] == null);
  if (!missing) return item;
  const ai = await aiExtract(text).catch(() => null);
  if (!ai) return item;
  const merged = { ...item };
  for (const [k, v] of Object.entries(ai)) if (merged[k] == null && v != null) merged[k] = v;
  merged.parsed_by_ai = true;
  return merged;
}

// ------------------------------------------------------------ adapters

function readField($, el, spec, baseUrl) {
  if (!spec) return null;
  const { selector, attr } = typeof spec === 'string' ? { selector: spec } : spec;
  const target = selector ? $(el).find(selector).first() : $(el);
  if (!target.length) return null;
  const value = attr ? target.attr(attr) : target.text();
  if (attr === 'href' || attr === 'src') return absolutise(value, baseUrl);
  return clean(value);
}

async function htmlList(source, { maxPages, onPage }) {
  const cfg = source.config || {};
  if (!source.list_url || !cfg.itemSelector || !cfg.fields) {
    throw new CrawlerError('not_configured', 'Set the listing URL, itemSelector and field mapping for this source');
  }
  const items = [];
  const raw = [];
  let url = source.list_url;
  for (let page = 0; url && page < maxPages; page += 1) {
    const html = await politeFetch(url);
    onPage();
    raw.push({ url, bytes: html.length, html: html.slice(0, 200000) });
    const $ = cheerio.load(html);
    $(cfg.itemSelector).each((_, el) => {
      const item = {};
      for (const [key, spec] of Object.entries(cfg.fields)) item[key] = readField($, el, spec, url);
      if (Object.values(item).some((v) => v)) items.push({ ...cfg.constants, ...item, _text: clean($(el).text()) });
    });
    const next = cfg.nextPageSelector ? $(cfg.nextPageSelector).first().attr('href') : null;
    url = next ? absolutise(next, url) : null;
  }
  return { items, raw };
}

async function jsonApi(source, { maxPages, onPage }) {
  const cfg = source.config || {};
  if (!source.list_url || !cfg.fields) throw new CrawlerError('not_configured', 'Set the API URL and field mapping for this source');
  const items = [];
  const raw = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const url = cfg.pageParam ? `${source.list_url}${source.list_url.includes('?') ? '&' : '?'}${cfg.pageParam}=${page}` : source.list_url;
    const json = await politeFetch(url, { as: 'json' });
    onPage();
    raw.push({ url, json });
    const rows = cfg.itemsPath ? getPath(json, cfg.itemsPath) : json;
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const row of rows) {
      const item = {};
      for (const [key, path] of Object.entries(cfg.fields)) item[key] = clean(getPath(row, path));
      items.push({ ...cfg.constants, ...item, _text: JSON.stringify(row).slice(0, 4000) });
    }
    if (!cfg.pageParam) break;
  }
  return { items, raw };
}

async function rss(source, { onPage }) {
  const cfg = source.config || {};
  if (!source.list_url) throw new CrawlerError('not_configured', 'Set the feed URL for this source');
  const xml = await politeFetch(source.list_url);
  onPage();
  const $ = cheerio.load(xml, { xmlMode: true });
  const items = [];
  $('item, entry').each((_, el) => {
    const text = clean($(el).find('description, summary, content').first().text());
    items.push({
      ...cfg.constants,
      ...extractFromText(text || ''),
      title: clean($(el).find('title').first().text()),
      auction_portal_url: clean($(el).find('link').first().attr('href') || $(el).find('link').first().text()),
      auction_reference_id: clean($(el).find('guid, id').first().text()),
      _text: text,
    });
  });
  return { items, raw: [{ url: source.list_url, bytes: xml.length }] };
}

// Text of a notice file. PDFs with a text layer are read directly; scanned
// PDFs and images go through OCR (Tesseract, then AI vision if needed).
// Returns { text, method: 'text' | 'tesseract' | 'ai_vision' | 'none', ocrPages }.
async function readNotice(buffer, mimetype = 'application/pdf') {
  const isPdf = mimetype === 'application/pdf' || buffer.subarray(0, 5).toString('latin1') === '%PDF-';
  let parseError = null;
  if (isPdf) {
    try {
      const parsed = await pdfParse(buffer);
      // A few stray characters (page numbers, a stamp) are not a text layer.
      if ((parsed.text || '').replace(/\s+/g, '').length >= 40) return { text: parsed.text, method: 'text', ocrPages: 0 };
    } catch (err) {
      parseError = err;
    }
  } else if (/^text\//.test(mimetype)) {
    return { text: buffer.toString('utf8'), method: 'text', ocrPages: 0 };
  }
  const ocr = await require('../ocr.service').recognise(buffer, isPdf ? 'application/pdf' : mimetype);
  if (ocr.text) return { text: ocr.text, method: ocr.method, ocrPages: ocr.pages || 1, confidence: ocr.confidence };
  if (parseError) throw new CrawlerError('parse_error', `Could not read PDF: ${parseError.message}`);
  return { text: '', method: 'none', ocrPages: 0 };
}

async function pdfText(buffer) {
  return (await readNotice(buffer)).text;
}

async function pdfLinks(source, { onPage }) {
  const cfg = source.config || {};
  if (!source.list_url) throw new CrawlerError('not_configured', 'Set the page URL that lists the notice PDFs');
  const html = await politeFetch(source.list_url);
  onPage();
  const $ = cheerio.load(html);
  const links = [...new Set($(cfg.linkSelector || "a[href$='.pdf'], a[href$='.PDF']").map((_, a) => absolutise($(a).attr('href'), source.list_url)).get())]
    .filter(Boolean)
    .slice(0, Number(cfg.maxPdfs) || 10);
  const items = [];
  let ocr = 0;
  for (const link of links) {
    const buffer = await politeFetch(link, { as: 'buffer' });
    onPage();
    const { text, method, ocrPages } = await readNotice(buffer);
    ocr += ocrPages;
    if (!text.trim()) continue; // unreadable even with OCR
    items.push({ ...cfg.constants, ...extractFromText(text), auction_portal_url: link, auction_reference_id: link, _text: text, _method: method });
  }
  return { items, raw: [{ url: source.list_url, pdfs: links }], ocrPages: ocr };
}

const ADAPTERS = { html_list: htmlList, json_api: jsonApi, rss, pdf_links: pdfLinks };

// Runs a source's adapter and returns parsed items ready for Layer 3.
async function parseSource(source) {
  const adapter = ADAPTERS[source.adapter];
  if (!adapter) throw new CrawlerError('not_configured', `Unknown adapter ${source.adapter}`);
  let pages = 0;
  const { items, raw, ocrPages = 0 } = await adapter(source, { maxPages: source.max_pages || 5, onPage: () => (pages += 1) });
  // Reference-data sources (RERA registry, price indices, market stats) are
  // mapped by referenceData.js - the auction extractors do not apply.
  if ((source.output || 'opportunity') !== 'opportunity') return { items, raw, pages, ocrPages };
  const enriched = [];
  for (const item of items) {
    const { _text, _method, ...rest } = item;
    // Table rows often hold the key facts in free text too - let the regex
    // extractor fill any gaps before the (optional) AI parser.
    const fromText = _text ? extractFromText(_text) : {};
    const merged = { ...Object.fromEntries(Object.entries(fromText).filter(([k]) => k !== 'description' && k !== 'title')), ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v != null)) };
    enriched.push(await enrichWithAi(merged, _text, source.use_ai_parser));
  }
  return { items: enriched, raw, pages, ocrPages };
}

module.exports = { parseSource, extractFromText, aiExtract, pdfText, readNotice, enrichWithAi };
