-- Configuration the redirect serves from memory. Every change to domains,
-- links or link_targets notifies `config_changed`, from a trigger rather than
-- from application code, so no writer can forget to tell the redirect.

CREATE TABLE domains (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  host          text        NOT NULL UNIQUE
                            CHECK (host = lower(host) AND length(host) BETWEEN 1 AND 253),
  verified      boolean     NOT NULL DEFAULT false,
  root_url      text        CHECK (root_url IS NULL OR length(root_url) <= 2048),
  not_found_url text        CHECK (not_found_url IS NULL OR length(not_found_url) <= 2048),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE links (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_id     uuid        NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  -- Case-sensitive, as in the core validator.
  slug          text        NOT NULL CHECK (length(slug) BETWEEN 1 AND 64),
  name          text        CHECK (name IS NULL OR length(name) <= 200),
  enabled       boolean     NOT NULL DEFAULT true,
  backup_url    text        CHECK (backup_url IS NULL OR length(backup_url) <= 2048),
  device_urls   jsonb       NOT NULL DEFAULT '{}'::jsonb,
  returning_url text        CHECK (returning_url IS NULL OR length(returning_url) <= 2048),
  countries     jsonb       NOT NULL DEFAULT '{"mode":"all"}'::jsonb,
  click_cap     bigint      CHECK (click_cap IS NULL OR click_cap > 0),
  expires_at    timestamptz,
  passthrough   boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (domain_id, slug)
);

CREATE TABLE link_targets (
  id        uuid     PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id   uuid     NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  url       text     NOT NULL CHECK (length(url) <= 2048),
  weight    smallint NOT NULL CHECK (weight BETWEEN 1 AND 100),
  position  smallint NOT NULL CHECK (position BETWEEN 0 AND 19),
  UNIQUE (link_id, position)
);

-- Click caps only. A row exists once a capped link has been clicked. Mutated
-- in place on the redirect path, which is why it lives here and not in
-- ClickHouse.
CREATE TABLE link_counters (
  link_id  uuid   PRIMARY KEY REFERENCES links(id) ON DELETE CASCADE,
  clicks   bigint NOT NULL DEFAULT 0 CHECK (clicks >= 0)
);

CREATE FUNCTION notify_config_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('config_changed', TG_TABLE_NAME);
  RETURN NULL;
END
$$;

CREATE TRIGGER domains_config_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON domains
  FOR EACH STATEMENT EXECUTE FUNCTION notify_config_changed();
CREATE TRIGGER links_config_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON links
  FOR EACH STATEMENT EXECUTE FUNCTION notify_config_changed();
CREATE TRIGGER link_targets_config_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON link_targets
  FOR EACH STATEMENT EXECUTE FUNCTION notify_config_changed();
