DROP TABLE IF EXISTS schedule_grid_services;
DROP TABLE IF EXISTS schedule_grids;

ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_contract_fk;
DROP INDEX IF EXISTS appointments_contract_idx;
ALTER TABLE appointments DROP COLUMN IF EXISTS contract_id;

ALTER TABLE services DROP CONSTRAINT IF EXISTS services_category_length;
ALTER TABLE services DROP CONSTRAINT IF EXISTS services_cost_center_length;
ALTER TABLE services DROP CONSTRAINT IF EXISTS services_price_cents;
ALTER TABLE services DROP COLUMN IF EXISTS category;
ALTER TABLE services DROP COLUMN IF EXISTS cost_center;
ALTER TABLE services DROP COLUMN IF EXISTS price_cents;

ALTER TABLE contracts DROP CONSTRAINT IF EXISTS contracts_session_count;
ALTER TABLE contracts DROP CONSTRAINT IF EXISTS contracts_schedule_slots_array;
ALTER TABLE contracts DROP CONSTRAINT IF EXISTS contracts_professional_fk;
ALTER TABLE contracts DROP COLUMN IF EXISTS session_count;
ALTER TABLE contracts DROP COLUMN IF EXISTS professional_id;
ALTER TABLE contracts DROP COLUMN IF EXISTS schedule_slots;

ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_kind;
ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_session_count;
ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_service_fk;
ALTER TABLE plans DROP COLUMN IF EXISTS kind;
ALTER TABLE plans DROP COLUMN IF EXISTS session_count;
ALTER TABLE plans DROP COLUMN IF EXISTS service_id;
