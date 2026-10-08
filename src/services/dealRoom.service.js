const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');
const pool = require('../config/db');
const configService = require('./config.service');
const notificationService = require('./notification.service');
const auditService = require('./audit.service');
const { getAccess } = require('./opportunity.service');
const { uploadBuffer, generateSignedReadUrl, toObjectPath } = require('../utils/storage');
const { getBucket } = require('../config/gcs');
const { badRequest, forbidden, notFound } = require('../utils/httpError');

// Module 39 - Advanced Deal Room. See migration 026 for the rules. Staff
// (internal_sales / admin / super_admin) manage rooms and always have
// access; everyone else needs: verified buyer + signed NDA + admin approval.

const STAFF_ROLES = ['internal_sales', 'admin', 'super_admin'];
const isStaff = (user) => !!user && STAFF_ROLES.includes(user.role);

async function getNda() {
  return configService.getConfig('deal_room.nda', { version: '1.0', title: 'Confidentiality Undertaking', text: '' });
}

async function getDeal(propertyId) {
  const result = await pool.query(
    `SELECT id, title, listing_category, city, locality, status, is_institutional_asset FROM properties WHERE id = $1`,
    [propertyId]
  );
  if (!result.rows[0]) throw notFound('Deal not found');
  return result.rows[0];
}

async function log(entry, client = pool) {
  await client.query(
    `INSERT INTO deal_room_access_log (property_id, document_id, version_id, user_id, action, ip_address, user_agent, device_fingerprint)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      entry.propertyId,
      entry.documentId || null,
      entry.versionId || null,
      entry.userId || null,
      entry.action,
      entry.ip || null,
      entry.userAgent ? String(entry.userAgent).slice(0, 500) : null,
      entry.fingerprint ? String(entry.fingerprint).slice(0, 128) : null,
    ]
  );
}

async function getAccessRecord(propertyId, userId) {
  const result = await pool.query('SELECT * FROM deal_room_access WHERE property_id = $1 AND user_id = $2', [propertyId, userId]);
  return result.rows[0] || null;
}

// The three conditions, evaluated fresh on every request.
async function evaluate(propertyId, user) {
  if (isStaff(user)) return { verified: true, ndaSigned: true, approved: true, open: true, staff: true, record: null };
  const buyer = await getAccess(user);
  // Institutional assets (sec. 11.3): the "verified buyer" gate is the
  // institutional buyer qualification (buyer type + financial capacity).
  const institutional = (await pool.query('SELECT 1 FROM institutional_listings WHERE property_id = $1', [propertyId])).rows.length > 0;
  if (institutional) {
    const qualified = await require('./institutional.service').isQualifiedBuyer(user.id);
    buyer.full = qualified;
    buyer.reason = qualified ? null : 'Complete your institutional buyer profile and wait for it to be verified before signing the NDA';
  }
  const record = await getAccessRecord(propertyId, user.id);
  const expired = record?.access_expires_at && new Date(record.access_expires_at) < new Date();
  const approved = record?.status === 'approved' && !expired;
  return {
    verified: buyer.full,
    verifiedReason: buyer.full ? null : buyer.reason,
    ndaSigned: !!record,
    approved,
    expired: !!expired,
    status: record ? (expired ? 'expired' : record.status) : 'not_requested',
    decisionReason: record?.decision_reason || null,
    open: buyer.full && !!record && approved,
    record,
    profile: buyer.profile,
  };
}

const DOC_COLUMNS = `d.id, d.title, d.document_type, d.description, d.download_allowed, d.watermark, d.expires_at, d.created_at`;

// Buyer view of a room: status of the three gates, the NDA, and - only once
// all three pass - the documents (latest approved version metadata, no URL).
async function getRoom(propertyId, user) {
  const deal = await getDeal(propertyId);
  const gates = await evaluate(propertyId, user);
  const nda = await getNda();
  let documents = [];
  const counts = await pool.query(
    `SELECT COUNT(*)::int AS n FROM deal_room_documents d
     WHERE d.property_id = $1 AND d.is_active AND (d.expires_at IS NULL OR d.expires_at > now())
       AND EXISTS (SELECT 1 FROM deal_room_document_versions v WHERE v.document_id = d.id AND v.status = 'approved')`,
    [propertyId]
  );
  if (gates.open) {
    const result = await pool.query(
      `SELECT ${DOC_COLUMNS}, v.id AS version_id, v.version, v.file_name, v.mime_type, v.size_bytes, v.approved_at AS version_date
       FROM deal_room_documents d
       JOIN LATERAL (SELECT * FROM deal_room_document_versions v WHERE v.document_id = d.id AND v.status = 'approved'
                     ORDER BY v.version DESC LIMIT 1) v ON true
       WHERE d.property_id = $1 AND d.is_active AND (d.expires_at IS NULL OR d.expires_at > now())
       ORDER BY d.created_at ASC`,
      [propertyId]
    );
    documents = result.rows;
  }
  return {
    deal: { id: deal.id, title: deal.listing_category === 'institutional' && !gates.open ? null : deal.title, listing_category: deal.listing_category },
    access: {
      verified: gates.verified,
      verifiedReason: gates.verifiedReason || null,
      ndaSigned: gates.ndaSigned,
      approved: gates.approved,
      status: gates.staff ? 'staff' : gates.status,
      decisionReason: gates.decisionReason || null,
      expiresAt: gates.record?.access_expires_at || null,
      open: gates.open,
    },
    nda,
    documentCount: counts.rows[0].n,
    documents,
  };
}

// Signing the NDA creates the access request; an admin then approves it.
async function signNda(propertyId, user, { fullName, accept }, meta = {}) {
  const deal = await getDeal(propertyId);
  if (isStaff(user)) throw badRequest('Staff already have access to deal rooms');
  if (!accept) throw badRequest('Please accept the confidentiality undertaking');
  const gates = await evaluate(propertyId, user);
  if (!gates.verified) throw forbidden(gates.verifiedReason || 'A verified investor profile is required');
  const nda = await getNda();
  const result = await pool.query(
    `INSERT INTO deal_room_access (property_id, user_id, investor_profile_id, status, nda_version, nda_signed_name, nda_signed_at, nda_ip, nda_user_agent)
     VALUES ($1, $2, $3, 'pending_approval', $4, $5, now(), $6, $7)
     ON CONFLICT (property_id, user_id) DO UPDATE
       SET nda_version = EXCLUDED.nda_version, nda_signed_name = EXCLUDED.nda_signed_name, nda_signed_at = now(),
           nda_ip = EXCLUDED.nda_ip, nda_user_agent = EXCLUDED.nda_user_agent,
           status = CASE WHEN deal_room_access.status IN ('rejected', 'revoked') OR deal_room_access.access_expires_at < now()
                         THEN 'pending_approval' ELSE deal_room_access.status END,
           decision_reason = CASE WHEN deal_room_access.status IN ('rejected', 'revoked') THEN NULL ELSE deal_room_access.decision_reason END
     RETURNING *`,
    [propertyId, user.id, gates.profile?.id || null, nda.version, String(fullName).trim(), meta.ip || null, meta.userAgent || null]
  );
  await log({ propertyId, userId: user.id, action: 'nda_signed', ip: meta.ip, userAgent: meta.userAgent });
  await auditService.log({ actor: user, action: 'deal_room.nda_signed', entityType: 'deal_room_access', entityId: result.rows[0].id, after: { propertyId, ndaVersion: nda.version }, ...meta });

  // Tell the staff who can approve it.
  const staff = await pool.query(
    `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name IN ('admin', 'super_admin') AND u.status = 'active'`
  );
  for (const s of staff.rows) {
    await notificationService.createNotification({
      userId: s.id,
      type: 'deal_room_request',
      title: 'Deal room access requested',
      message: `${fullName} signed the NDA for "${deal.title}" and is waiting for approval.`,
      relatedEntityType: 'property',
      relatedEntityId: propertyId,
    });
  }
  // Engine 7 pipeline: NDA executed -> stage 3.
  await require('./institutional.service').evaluateBuyerDeals(user.id, propertyId).catch(() => {});
  return getRoom(propertyId, user);
}

// Stamps every page of a PDF with the viewer's identity (diagonal, faint)
// plus a footer line, so a leaked copy is traceable.
async function watermarkPdf(buffer, label) {
  const pdf = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const page of pdf.getPages()) {
    const { width, height } = page.getSize();
    const size = Math.max(14, Math.min(width, height) / 22);
    page.drawText(label, {
      x: width * 0.12,
      y: height * 0.3,
      size,
      font,
      color: rgb(0.85, 0.1, 0.13),
      opacity: 0.16,
      rotate: degrees(35),
    });
    page.drawText(`Confidential - ${label}`, { x: 24, y: 14, size: 8, font, color: rgb(0.4, 0.4, 0.4), opacity: 0.8 });
  }
  return Buffer.from(await pdf.save());
}

// GET /deal-room/documents/:id/url - the only way to read a document: all
// three gates re-checked, 15-minute signed URL, every generation logged.
// PDFs marked for watermarking are served as a per-viewer watermarked copy.
async function getDocumentUrl(documentId, user, { purpose = 'view', fingerprint } = {}, meta = {}) {
  const docResult = await pool.query(
    `SELECT d.*, v.id AS version_id, v.object_path, v.file_name, v.mime_type
     FROM deal_room_documents d
     JOIN LATERAL (SELECT * FROM deal_room_document_versions v WHERE v.document_id = d.id AND v.status = 'approved'
                   ORDER BY v.version DESC LIMIT 1) v ON true
     WHERE d.id = $1 AND d.is_active`,
    [documentId]
  );
  const doc = docResult.rows[0];
  if (!doc) throw notFound('Document not found');
  if (doc.expires_at && new Date(doc.expires_at) < new Date() && !isStaff(user)) throw forbidden('This document is no longer available');

  const gates = await evaluate(doc.property_id, user);
  if (!gates.open) throw forbidden('Deal room access requires a verified profile, a signed NDA and admin approval');

  const base = { propertyId: doc.property_id, documentId: doc.id, versionId: doc.version_id, userId: user.id, ip: meta.ip, userAgent: meta.userAgent, fingerprint };
  if (purpose === 'download' && !doc.download_allowed && !isStaff(user)) {
    await log({ ...base, action: 'download_blocked' });
    throw forbidden('Downloading this document is not allowed - you can view it in the deal room');
  }

  let objectPath = toObjectPath(doc.object_path);
  const isPdf = (doc.mime_type || '').includes('pdf') || /\.pdf$/i.test(doc.file_name || '');
  if (doc.watermark && isPdf && !isStaff(user)) {
    const account = await pool.query('SELECT full_name, email, mobile FROM users WHERE id = $1', [user.id]);
    const who = account.rows[0] || {};
    const label = `${who.full_name || 'Viewer'} | ${who.email || who.mobile || user.id} | ${new Date().toISOString().slice(0, 10)}`;
    const watermarkedPath = `deal-room/watermarked/${user.id}/${doc.version_id}.pdf`;
    const [exists] = await getBucket().file(watermarkedPath).exists();
    if (!exists) {
      const [original] = await getBucket().file(objectPath).download();
      const stamped = await watermarkPdf(original, label);
      await getBucket().file(watermarkedPath).save(stamped, { resumable: false, contentType: 'application/pdf' });
    }
    objectPath = watermarkedPath;
  }

  const ttlMinutes = Number(await configService.getConfig('deal_room.presigned_url_ttl_minutes', 15)) || 15;
  const url = await generateSignedReadUrl(objectPath, ttlMinutes * 60 * 1000);
  await log({ ...base, action: 'url_generated' });
  await log({ ...base, action: purpose === 'download' ? 'downloaded' : 'viewed' });
  return { url, expiresInMinutes: ttlMinutes, fileName: doc.file_name, mimeType: doc.mime_type, watermarked: objectPath.startsWith('deal-room/watermarked/') };
}

// ------------------------------------------------------------------ staff

async function getRoomForStaff(propertyId) {
  const deal = await getDeal(propertyId);
  const [docs, versions, access, stats] = await Promise.all([
    pool.query(`SELECT d.*, u.full_name AS created_by_name FROM deal_room_documents d LEFT JOIN users u ON u.id = d.created_by
                WHERE d.property_id = $1 ORDER BY d.created_at ASC`, [propertyId]),
    pool.query(
      `SELECT v.id, v.document_id, v.version, v.file_name, v.mime_type, v.size_bytes, v.status, v.notes, v.created_at, v.approved_at,
              up.full_name AS uploaded_by_name, ap.full_name AS approved_by_name
       FROM deal_room_document_versions v
       JOIN deal_room_documents d ON d.id = v.document_id
       LEFT JOIN users up ON up.id = v.uploaded_by
       LEFT JOIN users ap ON ap.id = v.approved_by
       WHERE d.property_id = $1 ORDER BY v.version DESC`,
      [propertyId]
    ),
    listAccess({ propertyId }),
    pool.query(
      `SELECT action, COUNT(*)::int AS n FROM deal_room_access_log WHERE property_id = $1 GROUP BY action`,
      [propertyId]
    ),
  ]);
  return {
    deal,
    documents: docs.rows.map((d) => ({ ...d, versions: versions.rows.filter((v) => v.document_id === d.id) })),
    access,
    activity: Object.fromEntries(stats.rows.map((r) => [r.action, r.n])),
  };
}

async function addDocument(propertyId, file, data, user, meta = {}) {
  await getDeal(propertyId);
  if (!file) throw badRequest('Choose a file to upload');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const doc = await client.query(
      `INSERT INTO deal_room_documents (property_id, title, document_type, description, download_allowed, watermark, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        propertyId,
        data.title || file.originalname,
        data.documentType || 'other',
        data.description || null,
        String(data.downloadAllowed) === 'true',
        String(data.watermark) !== 'false',
        data.expiresAt || null,
        user.id,
      ]
    );
    await client.query('COMMIT');
    await addVersion(doc.rows[0].id, file, { notes: data.notes }, user, meta);
    return doc.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// A new version is approved immediately when an admin uploads it; versions
// from other staff wait for admin approval. Buyers only see approved ones.
async function addVersion(documentId, file, { notes } = {}, user, meta = {}) {
  if (!file) throw badRequest('Choose a file to upload');
  const doc = await pool.query('SELECT * FROM deal_room_documents WHERE id = $1', [documentId]);
  if (!doc.rows[0]) throw notFound('Document not found');
  const objectPath = await uploadBuffer(file.buffer, `deal-room/${doc.rows[0].property_id}/${documentId}`, file.originalname, file.mimetype);
  const autoApprove = ['admin', 'super_admin'].includes(user.role);
  const next = await pool.query('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM deal_room_document_versions WHERE document_id = $1', [documentId]);
  const result = await pool.query(
    `INSERT INTO deal_room_document_versions (document_id, version, object_path, file_name, mime_type, size_bytes, status, notes, uploaded_by, approved_by, approved_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [
      documentId,
      next.rows[0].v,
      objectPath,
      file.originalname,
      file.mimetype,
      file.size,
      autoApprove ? 'approved' : 'pending',
      notes || null,
      user.id,
      autoApprove ? user.id : null,
      autoApprove ? new Date() : null,
    ]
  );
  await log({ propertyId: doc.rows[0].property_id, documentId, versionId: result.rows[0].id, userId: user.id, action: 'uploaded', ip: meta.ip, userAgent: meta.userAgent });
  return result.rows[0];
}

async function approveVersion(versionId, user, meta = {}) {
  const result = await pool.query(
    `UPDATE deal_room_document_versions SET status = 'approved', approved_by = $1, approved_at = now()
     WHERE id = $2 AND status <> 'approved' RETURNING *`,
    [user.id, versionId]
  );
  if (!result.rows[0]) throw badRequest('Version not found or already approved');
  const doc = await pool.query('SELECT property_id FROM deal_room_documents WHERE id = $1', [result.rows[0].document_id]);
  await log({ propertyId: doc.rows[0].property_id, documentId: result.rows[0].document_id, versionId, userId: user.id, action: 'version_approved', ip: meta.ip, userAgent: meta.userAgent });
  return result.rows[0];
}

const DOC_SETTINGS = { title: 'title', documentType: 'document_type', description: 'description', downloadAllowed: 'download_allowed', watermark: 'watermark', expiresAt: 'expires_at', isActive: 'is_active' };

async function updateDocument(documentId, data) {
  const set = [];
  const params = [];
  for (const [key, col] of Object.entries(DOC_SETTINGS)) {
    if (data[key] !== undefined) {
      params.push(data[key] === '' ? null : data[key]);
      set.push(`${col} = $${params.length}`);
    }
  }
  if (!set.length) throw badRequest('Nothing to update');
  params.push(documentId);
  const result = await pool.query(`UPDATE deal_room_documents SET ${set.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
  if (!result.rows[0]) throw notFound('Document not found');
  return result.rows[0];
}

async function listAccess({ propertyId, status } = {}) {
  const where = [];
  const params = [];
  if (propertyId) {
    params.push(propertyId);
    where.push(`a.property_id = $${params.length}`);
  }
  if (status) {
    params.push(status);
    where.push(`a.status = $${params.length}`);
  }
  const result = await pool.query(
    `SELECT a.*, u.full_name, u.email, u.mobile, r.name AS role,
            ip.verification_status, ip.is_nri, ip.is_hni,
            p.title AS property_title, p.listing_category, p.city,
            dec.full_name AS decided_by_name,
            (SELECT COUNT(*) FROM deal_room_access_log l WHERE l.property_id = a.property_id AND l.user_id = a.user_id AND l.action IN ('viewed', 'downloaded'))::int AS document_opens
     FROM deal_room_access a
     JOIN users u ON u.id = a.user_id
     JOIN roles r ON r.id = u.role_id
     JOIN properties p ON p.id = a.property_id
     LEFT JOIN investor_profiles ip ON ip.id = a.investor_profile_id
     LEFT JOIN users dec ON dec.id = a.decided_by
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY (a.status = 'pending_approval') DESC, a.updated_at DESC
     LIMIT 200`,
    params
  );
  return result.rows;
}

async function decideAccess(accessId, { action, reason }, user, meta = {}) {
  const statusFor = { approve: 'approved', reject: 'rejected', revoke: 'revoked' };
  if (!statusFor[action]) throw badRequest('Unknown action');
  if (action !== 'approve' && !reason) throw badRequest('Give a reason');
  const validityDays = Number(await configService.getConfig('deal_room.access_validity_days', 90)) || 0;
  const result = await pool.query(
    `UPDATE deal_room_access
     SET status = $1::varchar, decided_by = $2, decided_at = now(), decision_reason = $3,
         access_expires_at = CASE WHEN $1::varchar = 'approved' AND $4::int > 0 THEN now() + ($4::int || ' days')::interval
                                  WHEN $1::varchar = 'approved' THEN NULL ELSE access_expires_at END
     WHERE id = $5 RETURNING *`,
    [statusFor[action], user.id, reason || null, validityDays, accessId]
  );
  const access = result.rows[0];
  if (!access) throw notFound('Access request not found');
  const deal = await getDeal(access.property_id);
  await log({ propertyId: access.property_id, userId: access.user_id, action: `access_${statusFor[action]}`, ip: meta.ip, userAgent: meta.userAgent });
  await auditService.log({ actor: user, action: `deal_room.access_${statusFor[action]}`, entityType: 'deal_room_access', entityId: accessId, after: { reason }, ...meta });
  await notificationService.createNotification({
    userId: access.user_id,
    type: 'deal_room',
    title: action === 'approve' ? 'Deal room unlocked' : action === 'reject' ? 'Deal room request declined' : 'Deal room access ended',
    message:
      action === 'approve'
        ? `You can now view the documents for "${deal.title}".`
        : `Your access to the documents for "${deal.title}" was ${statusFor[action]}${reason ? `: ${reason}` : ''}.`,
    relatedEntityType: 'deal',
    relatedEntityId: access.property_id,
  });
  // Engine 7 pipeline: access approved -> stage 4 (Data Room Access).
  await require('./institutional.service').evaluateBuyerDeals(access.user_id, access.property_id).catch(() => {});
  return access;
}

async function listLog(propertyId, { limit = 500 } = {}) {
  const result = await pool.query(
    `SELECT l.*, u.full_name AS user_name, u.email AS user_email, d.title AS document_title, v.version
     FROM deal_room_access_log l
     LEFT JOIN users u ON u.id = l.user_id
     LEFT JOIN deal_room_documents d ON d.id = l.document_id
     LEFT JOIN deal_room_document_versions v ON v.id = l.version_id
     WHERE l.property_id = $1
     ORDER BY l.created_at DESC LIMIT $2`,
    [propertyId, Math.min(Number(limit) || 500, 5000)]
  );
  return result.rows;
}

function logToCsv(rows) {
  const esc = (v) => (v == null ? '' : `"${String(v).replace(/"/g, '""')}"`);
  const header = ['time', 'user', 'email', 'action', 'document', 'version', 'ip', 'user_agent', 'device'];
  const lines = rows.map((r) =>
    [r.created_at.toISOString(), r.user_name, r.user_email, r.action, r.document_title, r.version, r.ip_address, r.user_agent, r.device_fingerprint].map(esc).join(',')
  );
  return [header.join(','), ...lines].join('\n');
}

// Deals that have a deal room, for the CRM overview.
async function listRooms() {
  const result = await pool.query(
    `SELECT p.id, p.title, p.listing_category, p.city, p.status,
            COUNT(DISTINCT d.id)::int AS documents,
            COUNT(DISTINCT a.id) FILTER (WHERE a.status = 'pending_approval')::int AS pending_requests,
            COUNT(DISTINCT a.id) FILTER (WHERE a.status = 'approved')::int AS approved_users
     FROM properties p
     LEFT JOIN deal_room_documents d ON d.property_id = p.id AND d.is_active
     LEFT JOIN deal_room_access a ON a.property_id = p.id
     WHERE d.id IS NOT NULL OR a.id IS NOT NULL
     GROUP BY p.id ORDER BY pending_requests DESC, p.title`
  );
  return result.rows;
}

module.exports = {
  isStaff,
  evaluate,
  getRoom,
  signNda,
  getDocumentUrl,
  getRoomForStaff,
  addDocument,
  addVersion,
  approveVersion,
  updateDocument,
  listAccess,
  decideAccess,
  listLog,
  logToCsv,
  listRooms,
  watermarkPdf,
};
