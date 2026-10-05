const Anthropic = require('@anthropic-ai/sdk');
const { Jimp } = require('jimp');
const exifr = require('exifr');
const configService = require('./config.service');

// Image intelligence for every uploaded listing photo (sec. 9.2 / 11.2 /
// Module 19), all pure-JS (no copyleft native libraries):
//   - dimensions + a 64-bit difference hash (dHash) - the image
//     fingerprint behind near-duplicate detection (Hamming distance);
//   - EXIF GPS + capture time - geo-validation and geo-mismatch checks;
//   - contact-detail scan: an AI vision check (when ANTHROPIC_API_KEY is
//     set) for phone numbers, emails, addresses, URLs / QR codes and
//     visiting cards - these images are rejected before upload; without
//     the AI, a visiting-card shape heuristic flags images for review.

const AI_MODEL = 'claude-sonnet-5';
const aiClient = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

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
    const meta = await exifr.parse(buffer, ['DateTimeOriginal']).catch(() => null);
    return {
      lat: gps?.latitude != null ? Number(gps.latitude.toFixed(7)) : null,
      lng: gps?.longitude != null ? Number(gps.longitude.toFixed(7)) : null,
      takenAt: meta?.DateTimeOriginal instanceof Date ? meta.DateTimeOriginal : null,
    };
  } catch {
    return { lat: null, lng: null, takenAt: null };
  }
}

// Visiting cards are ~1.75:1 (90 x 50 mm) and usually small photos.
function looksLikeVisitingCard(width, height) {
  if (!width || !height) return false;
  const ratio = Math.max(width, height) / Math.min(width, height);
  return ratio >= 1.6 && ratio <= 1.9 && Math.max(width, height) <= 1400;
}

async function aiContactScan(image) {
  if (!aiClient) return null;
  try {
    const small = image.bitmap.width > 1024 ? image.clone().resize({ w: 1024 }) : image.clone();
    const jpeg = await small.getBuffer('image/jpeg', { quality: 80 });
    const response = await aiClient.messages.create({
      model: AI_MODEL,
      max_tokens: 300,
      output_config: {
        effort: 'low',
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              contains_contact_info: { type: 'boolean' },
              kinds: { type: 'array', items: { type: 'string', enum: ['phone', 'email', 'address', 'url', 'qr_code', 'whatsapp', 'social_handle'] } },
              is_visiting_card: { type: 'boolean' },
              text_heavy: { type: 'boolean' },
            },
            required: ['contains_contact_info', 'kinds', 'is_visiting_card', 'text_heavy'],
            additionalProperties: false,
          },
        },
      },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } },
            {
              type: 'text',
              text:
                'This photo was uploaded to a real-estate listing. Contact details must never appear in listing photos. ' +
                'Does the image show any readable phone number, email address, street address, website URL, QR code, WhatsApp / social handle, or is it a visiting card? ' +
                'Watermarks of the property photo itself are fine unless they contain contact details.',
            },
          ],
        },
      ],
    });
    const block = response.content.find((b) => b.type === 'text');
    return block ? JSON.parse(block.text) : null;
  } catch (err) {
    console.error('[imageScan] AI scan failed:', err.message);
    return null;
  }
}

// OCR contact scan (Tesseract) - used when the AI vision check is not
// configured, so image-level blocking is live either way (sec. 11.2).
const OCR_PATTERNS = [
  ['phone', /(?<!\d)(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/],
  ['email', /[a-z0-9._%+-]{2,}@[a-z0-9-]{2,}\.[a-z]{2,}/i],
  ['url', /\b(?:https?:\/\/|www\.)[a-z0-9-]+\.[a-z]{2,}/i],
  ['whatsapp', /\bwhats\s?app\b/i],
];
async function ocrContactScan(image) {
  if (!(await configService.getConfig('fraud.image_ocr_scan', true))) return null;
  try {
    const small = image.bitmap.width > 1600 ? image.clone().resize({ w: 1600 }) : image;
    const png = await small.getBuffer('image/png');
    const ocr = await require('./ocr.service').recognise(png, 'image/png', { allowAi: false });
    if (!ocr.text) return { kinds: [], confidence: 0, textHeavy: false };
    const kinds = OCR_PATTERNS.filter(([, re]) => re.test(ocr.text)).map(([k]) => k);
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
    const ai = await aiContactScan(image);
    if (ai?.contains_contact_info || ai?.is_visiting_card) {
      status = 'blocked';
      if (ai.is_visiting_card) reasons.push('Image looks like a visiting card');
      if (ai.kinds?.length) reasons.push(`Contact details visible in image: ${ai.kinds.join(', ')}`);
    } else if (!ai && (ocr = await ocrContactScan(image)) && ocr.kinds.length) {
      // Clear read = reject; a shaky read goes to human review instead.
      status = ocr.confidence >= 60 ? 'blocked' : 'flagged';
      reasons.push(`Contact details visible in image: ${ocr.kinds.join(', ')}`);
    } else if (!ai && looksLikeVisitingCard(width, height)) {
      status = 'flagged';
      reasons.push('Visiting-card shaped image - check for contact details');
    } else if (ai?.text_heavy || ocr?.textHeavy) {
      status = 'flagged';
      reasons.push('Text-heavy image');
    }
  }
  return { decodable: true, width, height, phash, exif, scan: { status, reasons, ai: !!aiClient, ocr: !!ocr } };
}

module.exports = { analyse, fingerprint, hamming, looksLikeVisitingCard };
