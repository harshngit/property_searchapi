const { Jimp } = require('jimp');
const exifr = require('exifr');
const configService = require('./config.service');

// Image intelligence for every uploaded listing photo (sec. 9.2 / 11.2 /
// Module 19), all pure-JS (no copyleft native libraries):
//   - dimensions + a 64-bit difference hash (dHash) - the image
//     fingerprint behind near-duplicate detection (Hamming distance);
//   - EXIF GPS + capture time - geo-validation and geo-mismatch checks;
//   - contact-detail scan (feature #8): self-hosted Tesseract OCR + regex for
//     phone numbers, emails, addresses, URLs and WhatsApp mentions - a clear
//     read is rejected before upload, a shaky one goes to review; plus a
//     visiting-card shape heuristic. No paid AI: it runs on every upload.

// 64-bit dHash as a signed BIGINT-compatible string.
async function fingerprint(image) {
  const g = image.clone().greyscale().resize({ w: 9, h: 8 });
  const d = g.bitmap.data; // RGBA
  let hash = 0n;
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const left = d[(y * 9 + x) * 4];
      const right = d[(y * 9 + x + 1) * 4];
      hash = (hash << 1n) | (left > right ? 1n : 0n);
    }
  }
  return BigInt.asIntN(64, hash).toString();
}

function hamming(a, b) {
  let x = BigInt.asUintN(64, BigInt(a) ^ BigInt(b));
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

async function readExif(buffer) {
  try {
    const gps = await exifr.gps(buffer);
    const meta = await exifr.parse(buffer, ['DateTimeOriginal', 'Make', 'Model', 'Software']).catch(() => null);
    const text = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 80) : null);
    return {
      lat: gps?.latitude != null ? Number(gps.latitude.toFixed(7)) : null,
      lng: gps?.longitude != null ? Number(gps.longitude.toFixed(7)) : null,
      takenAt: meta?.DateTimeOriginal instanceof Date ? meta.DateTimeOriginal : null,
      // The camera that took it, and any program that saved it afterwards (Module 47).
      make: text(meta?.Make),
      model: text(meta?.Model),
      software: text(meta?.Software),
    };
  } catch {
    return { lat: null, lng: null, takenAt: null, make: null, model: null, software: null };
  }
}

// Visiting cards are ~1.75:1 (90 x 50 mm) and usually small photos.
function looksLikeVisitingCard(width, height) {
  if (!width || !height) return false;
  const ratio = Math.max(width, height) / Math.min(width, height);
  return ratio >= 1.6 && ratio <= 1.9 && Math.max(width, height) <= 1400;
}

// OCR contact scan (self-hosted Tesseract) - image-level blocking (sec. 11.2).
const OCR_PATTERNS = [
  ['phone', /(?<!\d)(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/],
  ['phone', /(?<!\d)0\d{2,4}[\s-]?\d{6,8}(?!\d)/],
  ['email', /[a-z0-9._%+-]{2,}@[a-z0-9-]{2,}\.[a-z]{2,}/i],
  ['url', /\b(?:https?:\/\/|www\.)[a-z0-9-]+\.[a-z]{2,}/i],
  ['whatsapp', /\bwhats\s?app\b/i],
  // A street address: a house / flat / plot / shop number, or a PIN code with its label.
  ['address', /\b(?:h(?:ouse)?\.?\s*no|flat\s*no|plot\s*no|shop\s*no|office\s*no)\.?\s*[:\-]?\s*[a-z]?-?\d+/i],
  ['address', /\b(?:pin(?:\s*code)?|pincode)\s*[:\-]?\s*[1-9]\d{2}\s?\d{3}\b/i],
];
async function ocrContactScan(image) {
  if (!(await configService.getConfig('fraud.image_ocr_scan', true))) return null;
  try {
    const small = image.bitmap.width > 1600 ? image.clone().resize({ w: 1600 }) : image;
    const png = await small.getBuffer('image/png');
    const ocr = await require('./ocr.service').recognise(png, 'image/png');
    if (!ocr.text) return { kinds: [], confidence: 0, textHeavy: false };
    const kinds = [...new Set(OCR_PATTERNS.filter(([, re]) => re.test(ocr.text)).map(([k]) => k))];
    const words = ocr.text.split(/\s+/).filter((w) => /[a-z]{3,}/i.test(w)).length;
    return { kinds, confidence: ocr.confidence || 0, textHeavy: words >= 25 && (ocr.confidence || 0) >= 60 };
  } catch (err) {
    console.error('[imageScan] OCR scan failed:', err.message);
    return null;
  }
}

// Analyse an uploaded image buffer. Returns metadata + a scan verdict:
// 'blocked' (reject the upload), 'flagged' (keep, send to review) or 'clean'.
async function analyse(buffer, { scan = true } = {}) {
  let image;
  try {
    image = await Jimp.read(buffer);
  } catch {
    return { decodable: false, width: null, height: null, phash: null, exif: await readExif(buffer), scan: { status: 'clean', reasons: [] } };
  }
  const width = image.bitmap.width;
  const height = image.bitmap.height;
  const [phash, exif] = await Promise.all([fingerprint(image), readExif(buffer)]);
  const reasons = [];
  let status = 'clean';
  let ocr = null;
  if (scan && (await configService.getConfig('fraud.image_scan_enabled', true))) {
    ocr = await ocrContactScan(image);
    if (ocr?.kinds.length) {
      // Clear read = reject; a shaky read goes to human review instead.
      status = ocr.confidence >= 60 ? 'blocked' : 'flagged';
      reasons.push(`Contact details visible in image: ${ocr.kinds.join(', ')}`);
    } else if (looksLikeVisitingCard(width, height)) {
      status = 'flagged';
      reasons.push('Visiting-card shaped image - check for contact details');
    } else if (ocr?.textHeavy) {
      status = 'flagged';
      reasons.push('Text-heavy image');
    }
  }
  return { decodable: true, width, height, phash, exif, scan: { status, reasons, ai: false, ocr: !!ocr } };
}

module.exports = { analyse, fingerprint, hamming, looksLikeVisitingCard, OCR_PATTERNS };
