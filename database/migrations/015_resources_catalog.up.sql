ALTER TABLE modalities
  ADD CONSTRAINT modalities_name_length
    CHECK (char_length(btrim(name)) BETWEEN 2 AND 120);

ALTER TABLE services
  ADD CONSTRAINT services_name_length
    CHECK (char_length(btrim(name)) BETWEEN 2 AND 120),
  ADD CONSTRAINT services_duration_range
    CHECK (duration_minutes BETWEEN 5 AND 1440),
  ADD CONSTRAINT services_capacity_range
    CHECK (default_capacity BETWEEN 1 AND 10000);

ALTER TABLE rooms
  ADD CONSTRAINT rooms_name_length
    CHECK (char_length(btrim(name)) BETWEEN 2 AND 120),
  ADD CONSTRAINT rooms_capacity_range
    CHECK (capacity BETWEEN 1 AND 10000);

ALTER TABLE equipment
  ADD CONSTRAINT equipment_name_length
    CHECK (char_length(btrim(name)) BETWEEN 2 AND 120),
  ADD CONSTRAINT equipment_quantity_range
    CHECK (quantity BETWEEN 1 AND 10000);

CREATE UNIQUE INDEX modalities_name_normalized_unique
  ON modalities (organization_id, lower(btrim(name)));
CREATE UNIQUE INDEX services_name_normalized_unique
  ON services (organization_id, lower(btrim(name)));
CREATE UNIQUE INDEX rooms_name_normalized_unique
  ON rooms (organization_id, unit_id, lower(btrim(name)));
CREATE UNIQUE INDEX equipment_name_normalized_unique
  ON equipment (organization_id, unit_id, lower(btrim(name)));

CREATE INDEX services_catalog_idx
  ON services (organization_id, active DESC, modality_id, name);
CREATE INDEX rooms_catalog_idx
  ON rooms (organization_id, active DESC, unit_id, name);
CREATE INDEX equipment_catalog_idx
  ON equipment (organization_id, active DESC, unit_id, name);
