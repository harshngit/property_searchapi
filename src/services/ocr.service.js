const os = require('os');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const configService = require('./config.service');

// Section 23 Layer 2 - OCR for scanned notices (and any scanned document).
//   1. PDFs with a text layer never get here (the callers read that first).
//   2. Scanned PDFs: a scan is one image per page embedded in the PDF. Those
//      images are pulled straight out of the file (JPEG as-is, Flate bitmaps
//      rebuilt) - no page renderer / native library needed - and read with
//      Tesseract (tesseract.js, Apache-2.0).
//   3. When Tesseract's confidence is below crawler.ocr_min_confidence, or
//      the scan uses a codec that cannot be decoded here (CCITT fax / JBIG2 /
//      JPEG 2000), the AI vision parser reads the document instead - only
//      when ANTHROPIC_API_KEY is configured.
// Never throws: returns { text: '', method: 'none' } when nothing readable.

const AI_MODEL = 'claude-sonnet-5';
const CACHE_DIR = process.env.OCR_CACHE_DIR || path.join(os.tmpdir(), 'propertyserch-ocr');

async function settings() {
  const [enabled, langs, maxPages, minConfidence] = await Promise.all([
    configService.getConfig('crawler.ocr_enabled', true),
    configService.getConfig('crawler.ocr_languages', 'eng'),
    configService.getConfig('crawler.ocr_max_pages', 8),
    configService.getConfig('crawler.ocr_min_confidence', 55),
  ]);
  return {
    enabled: enabled !== false && process.env.OCR_DISABLED !== 'true',
    langs: String(langs || 'eng').split('+').map((l) => l.trim()).filter(Boolean),
    maxPages: Math.max(1, Math.min(40, Number(maxPages) || 8)),
    minConfidence: Number(minConfidence) || 55,
  };
}

// ------------------------------------------------------------ PDF images

function pngUnfilter(data, width, bytesPerPixel) {
  const stride = width * bytesPerPixel;
  const rows = Math.floor(data.length / (stride + 1));
  const out = Buffer.alloc(rows * stride);
  for (let y = 0; y < rows; y += 1) {
    const type = data[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const raw = data[src + x];
      const a = x >= bytesPerPixel ? out[dst + x - bytesPerPixel] : 0;
      const b = y > 0 ? out[dst - stride + x] : 0;
      const c = x >= bytesPerPixel && y > 0 ? out[dst - stride + x - bytesPerPixel] : 0;
      let v = raw;
      if (type === 1) v = raw + a;
      else if (type === 2) v = raw + b;
      else if (type === 3) v = raw + ((a + b) >> 1);
      else if (type === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = raw + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      out[dst + x] = v & 0xff;
    }
  }
  return out;
}

// Returns { images: [Buffer (png / jpeg)], undecodable: n } for the page
// scans embedded in a PDF, in document order.
async function pdfPageImages(buffer, maxPages) {
  const { PDFDocument, PDFName, PDFRawStream, PDFArray, PDFNumber, PDFDict } = require('pdf-lib');
  const { Jimp } = require('jimp');
  const doc = await PDFDocument.load(buffer, { ignoreEncryption: true, updateMetadata: false });
  const images = [];
  let undecodable = 0;
  const num = (dict, key) => {
    const v = dict.lookup(PDFName.of(key));
    return v instanceof PDFNumber ? v.asNumber() : null;
  };
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (images.length >= maxPages) break;
    if (!(obj instanceof PDFRawStream)) continue;
    const dict = obj.dict;
    if (dict.lookup(PDFName.of('Subtype')) !== PDFName.of('Image')) continue;
    const width = num(dict, 'Width');
    const height = num(dict, 'Height');
    if (!width || !height || width < 300 || height < 100) continue; // logos, stamps, icons
    let filter = dict.lookup(PDFName.of('Filter'));
    if (filter instanceof PDFArray) filter = filter.size() === 1 ? filter.lookup(0) : filter.lookup(filter.size() - 1);
    const name = filter ? String(filter).replace('/', '') : '';
    const data = Buffer.from(obj.contents);
    try {
      if (name === 'DCTDecode') {
        images.push(data);
      } else if (name === 'FlateDecode' || name === '') {
        let px = name ? zlib.inflateSync(data) : data;
        const bpc = num(dict, 'BitsPerComponent') || 8;
        const cs = String(dict.lookup(PDFName.of('ColorSpace')) || '');
        const comps = /RGB/.test(cs) ? 3 : /CMYK/.test(cs) ? 4 : 1;
        const parms = dict.lookup(PDFName.of('DecodeParms'));
        const predictor = parms instanceof PDFDict ? num(parms, 'Predictor') : null;
        if (predictor && predictor >= 10 && bpc === 8) px = pngUnfilter(px, width, comps);
        const rgba = Buffer.alloc(width * height * 4, 255);
        if (bpc === 8 && comps !== 4) {
          if (px.length < width * height * comps) throw new Error('short bitmap');
          for (let i = 0; i < width * height; i += 1) {
            rgba[i * 4] = px[i * comps];
            rgba[i * 4 + 1] = px[i * comps + (comps === 3 ? 1 : 0)];
            rgba[i * 4 + 2] = px[i * comps + (comps === 3 ? 2 : 0)];
          }
        } else if (bpc === 1 && comps === 1) {
          const stride = Math.ceil(width / 8);
          if (px.length < stride * height) throw new Error('short bitmap');
          for (let y = 0; y < height; y += 1) {
            for (let x = 0; x < width; x += 1) {
              const v = (px[y * stride + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0;
              const o = (y * width + x) * 4;
              rgba[o] = v; rgba[o + 1] = v; rgba[o + 2] = v;
            }
          }
        } else {
          throw new Error('unsupported bitmap');
        }
        images.push(await Jimp.fromBitmap({ data: rgba, width, height }).getBuffer('image/png'));
      } else {
        undecodable += 1; // CCITTFaxDecode / JBIG2Decode / JPXDecode
      }
    } catch {
      undecodable += 1;
    }
  }
  return { images, undecodable };
}

// ------------------------------------------------------------ engines

async function tesseract(images, langs) {
  const { createWorker } = require('tesseract.js');
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const worker = await createWorker(langs, 1, { cachePath: CACHE_DIR, logger: () => {} });
  try {
    const parts = [];
    let conf = 0;
    for (const img of images) {
      const { data } = await worker.recognize(img);
      parts.push(data.text || '');
      conf += data.confidence || 0;
    }
    return { text: parts.join('\n\n').trim(), confidence: images.length ? Math.round(conf / images.length) : 0 };
  } finally {
    await worker.terminate().catch(() => {});
  }
}

async function aiTranscribe(buffer, mimetype) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic();
    const data = buffer.toString('base64');
    const block = mimetype === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
      : { type: 'image', source: { type: 'base64', media_type: mimetype, data } };
    const res = await client.messages.create({
      model: AI_MODEL,
      max_tokens: 8000,
      messages: [{ role: 'user', content: [block, { type: 'text', text: 'Transcribe all text in this scanned document exactly as written, in reading order. Output only the transcribed text - no commentary. Keep numbers, dates and amounts exact.' }] }],
    });
    const text = res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
    return text || null;
  } catch (err) {
    console.error('[ocr] AI transcription failed:', err.message);
    return null;
  }
}

// ------------------------------------------------------------ public API

// OCR a scanned PDF or an image. opts.allowAi=false keeps it local.
async function recognise(buffer, mimetype, { allowAi = true } = {}) {
  const none = { text: '', method: 'none', confidence: 0, pages: 0 };
  if (!buffer?.length) return none;
  const s = await settings();
  if (!s.enabled) return { ...none, method: 'disabled' };
  const isPdf = mimetype === 'application/pdf' || buffer.subarray(0, 5).toString('latin1') === '%PDF-';
  const type = isPdf ? 'application/pdf' : mimetype || 'image/png';
  if (!isPdf && !/^image\/(png|jpe?g|webp|bmp|gif|tiff?)$/.test(type)) return none;

  let local = { text: '', confidence: 0 };
  let pages = 0;
  let undecodable = 0;
  try {
    let images = [buffer];
    if (isPdf) ({ images, undecodable } = await pdfPageImages(buffer, s.maxPages));
    pages = images.length;
    if (images.length) local = await tesseract(images, s.langs);
  } catch (err) {
    console.error('[ocr] tesseract failed:', err.message);
  }

  const weak = !local.text || local.confidence < s.minConfidence || (undecodable > 0 && !pages);
  if (weak && allowAi && buffer.length < 20 * 1024 * 1024) {
    const ai = await aiTranscribe(buffer, type);
    if (ai) return { text: ai, method: 'ai_vision', confidence: null, pages: pages || undecodable };
  }
  if (!local.text) return { ...none, pages, undecodable };
  return { text: local.text, method: 'tesseract', confidence: local.confidence, pages, undecodable };
}

module.exports = { recognise, pdfPageImages };
