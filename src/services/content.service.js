const pool = require('../config/db');
const configService = require('./config.service');
const auditService = require('./audit.service');
const { assertCleanContent } = require('../utils/contentGuard');
const { parsePagination, buildPagination } = require('../utils/pagination');
const { signUrls } = require('../utils/storage');
const { slugify } = require('./masterData.service');
const { badRequest, notFound, unprocessable } = require('../utils/httpError');

// Module 16 (SEO & Blog / Content Authority) and sec. 21.2 city landing
// pages. Everything here is CMS data - no article, city page, or template
// text lives in code, and all copy passes the brand/forbidden-term guard.

const ARTICLE_FIELDS = {
  slug: 'slug',
  title: 'title',
  excerpt: 'excerpt',
  contentHtml: 'content_html',
  coverImageUrl: 'cover_image_url',
  category: 'category',
  tags: 'tags',
  authorName: 'author_name',
  readingMinutes: 'reading_minutes',
  seoTitle: 'seo_title',
  seoDescription: 'seo_description',
  schemaType: 'schema_type',
  faqs: 'faqs',
  isFeatured: 'is_featured',
  status: 'status',
};

const CITY_PAGE_FIELDS = {
  cityId: 'city_id',
  slug: 'slug',
  pageType: 'page_type',
  title: 'title',
  heroHeading: 'hero_heading',
  heroSubheading: 'hero_subheading',
  contentHtml: 'content_html',
  faqs: 'faqs',
  seoTitle: 'seo_title',
  seoDescription: 'seo_description',
  status: 'status',
};

const JSON_COLUMNS = new Set(['tags', 'faqs']);
const GUARDED_KEYS = ['title', 'excerpt', 'contentHtml', 'seoTitle', 'seoDescription', 'faqs', 'heroHeading', 'heroSubheading', 'tags'];

// Estimated reading time from the article body (~200 words/minute).
function estimateReadingMinutes(html) {
  const words = String(html || '').replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

async function guard(data) {
  const fields = Object.fromEntries(GUARDED_KEYS.filter((k) => data[k] != null).map((k) => [k, data[k]]));
  if (Object.keys(fields).length) await assertCleanContent(fields);
}

function translateUniqueViolation(err, what) {
  if (err.code === '23505') return unprocessable(`A ${what} with this slug already exists`, [{ detail: err.detail }]);
  return err;
}

// Cover images may be uploaded objects (signed per request) or site-relative
// paths like "/images/seo1.png" bundled with the website (left as-is).
async function signCover(rows) {
  const sign = async (row) =>
    row && row.cover_image_url && !String(row.cover_image_url).startsWith('/') ? signUrls(row, 'cover_image_url') : row;
  return Array.isArray(rows) ? Promise.all(rows.map(sign)) : sign(rows);
}

// ---------------------------------------------------------------------
// Articles - public
// ---------------------------------------------------------------------
async function listPublishedArticles(query) {
  const { page, limit, offset } = parsePagination(query, 12);
  const where = [`status = 'published'`, 'published_at <= now()'];
  const params = [];

  if (query.category) {
    params.push(query.category);
    where.push(`category = $${params.length}`);
  }
  if (query.tag) {
    params.push(JSON.stringify([query.tag]));
    where.push(`tags @> $${params.length}::jsonb`);
  }
  if (query.featured === 'true') where.push('is_featured = true');
  if (query.search) {
    params.push(`%${query.search}%`);
    where.push(`(title ILIKE $${params.length} OR excerpt ILIKE $${params.length})`);
  }

  const whereClause = `WHERE ${where.join(' AND ')}`;
  const count = await pool.query(`SELECT COUNT(*) FROM cms_articles ${whereClause}`, params);
  params.push(limit, offset);
  const result = await pool.query(
    `SELECT id, slug, title, excerpt, cover_image_url, category, tags, author_name,
            reading_minutes, is_featured, published_at
     FROM cms_articles ${whereClause}
     ORDER BY is_featured DESC, published_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return { items: await signCover(result.rows), pagination: buildPagination(page, limit, count.rows[0].count) };
}

async function getPublishedArticleBySlug(slug) {
  const result = await pool.query(
    `SELECT id, slug, title, excerpt, content_html, cover_image_url, category, tags, author_name,
            reading_minutes, seo_title, seo_description, schema_type, faqs, is_featured, published_at, updated_at
     FROM cms_articles WHERE slug = $1 AND status = 'published' AND published_at <= now()`,
    [slug]
  );
  const article = result.rows[0];
  if (!article) throw notFound('Article not found');

  const related = await pool.query(
    `SELECT id, slug, title, excerpt, cover_image_url, category, reading_minutes, published_at
     FROM cms_articles
     WHERE status = 'published' AND published_at <= now() AND category = $1 AND id <> $2
     ORDER BY published_at DESC LIMIT 3`,
    [article.category, article.id]
  );

  return { ...(await signCover(article)), related: await signCover(related.rows) };
}

async function listArticleCategories() {
  const result = await pool.query(
    `SELECT category, COUNT(*)::int AS count FROM cms_articles
     WHERE status = 'published' AND published_at <= now()
     GROUP BY category ORDER BY count DESC, category ASC`
  );
  return result.rows;
}

// ---------------------------------------------------------------------
// Articles - admin
// ---------------------------------------------------------------------
async function listAllArticles(query) {
  const { page, limit, offset } = parsePagination(query, 20);
  const where = [];
  const params = [];
  if (query.status) {
    params.push(query.status);
    where.push(`a.status = $${params.length}`);
  }
  if (query.category) {
    params.push(query.category);
    where.push(`a.category = $${params.length}`);
  }
  if (query.search) {
    params.push(`%${query.search}%`);
    where.push(`(a.title ILIKE $${params.length} OR a.slug ILIKE $${params.length})`);
  }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const count = await pool.query(`SELECT COUNT(*) FROM cms_articles a ${whereClause}`, params);
  params.push(limit, offset);
  const result = await pool.query(
    `SELECT a.id, a.slug, a.title, a.category, a.status, a.is_featured, a.published_at, a.updated_at,
            a.author_name, u.full_name AS updated_by_name
     FROM cms_articles a LEFT JOIN users u ON u.id = a.updated_by
     ${whereClause}
     ORDER BY a.updated_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { items: result.rows, pagination: buildPagination(page, limit, count.rows[0].count) };
}

async function getArticleById(id) {
  const result = await pool.query('SELECT * FROM cms_articles WHERE id = $1', [id]);
  if (!result.rows[0]) throw notFound('Article not found');
  return signCover(result.rows[0]);
}

async function createArticle(data, user, meta = {}) {
  await guard(data);
  const slug = data.slug ? slugify(data.slug) : slugify(data.title);
  if (!slug) throw badRequest('A slug could not be derived from the title');
  const status = data.status || 'draft';

  try {
    const result = await pool.query(
      `INSERT INTO cms_articles (slug, title, excerpt, content_html, cover_image_url, category, tags,
         author_name, reading_minutes, seo_title, seo_description, schema_type, faqs, is_featured,
         status, published_at, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $17)
       RETURNING *`,
      [
        slug,
        data.title,
        data.excerpt || null,
        data.contentHtml || '',
        data.coverImageUrl || null,
        data.category || 'blog',
        JSON.stringify(data.tags || []),
        data.authorName || null,
        data.readingMinutes || estimateReadingMinutes(data.contentHtml),
        data.seoTitle || null,
        data.seoDescription || null,
        data.schemaType || 'Article',
        JSON.stringify(data.faqs || []),
        data.isFeatured ?? false,
        status,
        status === 'published' ? data.publishedAt || new Date() : data.publishedAt || null,
        user.id,
      ]
    );
    await auditService.log({ actor: user, action: 'article_created', entityType: 'cms_article', entityId: result.rows[0].id, after: { slug, status }, ...meta });
    return result.rows[0];
  } catch (err) {
    throw translateUniqueViolation(err, 'article');
  }
}

function buildUpdate(fieldMap, data) {
  const set = [];
  const params = [];
  for (const [key, column] of Object.entries(fieldMap)) {
    if (data[key] === undefined) continue;
    let value = data[key];
    if (key === 'slug') value = slugify(value);
    params.push(JSON_COLUMNS.has(column) ? JSON.stringify(value) : value);
    set.push(`${column} = $${params.length}`);
  }
  return { set, params };
}

async function updateArticle(id, data, user, meta = {}) {
  const existing = await getArticleById(id);
  await guard(data);

  const { set, params } = buildUpdate(ARTICLE_FIELDS, data);
  if (data.contentHtml !== undefined && data.readingMinutes === undefined) {
    params.push(estimateReadingMinutes(data.contentHtml));
    set.push(`reading_minutes = $${params.length}`);
  }
  // First publish stamps published_at; re-saving a published article keeps it.
  if (data.status === 'published' && !existing.published_at) set.push('published_at = now()');
  if (data.publishedAt !== undefined) {
    params.push(data.publishedAt);
    set.push(`published_at = $${params.length}`);
  }
  if (set.length === 0) throw badRequest('No updatable fields provided');

  params.push(user.id);
  set.push(`updated_by = $${params.length}`);
  params.push(id);

  try {
    const result = await pool.query(`UPDATE cms_articles SET ${set.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
    await auditService.log({
      actor: user,
      action: 'article_updated',
      entityType: 'cms_article',
      entityId: id,
      before: { slug: existing.slug, status: existing.status, title: existing.title },
      after: { slug: result.rows[0].slug, status: result.rows[0].status, title: result.rows[0].title },
      ...meta,
    });
    return result.rows[0];
  } catch (err) {
    throw translateUniqueViolation(err, 'article');
  }
}

async function deleteArticle(id, user, meta = {}) {
  const result = await pool.query('DELETE FROM cms_articles WHERE id = $1 RETURNING id, slug, title', [id]);
  if (!result.rows[0]) throw notFound('Article not found');
  await auditService.log({ actor: user, action: 'article_deleted', entityType: 'cms_article', entityId: id, before: result.rows[0], ...meta });
}

// ---------------------------------------------------------------------
// City pages
// ---------------------------------------------------------------------
const DEFAULT_CITY_PAGE_TEMPLATES = {
  buy: { slug: 'buy-property-in-{{city_slug}}', title: 'Buy Property in {{city}}', heroHeading: 'Verified properties for sale in {{city}}' },
  sell: { slug: 'sell-property-in-{{city_slug}}', title: 'Sell Property in {{city}}', heroHeading: 'Sell your property in {{city}} with a dedicated representative' },
  rent: { slug: 'rent-property-in-{{city_slug}}', title: 'Rent Property in {{city}}', heroHeading: 'Homes and offices for rent in {{city}}' },
  school_for_sale: { slug: 'school-for-sale-{{city_slug}}', title: 'Schools for Sale in {{city}}', heroHeading: 'Confidential K-12 school opportunities in {{city}}' },
  acquire_college: { slug: 'acquire-college-{{city_slug}}', title: 'Acquire a College in {{city}}', heroHeading: 'Private college acquisition opportunities in {{city}}' },
  university_campus_for_sale: { slug: 'university-campus-for-sale-{{city_slug}}', title: 'University Campus for Sale in {{city}}', heroHeading: 'University campus opportunities in {{city}}' },
};

function fillTemplate(text, city) {
  return String(text || '')
    .replace(/\{\{city\}\}/g, city.city_name)
    .replace(/\{\{city_slug\}\}/g, city.slug)
    .replace(/\{\{state\}\}/g, city.state_name);
}

async function resolveCity(data) {
  const params = [];
  let where;
  if (data.cityId) {
    params.push(data.cityId);
    where = 'c.id = $1';
  } else if (data.city) {
    params.push(String(data.city));
    where = '(LOWER(c.slug) = LOWER($1) OR LOWER(c.city_name) = LOWER($1))';
  } else {
    throw badRequest('cityId (or city slug/name) is required');
  }
  const result = await pool.query(
    `SELECT c.*, s.state_name, s.state_code FROM cities c JOIN states s ON s.id = c.state_id WHERE ${where}`,
    params
  );
  if (!result.rows[0]) throw badRequest('City not found');
  return result.rows[0];
}

// Creates a city page from the admin-editable template for its page type
// (sec. 22 step 10 - "Create city SEO landing page from template"). Any
// field the admin supplies overrides the template.
async function createCityPage(data, user, meta = {}) {
  const city = await resolveCity(data);
  const pageType = data.pageType || 'buy';
  const templates = await configService.getConfig('content.city_page_templates', DEFAULT_CITY_PAGE_TEMPLATES);
  const template = templates[pageType] || DEFAULT_CITY_PAGE_TEMPLATES[pageType];
  if (!template) throw badRequest(`Unknown page type: ${pageType}`);

  const page = {
    slug: data.slug ? slugify(data.slug) : slugify(fillTemplate(template.slug, city)),
    title: data.title || fillTemplate(template.title, city),
    heroHeading: data.heroHeading || fillTemplate(template.heroHeading, city),
    heroSubheading: data.heroSubheading || fillTemplate(template.heroSubheading, city) || null,
    contentHtml: data.contentHtml || fillTemplate(template.contentHtml, city),
    faqs: data.faqs || (template.faqs || []).map((f) => ({ question: fillTemplate(f.question, city), answer: fillTemplate(f.answer, city) })),
    seoTitle: data.seoTitle || fillTemplate(template.seoTitle || template.title, city),
    seoDescription: data.seoDescription || fillTemplate(template.seoDescription, city) || null,
    status: data.status || 'draft',
  };
  await guard(page);

  try {
    const result = await pool.query(
      `INSERT INTO city_pages (city_id, slug, page_type, title, hero_heading, hero_subheading, content_html,
         faqs, seo_title, seo_description, status, published_at, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13) RETURNING *`,
      [
        city.id,
        page.slug,
        pageType,
        page.title,
        page.heroHeading,
        page.heroSubheading,
        page.contentHtml,
        JSON.stringify(page.faqs),
        page.seoTitle,
        page.seoDescription,
        page.status,
        page.status === 'published' ? new Date() : null,
        user.id,
      ]
    );
    await auditService.log({ actor: user, action: 'city_page_created', entityType: 'city_page', entityId: result.rows[0].id, after: { slug: page.slug, pageType, status: page.status }, ...meta });
    return result.rows[0];
  } catch (err) {
    if (err.code === '23505' && err.constraint === 'uq_city_pages_city_type') {
      throw unprocessable(`A ${pageType} page already exists for ${city.city_name}`);
    }
    throw translateUniqueViolation(err, 'city page');
  }
}

async function getCityPageById(id) {
  const result = await pool.query(
    `SELECT cp.*, c.city_name, c.slug AS city_slug FROM city_pages cp JOIN cities c ON c.id = cp.city_id WHERE cp.id = $1`,
    [id]
  );
  if (!result.rows[0]) throw notFound('City page not found');
  return result.rows[0];
}

async function listAllCityPages(query) {
  const { page, limit, offset } = parsePagination(query, 50);
  const where = [];
  const params = [];
  if (query.status) {
    params.push(query.status);
    where.push(`cp.status = $${params.length}`);
  }
  if (query.cityId) {
    params.push(query.cityId);
    where.push(`cp.city_id = $${params.length}`);
  }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const count = await pool.query(`SELECT COUNT(*) FROM city_pages cp ${whereClause}`, params);
  params.push(limit, offset);
  const result = await pool.query(
    `SELECT cp.id, cp.slug, cp.page_type, cp.title, cp.status, cp.published_at, cp.updated_at,
            c.city_name, c.slug AS city_slug, c.status AS city_status
     FROM city_pages cp JOIN cities c ON c.id = cp.city_id
     ${whereClause}
     ORDER BY c.city_name ASC, cp.page_type ASC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { items: result.rows, pagination: buildPagination(page, limit, count.rows[0].count) };
}

async function updateCityPage(id, data, user, meta = {}) {
  const existing = await getCityPageById(id);
  await guard(data);
  const { cityId, pageType, ...rest } = data; // a page never moves city/type - create a new one instead
  const { set, params } = buildUpdate(CITY_PAGE_FIELDS, rest);
  if (data.status === 'published' && !existing.published_at) set.push('published_at = now()');
  if (set.length === 0) throw badRequest('No updatable fields provided');

  params.push(user.id);
  set.push(`updated_by = $${params.length}`);
  params.push(id);
  try {
    const result = await pool.query(`UPDATE city_pages SET ${set.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
    await auditService.log({
      actor: user,
      action: 'city_page_updated',
      entityType: 'city_page',
      entityId: id,
      before: { slug: existing.slug, status: existing.status },
      after: { slug: result.rows[0].slug, status: result.rows[0].status },
      ...meta,
    });
    return result.rows[0];
  } catch (err) {
    throw translateUniqueViolation(err, 'city page');
  }
}

async function deleteCityPage(id, user, meta = {}) {
  const result = await pool.query('DELETE FROM city_pages WHERE id = $1 RETURNING id, slug', [id]);
  if (!result.rows[0]) throw notFound('City page not found');
  await auditService.log({ actor: user, action: 'city_page_deleted', entityType: 'city_page', entityId: id, before: result.rows[0], ...meta });
}

const PAGE_TYPE_FILTERS = {
  buy: `p.transaction_type IN ('sell', 'buy') AND p.listing_category = 'residential'`,
  sell: `p.transaction_type IN ('sell', 'buy') AND p.listing_category = 'residential'`,
  rent: `p.transaction_type = 'rent' AND p.listing_category = 'residential'`,
  school_for_sale: `p.listing_category = 'institutional'`,
  acquire_college: `p.listing_category = 'institutional'`,
  university_campus_for_sale: `p.listing_category = 'institutional'`,
};

// Public city landing page: CMS copy + live data for that city (listing
// counts, top localities, average rate, latest verified listings). Only
// served while both the page is published and the city is live.
async function getPublishedCityPage(slug) {
  const result = await pool.query(
    `SELECT cp.id, cp.slug, cp.page_type, cp.title, cp.hero_heading, cp.hero_subheading, cp.content_html,
            cp.faqs, cp.seo_title, cp.seo_description, cp.published_at, cp.updated_at,
            c.id AS city_id, c.city_name, c.slug AS city_slug, c.lat_centroid, c.lng_centroid,
            s.state_code, s.state_name
     FROM city_pages cp
     JOIN cities c ON c.id = cp.city_id
     JOIN states s ON s.id = c.state_id
     WHERE cp.slug = $1 AND cp.status = 'published' AND c.status = 'active'`,
    [slug]
  );
  const page = result.rows[0];
  if (!page) throw notFound('City page not found');

  const scope = PAGE_TYPE_FILTERS[page.page_type];
  const [summary, topLocalities, listings, otherPages] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS active_listings,
              ROUND(AVG(p.rate))::int AS avg_rate_per_sqft,
              COUNT(*) FILTER (WHERE p.is_verified)::int AS verified_listings
       FROM properties p WHERE p.status = 'approved' AND p.city ILIKE $1 AND ${scope}`,
      [page.city_name]
    ),
    pool.query(
      `SELECT p.locality, COUNT(*)::int AS listings, ROUND(AVG(p.rate))::int AS avg_rate_per_sqft
       FROM properties p
       WHERE p.status = 'approved' AND p.city ILIKE $1 AND p.locality IS NOT NULL AND ${scope}
       GROUP BY p.locality ORDER BY listings DESC LIMIT 8`,
      [page.city_name]
    ),
    pool.query(
      `SELECT p.id, p.title, p.property_type, p.transaction_type, p.listing_category, p.price, p.rate,
              p.locality, p.city, p.area_sqft, p.bedrooms, p.is_verified, p.badge,
              (SELECT url FROM property_media pm WHERE pm.property_id = p.id
               ORDER BY pm.is_primary DESC, pm.display_order ASC LIMIT 1) AS primary_image
       FROM properties p
       WHERE p.status = 'approved' AND p.city ILIKE $1 AND ${scope}
       ORDER BY p.is_verified DESC, p.created_at DESC LIMIT 8`,
      [page.city_name]
    ),
    pool.query(
      `SELECT slug, page_type, title FROM city_pages WHERE city_id = $1 AND status = 'published' AND id <> $2`,
      [page.city_id, page.id]
    ),
  ]);

  // Institutional names are confidential by default (sec. 11.3) - a city
  // page never shows the listing title for them.
  const featured = await signUrls(
    listings.rows.map((l) =>
      l.listing_category === 'institutional'
        ? { ...l, title: `${String(l.property_type || 'Institutional asset').replace(/_/g, ' ')} in ${l.locality || l.city}` }
        : l
    ),
    'primary_image'
  );

  return {
    ...page,
    stats: summary.rows[0],
    topLocalities: topLocalities.rows,
    featuredListings: featured,
    relatedPages: otherPages.rows,
  };
}

async function listPublishedCityPages() {
  const result = await pool.query(
    `SELECT cp.slug, cp.page_type, cp.title, c.city_name, c.slug AS city_slug, cp.updated_at
     FROM city_pages cp JOIN cities c ON c.id = cp.city_id
     WHERE cp.status = 'published' AND c.status = 'active'
     ORDER BY c.city_name ASC, cp.page_type ASC`
  );
  return result.rows;
}

function escapeXml(text) {
  return String(text).replace(/[<>&'"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[ch]));
}

// sitemap.xml is generated on request from live data, so activating a city
// or publishing a page/article is reflected immediately (sec. 21.2).
async function buildSitemapXml() {
  const [baseUrl, staticPaths, patterns, cityPages, articles] = await Promise.all([
    configService.getConfig('site.base_url', 'https://propertyserch.com'),
    configService.getConfig('site.sitemap_static_paths', ['/']),
    configService.getConfig('site.sitemap_patterns', { article: '/news-guide/article/{slug}', city_page: '/{slug}' }),
    listPublishedCityPages(),
    pool.query(`SELECT slug, updated_at FROM cms_articles WHERE status = 'published' AND published_at <= now()`),
  ]);

  const base = String(baseUrl).replace(/\/+$/, '');
  const urls = [
    ...staticPaths.map((path) => ({ loc: `${base}${path}` })),
    ...cityPages.map((p) => ({ loc: `${base}${patterns.city_page.replace('{slug}', p.slug)}`, lastmod: p.updated_at })),
    ...articles.rows.map((a) => ({ loc: `${base}${patterns.article.replace('{slug}', a.slug)}`, lastmod: a.updated_at })),
  ];

  const body = urls
    .map((u) => `  <url><loc>${escapeXml(u.loc)}</loc>${u.lastmod ? `<lastmod>${new Date(u.lastmod).toISOString()}</lastmod>` : ''}</url>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

module.exports = {
  listPublishedArticles,
  getPublishedArticleBySlug,
  listArticleCategories,
  listAllArticles,
  getArticleById,
  createArticle,
  updateArticle,
  deleteArticle,
  createCityPage,
  getCityPageById,
  listAllCityPages,
  updateCityPage,
  deleteCityPage,
  getPublishedCityPage,
  listPublishedCityPages,
  buildSitemapXml,
};
