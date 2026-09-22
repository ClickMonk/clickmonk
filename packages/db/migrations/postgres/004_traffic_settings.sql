-- Install-wide traffic settings, and each link's overrides of the traffic
-- actions. The redirect holds both in its snapshot, so settings notify
-- config_changed like links do. The checks below are the write gate for
-- anything that bypasses the application, such as hand-written SQL: the
-- redirect trusts what it loads.

-- True when `a` maps only the four non-human classes to one of the four
-- actions; with `complete`, when it maps all four.
CREATE FUNCTION valid_traffic_actions(a jsonb, complete boolean) RETURNS boolean
IMMUTABLE LANGUAGE sql AS $$
  SELECT jsonb_typeof(a) = 'object'
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_each(a) AS e
        WHERE e.key NOT IN ('bot', 'abuser', 'anonymous', 'datacenter')
           OR e.value NOT IN ('"nothing"'::jsonb, '"flag"'::jsonb, '"block"'::jsonb, '"safe"'::jsonb))
     AND (NOT complete OR a ?& ARRAY['bot', 'abuser', 'anonymous', 'datacenter'])
$$;

CREATE TABLE settings (
  -- One row: the key can only be true.
  id               boolean     PRIMARY KEY DEFAULT true CHECK (id),
  -- Flag, never block, by default: a new install must not turn away real
  -- traffic because a detection list was wrong.
  traffic_actions  jsonb       NOT NULL
                   DEFAULT '{"bot":"flag","abuser":"flag","anonymous":"flag","datacenter":"flag"}'::jsonb
                   CHECK (valid_traffic_actions(traffic_actions, true)),
  safe_url         text        CHECK (safe_url IS NULL OR length(safe_url) <= 2048),
  abuser_threshold integer     NOT NULL DEFAULT 60 CHECK (abuser_threshold BETWEEN 1 AND 100000),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- The safe action needs somewhere to send the click.
  CONSTRAINT settings_safe_needs_url
    CHECK (safe_url IS NOT NULL OR NOT traffic_actions @? '$.* ? (@ == "safe")')
);
INSERT INTO settings DEFAULT VALUES;

ALTER TABLE links ADD COLUMN traffic_actions jsonb NOT NULL DEFAULT '{}'::jsonb
  CHECK (valid_traffic_actions(traffic_actions, false));

CREATE TRIGGER settings_config_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON settings
  FOR EACH STATEMENT EXECUTE FUNCTION notify_config_changed();
