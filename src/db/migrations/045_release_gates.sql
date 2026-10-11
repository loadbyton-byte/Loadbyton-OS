-- Platform release-readiness register: each external or governance gate has an owner, submitted evidence, and an acceptance by a different person.
CREATE TABLE release_gates (
 key text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{2,60}$'), area text NOT NULL, title text NOT NULL, evidence_required text NOT NULL, blocking boolean NOT NULL DEFAULT true,
 status text NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started','in_progress','evidence_submitted','accepted','waived')),
 owner_name text, owner_user_id uuid REFERENCES users(id), evidence_note text, evidence_ref text, submitted_by uuid REFERENCES users(id), submitted_at timestamptz,
 decided_by uuid REFERENCES users(id), decided_at timestamptz, decision_note text, valid_until date, updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK (status NOT IN ('evidence_submitted','accepted') OR (evidence_note IS NOT NULL AND submitted_by IS NOT NULL)),
 CHECK (status NOT IN ('accepted','waived') OR (decided_by IS NOT NULL AND decided_at IS NOT NULL AND decision_note IS NOT NULL AND valid_until IS NOT NULL))
);
CREATE TABLE release_gate_events (
 id bigserial PRIMARY KEY, gate_key text NOT NULL REFERENCES release_gates(key), actor_id uuid NOT NULL REFERENCES users(id), action text NOT NULL, from_status text, to_status text, note text, at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER release_gate_events_immutable BEFORE UPDATE OR DELETE ON release_gate_events FOR EACH ROW EXECUTE FUNCTION forbid_change();
