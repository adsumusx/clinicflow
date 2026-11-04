DROP INDEX equipment_catalog_idx;
DROP INDEX rooms_catalog_idx;
DROP INDEX services_catalog_idx;
DROP INDEX equipment_name_normalized_unique;
DROP INDEX rooms_name_normalized_unique;
DROP INDEX services_name_normalized_unique;
DROP INDEX modalities_name_normalized_unique;

ALTER TABLE equipment
  DROP CONSTRAINT equipment_quantity_range,
  DROP CONSTRAINT equipment_name_length;

ALTER TABLE rooms
  DROP CONSTRAINT rooms_capacity_range,
  DROP CONSTRAINT rooms_name_length;

ALTER TABLE services
  DROP CONSTRAINT services_capacity_range,
  DROP CONSTRAINT services_duration_range,
  DROP CONSTRAINT services_name_length;

ALTER TABLE modalities
  DROP CONSTRAINT modalities_name_length;
