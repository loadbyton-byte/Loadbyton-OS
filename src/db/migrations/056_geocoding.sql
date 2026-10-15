-- Where a stop's coordinates came from, so a planner never mistakes a geocoder's guess for a surveyed point.
ALTER TABLE trip_legs ADD COLUMN geo_source text CHECK (geo_source IN ('manual','geocoded'));
ALTER TABLE trip_legs ADD COLUMN geo_label text;
UPDATE trip_legs SET geo_source='manual' WHERE lat IS NOT NULL;
ALTER TABLE trip_legs ADD CONSTRAINT trip_legs_geo_source CHECK ((lat IS NULL) = (geo_source IS NULL));
