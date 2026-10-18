-- Staff control over the add-on catalogue: switch a feature off, or move it to another monthly plan, without a deploy.
-- The built-in catalogue (src/platform/features.ts) is the default; a row here overrides it.
CREATE TABLE feature_settings (
  code text PRIMARY KEY CHECK (length(code) BETWEEN 1 AND 60),
  enabled boolean NOT NULL DEFAULT true,
  min_plan text CHECK (min_plan IS NULL OR min_plan IN ('starter','business','operations')),
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Platform table: staff write through the system role; no client may touch it.
