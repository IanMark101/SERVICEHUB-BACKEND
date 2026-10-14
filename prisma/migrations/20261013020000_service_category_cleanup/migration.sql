-- One-time catalog cleanup. Keep retired IDs for audit references, move BOTH
-- listing types to the same surviving category, and preserve Admin status.
-- No listing content, booking, offer, payment, or account is deleted.
BEGIN;
LOCK TABLE categories, services, service_requests IN SHARE ROW EXCLUSIVE MODE;
-- Session-local helper: match spacing/case and &/and/slash spelling variants.
CREATE OR REPLACE FUNCTION pg_temp.servicehub_category_name_key(label text)
RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT btrim(regexp_replace(lower(regexp_replace(label, '[&/]+', ' and ', 'g')), '[^[:alnum:]]+', ' ', 'g'))
$$;
DO $$
DECLARE
  family record;
  keeper text;
  old_ids text[];
BEGIN
  FOR family IN SELECT * FROM (VALUES
      ('Aircon Cleaning & Repair', ARRAY['Aircon Service', 'Aircon Repair']::text[]),
      ('Appliance Repair', ARRAY[]::text[]),
      ('Bicycle Repair', ARRAY[]::text[]),
      ('Bookkeeping & Admin Help', ARRAY[]::text[]),
      ('Car Repair & Maintenance', ARRAY['Automotive Services']::text[]),
      ('Carpentry & Furniture Repair', ARRAY['Carpentry & Woodwork']::text[]),
      ('Computer & Laptop Repair', ARRAY['Computer / IT Services']::text[]),
      ('Cooking & Catering', ARRAY[]::text[]),
      ('Delivery, Moving & Errands', ARRAY['Delivery & Moving']::text[]),
      ('Electrical Wiring & Repairs', ARRAY['Electrical Repair']::text[]),
      ('Event Planning & Setup', ARRAY['Event Services']::text[]),
      ('Gardening & Landscaping', ARRAY['Lawn & Garden', 'Lawn Care']::text[]),
      ('Haircuts & Beauty', ARRAY['Beauty & Personal Care', 'Haircut']::text[]),
      ('Handyman & Small Home Repairs', ARRAY['Handyman Services']::text[]),
      ('Home & Office Cleaning', ARRAY['Cleaning Services', 'House Cleaning']::text[]),
      ('Home Renovation & Masonry', ARRAY['Home Improvement']::text[]),
      ('Internet & Wi-Fi Setup', ARRAY[]::text[]),
      ('Laundry & Ironing', ARRAY[]::text[]),
      ('Locks & Keys', ARRAY[]::text[]),
      ('Motorcycle Repair & Maintenance', ARRAY[]::text[]),
      ('Musical Instrument Repair & Tuning', ARRAY[]::text[]),
      ('Painting', ARRAY['Painting Services']::text[]),
      ('Pest Control', ARRAY[]::text[]),
      ('Pet Grooming & Care', ARRAY['Pet Services']::text[]),
      ('Phone & Tablet Repair', ARRAY[]::text[]),
      ('Photography & Video', ARRAY['Photography / Videography']::text[]),
      ('Plumbing', ARRAY[]::text[]),
      ('Printing & Graphic Design', ARRAY[]::text[]),
      ('Roof & Gutter Repairs', ARRAY[]::text[]),
      ('Tailoring & Clothing Repairs', ARRAY[]::text[]),
      ('Translation & Writing', ARRAY[]::text[]),
      ('Tutoring & Lessons', ARRAY['Tutoring & Education', 'Tutoring']::text[]),
      ('Website & Software Services', ARRAY[]::text[]),
      ('Welding & Metalwork', ARRAY[]::text[]),
      ('Other Services', ARRAY['Repair & Maintenance']::text[])
  ) AS catalog(name, aliases)
  LOOP
    SELECT id INTO keeper FROM categories
    WHERE pg_temp.servicehub_category_name_key(name) = ANY(
      SELECT pg_temp.servicehub_category_name_key(label) FROM unnest(ARRAY[family.name] || family.aliases) AS label
    )
    ORDER BY (name = family.name) DESC,
      (pg_temp.servicehub_category_name_key(name) = pg_temp.servicehub_category_name_key(family.name)) DESC,
      array_position(family.aliases, name) NULLS LAST, id
    LIMIT 1;

    IF keeper IS NULL THEN
      keeper := 'c' || substr(md5('servicehub-category-v2:' || family.name), 1, 24);
      INSERT INTO categories (id, name, "isActive") VALUES (keeper, family.name, true);
    ELSE
      -- Renaming keeps the surviving ID and its current active/inactive status.
      UPDATE categories SET name = family.name WHERE id = keeper;
    END IF;

    SELECT array_agg(id) INTO old_ids FROM categories
    WHERE id <> keeper AND pg_temp.servicehub_category_name_key(name) = ANY(
      SELECT pg_temp.servicehub_category_name_key(label) FROM unnest(ARRAY[family.name] || family.aliases) AS label
    );
    IF old_ids IS NOT NULL THEN
      UPDATE services SET "categoryId" = keeper WHERE "categoryId" = ANY(old_ids);
      UPDATE service_requests SET "categoryId" = keeper WHERE "categoryId" = ANY(old_ids);
      UPDATE categories SET "isActive" = false WHERE id = ANY(old_ids);
    END IF;
    IF family.name = 'Other Services' THEN
      UPDATE categories SET "isActive" = true WHERE id = keeper;
    END IF;
    keeper := NULL;
  END LOOP;
END $$;
COMMIT;

