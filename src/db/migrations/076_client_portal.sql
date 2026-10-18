-- Client portal (brochure mode): brand kit and logo assets, a message thread between the client and our staff, add-on features
-- (free ones are delivered, paid ones start when a monthly plan is paid), and a delivery clock that starts only when the work can begin.

-- A request now says which features it asks for, which monthly plan the paid ones need, and the order that pays for it.
-- The 24-hour clock starts when the brand kit is in AND (for paid work) the quote is agreed or the plan is paid.
ALTER TABLE service_requests
  ADD COLUMN features text[] NOT NULL DEFAULT '{}',
  ADD COLUMN plan_code text,
  ADD COLUMN order_id uuid REFERENCES orders(id),
  ADD COLUMN brand_ready_at timestamptz,
  ADD COLUMN clock_started_at timestamptz;
-- Requests that already exist were running on the old rule (clock from submission / from the quote): keep their clocks as they were.
UPDATE service_requests SET brand_ready_at = created_at,
  clock_started_at = CASE WHEN category = 'free' THEN created_at WHEN quote_note IS NOT NULL THEN updated_at ELSE NULL END;
CREATE INDEX service_requests_order ON service_requests(order_id) WHERE order_id IS NOT NULL;

-- One brand kit per client company. It never holds a registration number, bank detail or password: the client types those into their own system.
CREATE TABLE brand_kits (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  tagline text CHECK (tagline IS NULL OR length(tagline) <= 160),
  website text CHECK (website IS NULL OR length(website) <= 200),
  primary_colour text CHECK (primary_colour IS NULL OR primary_colour ~ '^#[0-9A-Fa-f]{6}$'),
  secondary_colour text CHECK (secondary_colour IS NULL OR secondary_colour ~ '^#[0-9A-Fa-f]{6}$'),
  doc_footer text CHECK (doc_footer IS NULL OR length(doc_footer) <= 300),
  notes text CHECK (notes IS NULL OR length(notes) <= 2000),
  no_logo boolean NOT NULL DEFAULT false,            -- "I have no logo yet: use my name as plain text"
  confirmed_at timestamptz,                          -- the client said the kit is complete; this is what lets the clock start
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE brand_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  kind text NOT NULL CHECK (kind IN ('logo','logo_dark','icon','guidelines','other')),
  filename text NOT NULL, mime text NOT NULL, size_bytes int NOT NULL, sha256 text NOT NULL, storage_key text NOT NULL,
  uploaded_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  UNIQUE (tenant_id, id)
);
CREATE INDEX brand_assets_tenant ON brand_assets(tenant_id) WHERE removed_at IS NULL;

-- The single point of contact between a client and our staff. A message may belong to a request or to the client in general.
CREATE TABLE request_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  request_id uuid,
  author_kind text NOT NULL CHECK (author_kind IN ('client','staff')),
  author_user_id uuid REFERENCES users(id),
  author_name text NOT NULL,
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  read_by_client_at timestamptz, read_by_staff_at timestamptz,
  FOREIGN KEY (tenant_id, request_id) REFERENCES service_requests(tenant_id, id)
);
CREATE INDEX request_messages_thread ON request_messages(tenant_id, request_id, created_at);
CREATE INDEX request_messages_unread_staff ON request_messages(created_at) WHERE author_kind = 'client' AND read_by_staff_at IS NULL;

-- Which private details the client says they have entered in their own admin panel (a checklist; the details themselves are never stored here).
CREATE TABLE private_detail_ticks (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL CHECK (length(code) BETWEEN 1 AND 60),
  done_at timestamptz NOT NULL DEFAULT now(),
  done_by uuid REFERENCES users(id),
  PRIMARY KEY (tenant_id, code)
);

ALTER TABLE brand_kits ENABLE ROW LEVEL SECURITY;
ALTER TABLE brand_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE request_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE private_detail_ticks ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON brand_kits USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY tenant_isolation ON brand_assets USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY tenant_isolation ON request_messages USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY tenant_isolation ON private_detail_ticks USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

GRANT SELECT,INSERT,UPDATE ON brand_kits TO lbt_app;
GRANT SELECT,INSERT,UPDATE ON brand_assets TO lbt_app;
GRANT SELECT,INSERT ON request_messages TO lbt_app;
GRANT UPDATE (read_by_client_at) ON request_messages TO lbt_app;     -- a client may only mark staff replies as read
GRANT SELECT,INSERT,DELETE ON private_detail_ticks TO lbt_app;

-- A sent message can be marked read, never edited or removed.
CREATE FUNCTION request_messages_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Messages cannot be deleted'; END IF;
  IF NEW.body IS DISTINCT FROM OLD.body OR NEW.author_kind IS DISTINCT FROM OLD.author_kind OR NEW.author_user_id IS DISTINCT FROM OLD.author_user_id
     OR NEW.request_id IS DISTINCT FROM OLD.request_id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Messages cannot be edited';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER request_messages_guard BEFORE UPDATE OR DELETE ON request_messages FOR EACH ROW EXECUTE FUNCTION request_messages_guard();
