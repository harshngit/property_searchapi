const pool = require('../config/db');
const auditService = require('./audit.service');
const { assertCleanContent } = require('../utils/contentGuard');
const { badRequest, notFound } = require('../utils/httpError');

// Testimonials shown on the website home and city pages. Written and
// published by the content team in the CRM (Website Content >
// Testimonials) - the site shows only published ones, in sort order.

const FIELDS = { personName: 'person_name', personRole: 'person_role', city: 'city', quote: 'quote', rating: 'rating', photoUrl: 'photo_url', isPublished: 'is_published', sortOrder: 'sort_order' };

const view = (r) => ({
  id: r.id, personName: r.person_name, personRole: r.person_role, city: r.city, quote: r.quote, rating: r.rating, photoUrl: r.photo_url,
  isPublished: r.is_published, sortOrder: r.sort_order, createdAt: r.created_at, updatedAt: r.updated_at,
});

// Public: published only; a city's own testimonials come first on its page.
async function listPublished({ city, limit = 8 } = {}) {
  const r = await pool.query(
    `SELECT * FROM testimonials WHERE is_published
     ORDER BY ($1::text IS NOT NULL AND lower(city) = lower($1::text)) DESC, sort_order ASC, created_at DESC LIMIT $2`,
    [city || null, Math.min(24, Math.max(1, Number(limit) || 8))]
  );
  return r.rows.map(({ id, person_name, person_role, city: c, quote, rating, photo_url }) => ({ id, personName: person_name, personRole: person_role, city: c, quote, rating, photoUrl: photo_url }));
}

async function listAll() {
  return (await pool.query('SELECT * FROM testimonials ORDER BY is_published DESC, sort_order ASC, created_at DESC LIMIT 500')).rows.map(view);
}

async function save(user, id, data, meta = {}) {
  // Same content rules as listings: no contact details, no forbidden terms.
  await assertCleanContent({ quote: data.quote, personRole: data.personRole }, { blockContact: true });
  if (data.photoUrl && !/^https:\/\//i.test(data.photoUrl) && !/^\/[a-zA-Z0-9]/.test(data.photoUrl)) throw badRequest('Photo must be an https link');
  const cols = Object.entries(FIELDS).filter(([k]) => data[k] !== undefined);
  if (!id) {
    if (!data.personName || !data.quote) throw badRequest('Name and quote are required');
    const r = await pool.query(
      `INSERT INTO testimonials (${cols.map(([, c]) => c).join(', ')}, created_by) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}, $${cols.length + 1}) RETURNING *`,
      [...cols.map(([k]) => data[k]), user.id]
    );
    await auditService.log({ actor: user, action: 'testimonial.created', entityType: 'testimonial', entityId: r.rows[0].id, after: view(r.rows[0]), ...meta });
    return view(r.rows[0]);
  }
  if (!cols.length) throw badRequest('Nothing to update');
  const r = await pool.query(`UPDATE testimonials SET ${cols.map(([, c], i) => `${c} = $${i + 1}`).join(', ')} WHERE id = $${cols.length + 1} RETURNING *`, [...cols.map(([k]) => data[k]), id]);
  if (!r.rows[0]) throw notFound('Testimonial not found');
  await auditService.log({ actor: user, action: 'testimonial.updated', entityType: 'testimonial', entityId: id, after: view(r.rows[0]), ...meta });
  return view(r.rows[0]);
}

async function remove(user, id, meta = {}) {
  const r = await pool.query('DELETE FROM testimonials WHERE id = $1 RETURNING id', [id]);
  if (!r.rows[0]) throw notFound('Testimonial not found');
  await auditService.log({ actor: user, action: 'testimonial.deleted', entityType: 'testimonial', entityId: id, ...meta });
  return { id };
}

module.exports = { listPublished, listAll, save, remove };
