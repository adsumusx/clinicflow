-- WAIT-001/WAIT-002: ordem estável da fila e uma única oferta temporária por vaga.
ALTER TABLE organizations
  ADD COLUMN waitlist_offer_minutes integer NOT NULL DEFAULT 15,
  ADD CONSTRAINT organizations_waitlist_offer_minutes_valid
    CHECK (waitlist_offer_minutes BETWEEN 1 AND 1440);

ALTER TABLE waitlist_entries
  ADD COLUMN queue_position bigint;

WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY organization_id, appointment_id
           ORDER BY queued_at, id
         ) AS position
  FROM waitlist_entries
)
UPDATE waitlist_entries entry
SET queue_position = ranked.position
FROM ranked
WHERE ranked.id = entry.id;

ALTER TABLE waitlist_entries
  ALTER COLUMN queue_position SET NOT NULL,
  ADD CONSTRAINT waitlist_entries_queue_position_positive
    CHECK (queue_position > 0),
  ADD CONSTRAINT waitlist_entries_position_unique
    UNIQUE (organization_id, appointment_id, queue_position);

ALTER TABLE waitlist_offers
  ADD COLUMN appointment_id uuid;

UPDATE waitlist_offers offer
SET appointment_id = entry.appointment_id
FROM waitlist_entries entry
WHERE entry.organization_id = offer.organization_id
  AND entry.id = offer.waitlist_entry_id;

ALTER TABLE waitlist_offers
  ALTER COLUMN appointment_id SET NOT NULL,
  ADD CONSTRAINT waitlist_offers_appointment_fk
    FOREIGN KEY (organization_id, appointment_id)
    REFERENCES appointments(organization_id, id);

CREATE UNIQUE INDEX waitlist_offers_one_active_per_appointment
  ON waitlist_offers(organization_id, appointment_id)
  WHERE status = 'active';

CREATE INDEX waitlist_offers_expiration_idx
  ON waitlist_offers(expires_at, organization_id, appointment_id)
  WHERE status = 'active';

DROP INDEX waitlist_queue_idx;
CREATE INDEX waitlist_queue_idx
  ON waitlist_entries(organization_id, appointment_id, queue_position)
  WHERE status = 'queued';
