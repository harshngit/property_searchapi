const path = require('path');
const { randomUUID } = require('crypto');
const { getBucket } = require('../config/gcs');

const SIGNED_URL_TTL_MS = 60 * 60 * 1000; // 1 hour

// The bucket is private (Public Access Prevention is on), so every read URL
// handed to the frontend has to be a short-lived V4 signed URL generated on
// demand - never a bare `storage.googleapis.com/...` URL, which the browser
// would get AccessDenied on for an anonymous request.

// Uploads a buffer to GCS under `<folder>/<uuid><ext>` and returns the
// *object path* (not a URL) - that's what callers should store in Postgres.
// Signed, browsable URLs are generated separately, at read time, by
// getReadUrl()/signUrls() below.
async function uploadBuffer(buffer, folder, originalName, mimetype) {
  const ext = path.extname(originalName || '');
  const objectPath = `${folder}/${randomUUID()}${ext}`;

  await getBucket().file(objectPath).save(buffer, {
    resumable: false,
    contentType: mimetype,
  });

  return objectPath;
}

// Accepts whatever shape happens to be stored in the DB - a bare object path
// (new uploads), a legacy `https://storage.googleapis.com/<bucket>/...` URL,
// a virtual-hosted-style `https://<bucket>.storage.googleapis.com/...` URL,
// or a `gs://<bucket>/...` URI - and normalizes it down to the object path
// relative to *our* configured bucket. Returns null for anything that isn't
// one of ours (a different bucket, or a fully external URL, e.g. a
// pre-hosted media link added via /properties/:id/media) - those are left
// untouched by the caller rather than "signed" into nonsense.
function toObjectPath(stored) {
  if (!stored || typeof stored !== 'string') return null;

  const bucketName = process.env.GCS_BUCKET_NAME;
  if (!bucketName) return null;

  if (stored.startsWith(`gs://${bucketName}/`)) {
    return stored.slice(`gs://${bucketName}/`.length);
  }

  const pathStylePrefix = `https://storage.googleapis.com/${bucketName}/`;
  if (stored.startsWith(pathStylePrefix)) {
    return decodeURIComponent(stored.slice(pathStylePrefix.length));
  }

  const virtualHostedPrefix = `https://${bucketName}.storage.googleapis.com/`;
  if (stored.startsWith(virtualHostedPrefix)) {
    return decodeURIComponent(stored.slice(virtualHostedPrefix.length));
  }

  // Not an absolute URL at all - treat it as already being a bare object
  // path (the format new uploads store going forward).
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(stored)) {
    return stored;
  }

  // Some other absolute URL (different bucket, or a fully external host) -
  // not ours to sign.
  return null;
}

// The reusable signing primitive. `objectPath` must already be relative to
// GCS_BUCKET_NAME (use toObjectPath()/getReadUrl() if you have a stored
// value that might be in another format).
async function generateSignedReadUrl(objectPath, expiresInMs = SIGNED_URL_TTL_MS) {
  const [url] = await getBucket()
    .file(objectPath)
    .getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + expiresInMs,
    });

  return url;
}

// Takes whatever is stored in the DB for a single file field and returns a
// fresh signed URL - or the original value unchanged if it isn't one of our
// GCS objects (external URL), or null if signing itself fails (deleted
// object, bad IAM permissions, etc). Never throws - a broken image is far
// better than a 500 on the whole API response.
async function getReadUrl(stored) {
  if (!stored) return stored;

  const objectPath = toObjectPath(stored);
  if (!objectPath) return stored;

  try {
    return await generateSignedReadUrl(objectPath);
  } catch (err) {
    console.error(`[storage] Failed to sign read URL for object "${objectPath}": ${err.message}`);
    return null;
  }
}

// Signs a single field across an array of rows (or a single row) in place,
// concurrently. Returns the same shape it was given - array in, array out;
// object in, object out.
async function signUrls(rowsOrRow, field) {
  if (Array.isArray(rowsOrRow)) {
    return Promise.all(
      rowsOrRow.map(async (row) => (row ? { ...row, [field]: await getReadUrl(row[field]) } : row))
    );
  }
  if (!rowsOrRow) return rowsOrRow;
  return { ...rowsOrRow, [field]: await getReadUrl(rowsOrRow[field]) };
}

// Best-effort delete of a previously uploaded object, given whatever value
// is stored in the DB for it (object path, legacy full URL, or gs:// URI).
// Silently no-ops on values that aren't one of ours (e.g. an externally
// hosted URL added via the "attach pre-hosted media" endpoint) and swallows
// "already gone" errors.
async function deleteObject(stored) {
  const objectPath = toObjectPath(stored);
  if (!objectPath) return;

  try {
    await getBucket().file(objectPath).delete();
  } catch (err) {
    if (err.code !== 404) throw err;
  }
}

// Reads one of our stored objects back as a Buffer (null when it is not ours
// or cannot be read) - e.g. to show stored photos to a model on request.
async function downloadBuffer(stored) {
  const objectPath = toObjectPath(stored);
  if (!objectPath) return null;
  try {
    const [buf] = await getBucket().file(objectPath).download();
    return buf;
  } catch (err) {
    console.error(`[storage] Failed to read object "${objectPath}": ${err.message}`);
    return null;
  }
}

module.exports = { uploadBuffer, deleteObject, generateSignedReadUrl, getReadUrl, signUrls, toObjectPath, downloadBuffer };
