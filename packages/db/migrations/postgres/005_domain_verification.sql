-- Proving control of a link domain before it is allowed a certificate. The
-- install mints a token per domain; the admin publishes it as a TXT record at
-- _clickmonk.<host>; the worker looks it up and marks the domain verified.
--
-- Only `domains` is altered here. The redirect's snapshot load reads `links`
-- and then `domains` in one transaction, so a migration that took an
-- exclusive lock on both, in the other order, could deadlock against it and
-- be the statement Postgres aborts. One table cannot.
--
-- The column is added without a default, filled, and only then given one:
-- adding it with a volatile default rewrites the table instead.
ALTER TABLE domains ADD COLUMN verification_token text;
UPDATE domains SET verification_token = replace(gen_random_uuid()::text, '-', '') WHERE verification_token IS NULL;
ALTER TABLE domains
  ALTER COLUMN verification_token SET NOT NULL,
  ALTER COLUMN verification_token SET DEFAULT replace(gen_random_uuid()::text, '-', ''),
  -- The write gate for anything that bypasses the application, such as
  -- hand-written SQL. A token that is not 32 random hex characters is one an
  -- outsider might guess, and a guessable token is the whole of what stands
  -- between a host name pointed at this server and a certificate for it.
  ADD CONSTRAINT domains_verification_token_valid CHECK (verification_token ~ '^[0-9a-f]{32}$');

-- The result of the last DNS check, in its own table rather than in
-- `domains`: every write to `domains` fires `config_changed` from a statement
-- trigger, and a check that runs every few minutes must not make the redirect
-- reload its whole configuration each time. Nothing the redirect serves is
-- here, so nothing needs to notify it.
CREATE TABLE domain_dns_checks (
  domain_id  uuid        PRIMARY KEY REFERENCES domains(id) ON DELETE CASCADE,
  status     text        NOT NULL CHECK (status IN ('verified', 'missing_token', 'error')),
  detail     text        NOT NULL CHECK (length(detail) <= 500),
  checked_at timestamptz NOT NULL DEFAULT now()
);
