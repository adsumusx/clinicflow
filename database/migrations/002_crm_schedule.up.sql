CREATE TABLE clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid REFERENCES users(id),
  full_name text NOT NULL,
  birth_date date,
  document_number text,
  client_type text NOT NULL DEFAULT 'rotating' CHECK (client_type IN ('fixed', 'rotating')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  UNIQUE (organization_id, id), UNIQUE (organization_id, document_number)
);

CREATE TABLE client_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
  client_id uuid NOT NULL, type text NOT NULL CHECK (type IN ('email', 'phone', 'other')),
  value text NOT NULL, preferred boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, client_id) REFERENCES clients(organization_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX client_contacts_one_preferred_type
  ON client_contacts(organization_id, client_id, type) WHERE preferred;

CREATE TABLE client_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
  client_id uuid NOT NULL, purpose text NOT NULL, legal_basis text NOT NULL,
  granted_at timestamptz, revoked_at timestamptz, evidence_ref text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, client_id) REFERENCES clients(organization_id, id)
);

CREATE TABLE clinical_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
  client_id uuid NOT NULL, author_professional_id uuid NOT NULL,
  record_type text NOT NULL, content text NOT NULL, occurred_at timestamptz NOT NULL,
  signed_at timestamptz, supersedes_record_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, client_id) REFERENCES clients(organization_id, id),
  FOREIGN KEY (organization_id, author_professional_id) REFERENCES professionals(organization_id, id),
  FOREIGN KEY (organization_id, supersedes_record_id) REFERENCES clinical_records(organization_id, id)
);

CREATE TABLE assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
  client_id uuid NOT NULL, professional_id uuid NOT NULL, assessment_type text NOT NULL,
  structured_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  publication_status text NOT NULL DEFAULT 'private' CHECK (publication_status IN ('private', 'published', 'withdrawn')),
  assessed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, client_id) REFERENCES clients(organization_id, id),
  FOREIGN KEY (organization_id, professional_id) REFERENCES professionals(organization_id, id)
);

CREATE TABLE workout_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
  client_id uuid NOT NULL, professional_id uuid NOT NULL, title text NOT NULL,
  instructions jsonb NOT NULL DEFAULT '{}'::jsonb,
  publication_status text NOT NULL DEFAULT 'private' CHECK (publication_status IN ('private', 'published', 'withdrawn')),
  valid_until date,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, client_id) REFERENCES clients(organization_id, id),
  FOREIGN KEY (organization_id, professional_id) REFERENCES professionals(organization_id, id)
);

CREATE TABLE prospects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
  owner_professional_id uuid, converted_client_id uuid,
  full_name text NOT NULL, contact text, stage text NOT NULL DEFAULT 'new', source text,
  next_action_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id), UNIQUE (organization_id, converted_client_id),
  FOREIGN KEY (organization_id, owner_professional_id) REFERENCES professionals(organization_id, id),
  FOREIGN KEY (organization_id, converted_client_id) REFERENCES clients(organization_id, id)
);

CREATE TABLE prospect_interactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
  prospect_id uuid NOT NULL, type text NOT NULL, notes text, occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, prospect_id) REFERENCES prospects(organization_id, id) ON DELETE CASCADE
);

CREATE TABLE modalities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL, active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id), UNIQUE (organization_id, name)
);

CREATE TABLE services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
  modality_id uuid NOT NULL, name text NOT NULL, duration_minutes integer NOT NULL CHECK (duration_minutes > 0),
  default_capacity integer NOT NULL DEFAULT 1 CHECK (default_capacity > 0), active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id), UNIQUE (organization_id, name),
  FOREIGN KEY (organization_id, modality_id) REFERENCES modalities(organization_id, id)
);

CREATE TABLE rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
  unit_id uuid NOT NULL, name text NOT NULL, capacity integer NOT NULL CHECK (capacity > 0), active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id), UNIQUE (organization_id, unit_id, name),
  FOREIGN KEY (organization_id, unit_id) REFERENCES units(organization_id, id)
);

CREATE TABLE equipment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
  unit_id uuid NOT NULL, name text NOT NULL, quantity integer NOT NULL CHECK (quantity > 0), active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id), UNIQUE (organization_id, unit_id, name),
  FOREIGN KEY (organization_id, unit_id) REFERENCES units(organization_id, id)
);

CREATE TABLE availability_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
  professional_id uuid NOT NULL, unit_id uuid NOT NULL,
  rule_type text NOT NULL CHECK (rule_type IN ('available', 'blocked')),
  recurrence_expression text, starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id), CHECK (ends_at > starts_at),
  FOREIGN KEY (organization_id, professional_id) REFERENCES professionals(organization_id, id),
  FOREIGN KEY (organization_id, unit_id) REFERENCES units(organization_id, id)
);

CREATE TABLE recurrence_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
  recurrence_expression text NOT NULL, series_start date NOT NULL, series_end date,
  timezone text NOT NULL DEFAULT 'America/Sao_Paulo',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id), CHECK (series_end IS NULL OR series_end >= series_start)
);

CREATE TABLE appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
  unit_id uuid NOT NULL, service_id uuid NOT NULL, professional_id uuid NOT NULL,
  room_id uuid, recurrence_rule_id uuid, starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
  capacity integer NOT NULL CHECK (capacity > 0),
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id), CHECK (ends_at > starts_at),
  FOREIGN KEY (organization_id, unit_id) REFERENCES units(organization_id, id),
  FOREIGN KEY (organization_id, service_id) REFERENCES services(organization_id, id),
  FOREIGN KEY (organization_id, professional_id) REFERENCES professionals(organization_id, id),
  FOREIGN KEY (organization_id, room_id) REFERENCES rooms(organization_id, id),
  FOREIGN KEY (organization_id, recurrence_rule_id) REFERENCES recurrence_rules(organization_id, id)
);

CREATE TABLE appointment_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
  appointment_id uuid NOT NULL, client_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'confirmed', 'attended', 'absent', 'cancelled')),
  cancellation_reason text, booked_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, appointment_id) REFERENCES appointments(organization_id, id),
  FOREIGN KEY (organization_id, client_id) REFERENCES clients(organization_id, id)
);

CREATE UNIQUE INDEX appointment_participants_one_active
  ON appointment_participants(organization_id, appointment_id, client_id)
  WHERE status IN ('booked', 'confirmed', 'attended');

CREATE TABLE appointment_equipment (
  organization_id uuid NOT NULL, appointment_id uuid NOT NULL, equipment_id uuid NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (organization_id, appointment_id, equipment_id),
  FOREIGN KEY (organization_id, appointment_id) REFERENCES appointments(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, equipment_id) REFERENCES equipment(organization_id, id)
);

CREATE TABLE checkins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
  appointment_participant_id uuid NOT NULL, checked_in_at timestamptz NOT NULL DEFAULT now(),
  method text NOT NULL CHECK (method IN ('self', 'staff', 'automatic')),
  recorded_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (organization_id, id),
  UNIQUE (organization_id, appointment_participant_id),
  FOREIGN KEY (organization_id, appointment_participant_id) REFERENCES appointment_participants(organization_id, id),
  FOREIGN KEY (organization_id, recorded_by_membership_id) REFERENCES memberships(organization_id, id)
);

CREATE TABLE waitlist_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
  appointment_id uuid NOT NULL, client_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'offered', 'consumed', 'expired', 'cancelled')),
  queued_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, appointment_id) REFERENCES appointments(organization_id, id),
  FOREIGN KEY (organization_id, client_id) REFERENCES clients(organization_id, id)
);

CREATE UNIQUE INDEX waitlist_entries_one_active
  ON waitlist_entries(organization_id, appointment_id, client_id)
  WHERE status IN ('queued', 'offered');

CREATE TABLE waitlist_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
  waitlist_entry_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'consumed', 'expired', 'cancelled')),
  offered_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id), CHECK (expires_at > offered_at),
  CHECK ((status = 'consumed') = (consumed_at IS NOT NULL)),
  FOREIGN KEY (organization_id, waitlist_entry_id) REFERENCES waitlist_entries(organization_id, id)
);

CREATE UNIQUE INDEX waitlist_offers_one_active
  ON waitlist_offers(organization_id, waitlist_entry_id) WHERE status = 'active';

CREATE TABLE replacement_credits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
  client_id uuid NOT NULL, source_participant_id uuid NOT NULL, consumed_by_participant_id uuid,
  status text NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'consumed', 'expired', 'cancelled')),
  expires_on date NOT NULL, consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id), UNIQUE (organization_id, source_participant_id),
  UNIQUE (organization_id, consumed_by_participant_id),
  CHECK ((status = 'consumed') = (consumed_at IS NOT NULL AND consumed_by_participant_id IS NOT NULL)),
  FOREIGN KEY (organization_id, client_id) REFERENCES clients(organization_id, id),
  FOREIGN KEY (organization_id, source_participant_id) REFERENCES appointment_participants(organization_id, id),
  FOREIGN KEY (organization_id, consumed_by_participant_id) REFERENCES appointment_participants(organization_id, id)
);

CREATE INDEX appointments_schedule_idx ON appointments(organization_id, starts_at, ends_at) WHERE status = 'scheduled';
CREATE INDEX appointments_professional_idx ON appointments(organization_id, professional_id, starts_at);
CREATE INDEX appointment_participants_client_idx ON appointment_participants(organization_id, client_id, booked_at DESC);
CREATE INDEX waitlist_queue_idx ON waitlist_entries(organization_id, appointment_id, queued_at) WHERE status = 'queued';
