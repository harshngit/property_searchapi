-- =====================================================================
-- Migration: 020_seed_content_config.sql
-- Project  : PropertySerch.com
-- Purpose  : Admin-editable defaults for the website content layer and
--            HNI deal curation, so none of this copy or these thresholds
--            live in application code (sec. "Everything Is Dynamic").
--              - content.city_page_templates  ({{city}}, {{city_slug}},
--                                               {{state}} placeholders)
--              - site.sitemap_static_paths / site.sitemap_patterns
--              - hni.high_ticket_commercial_min
-- DB       : PostgreSQL
-- =====================================================================

INSERT INTO app_config (config_key, value, category, description) VALUES
  ('content.city_page_templates', $json$
  {
    "buy": {
      "slug": "buy-property-in-{{city_slug}}",
      "title": "Buy Property in {{city}}",
      "heroHeading": "Verified properties for sale in {{city}}",
      "heroSubheading": "Every enquiry is handled by a dedicated A R Buildwel representative - from shortlisting to registration.",
      "seoTitle": "Buy Property in {{city}} | Verified Listings | PropertySerch.com",
      "seoDescription": "Browse verified flats, houses and plots for sale in {{city}}, {{state}}. Mandatory intermediation, controlled contact and legal coordination on every deal.",
      "contentHtml": "<p>Explore verified residential and commercial properties across {{city}}. Listings are geo-validated and screened before they go live.</p>",
      "faqs": [
        {"question": "How do I contact the seller of a property in {{city}}?", "answer": "Express interest on the listing - your assigned A R Buildwel representative coordinates the viewing and negotiation. Seller contact details are never shared directly."},
        {"question": "Are the listings in {{city}} verified?", "answer": "Every listing passes system verification; many also carry seller, legal or site verification badges."}
      ]
    },
    "sell": {
      "slug": "sell-property-in-{{city_slug}}",
      "title": "Sell Property in {{city}}",
      "heroHeading": "Sell your property in {{city}} with a dedicated representative",
      "heroSubheading": "Priority placement, free valuation and legal due diligence with an Exclusive Mandate.",
      "seoTitle": "Sell Property in {{city}} | PropertySerch.com",
      "seoDescription": "List your property in {{city}} and reach verified buyers. A R Buildwel coordinates every enquiry, viewing and negotiation.",
      "contentHtml": "<p>Post your property in {{city}} and get matched with verified buyer requirements.</p>",
      "faqs": []
    },
    "rent": {
      "slug": "rent-property-in-{{city_slug}}",
      "title": "Rent Property in {{city}}",
      "heroHeading": "Homes and offices for rent in {{city}}",
      "heroSubheading": "Verified rental listings with a representative on every enquiry.",
      "seoTitle": "Property for Rent in {{city}} | PropertySerch.com",
      "seoDescription": "Find flats, houses and offices for rent in {{city}}, {{state}}.",
      "contentHtml": "<p>Browse rental listings across {{city}}.</p>",
      "faqs": []
    },
    "school_for_sale": {
      "slug": "school-for-sale-{{city_slug}}",
      "title": "Schools for Sale in {{city}}",
      "heroHeading": "Confidential K-12 school opportunities in {{city}}",
      "heroSubheading": "Institution identities stay confidential until NDA and buyer verification.",
      "seoTitle": "School for Sale in {{city}} | Institutional Deals | PropertySerch.com",
      "seoDescription": "Confidential K-12 school sale, lease and JV opportunities in {{city}} with a structured nine-stage deal process.",
      "contentHtml": "<p>Explore confidential school acquisition opportunities in {{city}}.</p>",
      "faqs": []
    },
    "acquire_college": {
      "slug": "acquire-college-{{city_slug}}",
      "title": "Acquire a College in {{city}}",
      "heroHeading": "Private college acquisition opportunities in {{city}}",
      "heroSubheading": "NDA-gated data rooms and EBITDA-linked valuation benchmarking.",
      "seoTitle": "Acquire a College in {{city}} | PropertySerch.com",
      "seoDescription": "Engineering, management, medical and other private college opportunities in {{city}}.",
      "contentHtml": "<p>Explore confidential college acquisition opportunities in {{city}}.</p>",
      "faqs": []
    },
    "university_campus_for_sale": {
      "slug": "university-campus-for-sale-{{city_slug}}",
      "title": "University Campus for Sale in {{city}}",
      "heroHeading": "University campus opportunities in {{city}}",
      "heroSubheading": "Confidential listings for verified institutional buyers.",
      "seoTitle": "University Campus for Sale in {{city}} | PropertySerch.com",
      "seoDescription": "Deemed and private university campus opportunities in {{city}}.",
      "contentHtml": "<p>Explore confidential university campus opportunities in {{city}}.</p>",
      "faqs": []
    }
  }
  $json$::jsonb, 'content', 'Sec. 21.2 / 22 - templates used to create city landing pages; placeholders {{city}}, {{city_slug}}, {{state}}.'),

  ('site.sitemap_static_paths',
   '["/", "/properties", "/buy/bank-auction-properties", "/buy/special-situation-properties", "/buy/institutional-properties", "/services/get-involved", "/news-guide/insights-guides", "/legal"]',
   'site', 'Static website routes listed in sitemap.xml.'),
  ('site.sitemap_patterns',
   '{"article": "/news-guide/article/{slug}", "city_page": "/{slug}"}',
   'site', 'Website URL patterns for articles and city pages in sitemap.xml.'),

  ('hni.high_ticket_commercial_min', '10000000', 'hni',
   'Engine 3 - minimum price (INR) for a commercial listing to appear in HNI curated deal flow.')
ON CONFLICT (config_key) DO NOTHING;
