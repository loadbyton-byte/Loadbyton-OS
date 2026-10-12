-- Website live chat: visitors talk to platform staff. Global (not tenant) data, like platform_leads; the tenant application role has no access.
CREATE TABLE chat_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visitor_hash text NOT NULL UNIQUE,                 -- sha256 of the secret the visitor's browser holds; the secret itself is never stored
  name text,
  email text,
  page text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','closed')),
  staff_unread int NOT NULL DEFAULT 0,
  visitor_unread int NOT NULL DEFAULT 0,
  last_visitor_at timestamptz,
  last_staff_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_threads_status ON chat_threads(status, updated_at DESC);
CREATE TABLE chat_messages (
  id bigserial PRIMARY KEY,
  thread_id uuid NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  sender text NOT NULL CHECK (sender IN ('visitor','staff','system')),
  staff_name text,
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_messages_thread ON chat_messages(thread_id, id);
REVOKE ALL ON chat_threads, chat_messages FROM lbt_app;
REVOKE ALL ON SEQUENCE chat_messages_id_seq FROM lbt_app;
