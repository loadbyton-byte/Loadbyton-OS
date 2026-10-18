-- Ecosystem link with loadbyton.com (master plan §3, §9).
--
-- A tenant (workspace) can be linked to one loadbyton.com organisation. The
-- organisation's entitlement arrives as signed, versioned events and is
-- applied to the linked workspace; until a workspace exists the state is held
-- in ecosystem_orgs. People link through identity_links, never by matching
-- email addresses. None of these tables is readable by the tenant role.

ALTER TABLE tenants ADD COLUMN external_org_sub text UNIQUE;

CREATE TABLE ecosystem_orgs (
  org_sub        text PRIMARY KEY,                  -- loadbyton.com organisation subject id
  name           text NOT NULL,
  verified       boolean NOT NULL DEFAULT false,
  verified_by    text,
  tenant_id      uuid UNIQUE REFERENCES tenants(id),
  last_version   int NOT NULL DEFAULT 0,            -- highest event version applied; older ones are ignored
  plan_code      text,                              -- starter_included | enterprise_included | null
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','grace','suspended','ended')),
  starts_at      timestamptz,
  ends_at        timestamptz,
  grace_until    timestamptz,
  reason         text,
  sector         text,
  accepted_by_sub text,
  accepted_at    timestamptz,
  terms_version  text,
  applied_note   text,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ecosystem_inbox (
  event_id    text PRIMARY KEY,                     -- de-duplication key
  org_sub     text NOT NULL,
  version     int NOT NULL,
  outcome     text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  payload     jsonb NOT NULL
);
CREATE INDEX ecosystem_inbox_org ON ecosystem_inbox (org_sub, version);

CREATE TABLE identity_links (
  subject_id text PRIMARY KEY,                      -- loadbyton.com person subject id
  user_id    uuid NOT NULL UNIQUE REFERENCES users(id),
  org_sub    text,
  linked_at  timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON ecosystem_orgs, ecosystem_inbox, identity_links FROM lbt_app;
