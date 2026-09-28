-- =====================================================================
-- Migration: 022_seed_city_centroids.sql
-- Project  : PropertySerch.com
-- Purpose  : Seed major Indian cities with their centre coordinates and
--            match radius, so the website can resolve a visitor's location
--            to a city (GET /geo/nearest-city) without a third-party
--            geocoding service.
--            New cities are inserted with the default status 'inactive' -
--            seeding does not make a city public; activation stays an admin
--            action. Cities that already exist keep their status and radius
--            and only get coordinates if they had none.
-- DB       : PostgreSQL
-- =====================================================================

INSERT INTO cities (state_id, city_name, slug, city_tier, lat_centroid, lng_centroid, match_radius_km)
SELECT s.id, v.city_name, v.slug, v.tier, v.lat, v.lng, v.radius
FROM (VALUES
    ('DL', 'Delhi',              'delhi',              1, 28.6139000, 77.2090000, 35),
    ('HR', 'Gurugram',           'gurugram',           1, 28.4595000, 77.0266000, 25),
    ('HR', 'Faridabad',          'faridabad',          2, 28.4089000, 77.3178000, 20),
    ('HR', 'Sonipat',            'sonipat',            3, 28.9931000, 77.0151000, 15),
    ('HR', 'Panchkula',          'panchkula',          3, 30.6942000, 76.8606000, 12),
    ('UP', 'Noida',              'noida',              1, 28.5355000, 77.3910000, 20),
    ('UP', 'Greater Noida',      'greater-noida',      2, 28.4744000, 77.5040000, 20),
    ('UP', 'Ghaziabad',          'ghaziabad',          2, 28.6692000, 77.4538000, 20),
    ('UP', 'Lucknow',            'lucknow',            2, 26.8467000, 80.9462000, 35),
    ('UP', 'Agra',               'agra',               3, 27.1767000, 78.0081000, 25),
    ('UP', 'Varanasi',           'varanasi',           3, 25.3176000, 82.9739000, 25),
    ('MH', 'Mumbai',             'mumbai',             1, 19.0760000, 72.8777000, 35),
    ('MH', 'Thane',              'thane',              1, 19.2183000, 72.9781000, 15),
    ('MH', 'Navi Mumbai',        'navi-mumbai',        1, 19.0330000, 73.0297000, 20),
    ('MH', 'Pune',               'pune',               1, 18.5204000, 73.8567000, 35),
    ('MH', 'Nagpur',             'nagpur',             2, 21.1458000, 79.0882000, 30),
    ('KA', 'Bengaluru',          'bengaluru',          1, 12.9716000, 77.5946000, 40),
    ('TG', 'Hyderabad',          'hyderabad',          1, 17.3850000, 78.4867000, 40),
    ('TN', 'Chennai',            'chennai',            1, 13.0827000, 80.2707000, 40),
    ('TN', 'Coimbatore',         'coimbatore',         2, 11.0168000, 76.9558000, 30),
    ('WB', 'Kolkata',            'kolkata',            1, 22.5726000, 88.3639000, 35),
    ('GJ', 'Ahmedabad',          'ahmedabad',          1, 23.0225000, 72.5714000, 35),
    ('GJ', 'Surat',              'surat',              2, 21.1702000, 72.8311000, 30),
    ('GJ', 'Vadodara',           'vadodara',           2, 22.3072000, 73.1812000, 25),
    ('RJ', 'Jaipur',             'jaipur',             2, 26.9124000, 75.7873000, 35),
    ('CH', 'Chandigarh',         'chandigarh',         2, 30.7333000, 76.7794000, 15),
    ('PB', 'Mohali',             'mohali',             2, 30.7046000, 76.7179000, 12),
    ('PB', 'Ludhiana',           'ludhiana',           2, 30.9010000, 75.8573000, 25),
    ('MP', 'Indore',             'indore',             2, 22.7196000, 75.8577000, 30),
    ('MP', 'Bhopal',             'bhopal',             2, 23.2599000, 77.4126000, 30),
    ('KL', 'Kochi',              'kochi',              2, 9.9312000,  76.2673000, 30),
    ('KL', 'Thiruvananthapuram', 'thiruvananthapuram', 2, 8.5241000,  76.9366000, 25),
    ('GA', 'Goa',                'goa',                2, 15.4909000, 73.8278000, 50),
    ('UK', 'Dehradun',           'dehradun',           3, 30.3165000, 78.0322000, 25),
    ('AP', 'Visakhapatnam',      'visakhapatnam',      2, 17.6868000, 83.2185000, 30),
    ('OD', 'Bhubaneswar',        'bhubaneswar',        2, 20.2961000, 85.8245000, 25),
    ('BR', 'Patna',              'patna',              2, 25.5941000, 85.1376000, 25)
) AS v(state_code, city_name, slug, tier, lat, lng, radius)
JOIN states s ON s.state_code = v.state_code
WHERE NOT EXISTS (SELECT 1 FROM cities c WHERE c.slug = v.slug AND c.state_id <> s.id)
ON CONFLICT (state_id, city_name) DO UPDATE
SET lat_centroid = COALESCE(cities.lat_centroid, EXCLUDED.lat_centroid),
    lng_centroid = COALESCE(cities.lng_centroid, EXCLUDED.lng_centroid),
    updated_at = now();
