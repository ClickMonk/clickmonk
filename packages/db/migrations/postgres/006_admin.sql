-- The one admin account, what authenticates as it, and a link's password.
--
-- Two shapes of credential, stored two ways. The admin's password and a
-- link's password are chosen by people, so they are stored as scrypt hashes
-- and the CHECK below pins that framing: a column holding a plain password —
-- which is what the 2023 version did — would be readable in a backup, in a
-- replica and in every screenshot of a database client. Session tokens, API
-- key secrets are 32 random bytes this install minted, so they are stored as
-- SHA-256 digests: guessing one is hopeless, and a digest means a stolen dump
-- cannot be replayed as a login. A recovery code is neither of those — it is
-- ten characters a person copies onto paper — so it is stored the way a
-- password is; see the table below.
--
-- The pending TOTP secret lives on the account row rather than in a table of
-- its own: there is one account and at most one enrolment in flight, so a
-- table would be a row with a constant key.
--
-- Sessions, API keys and recovery codes each carry `account_id`, a foreign
-- key to `admin_account(id)` — itself always `true`, so the column is a
-- boolean rather than a uuid — with ON DELETE CASCADE: replacing the account
-- (drop the row, create a new one) must not leave a session, an API key or an
-- unused recovery code behind that still authenticates as an account that no
-- longer exists. Without it, an unused recovery code outliving an account
-- replacement would be a second-factor bypass nothing here would show.
--
-- Only `links` is altered here, and `links` is the first table the snapshot
-- reload reads, so this migration can never be the victim of a lock-order
-- deadlock against it. The new tables are new: no reader holds anything on
-- them, and none of them notifies `config_changed`, because nothing the
-- redirect serves is in them.

-- The framing `hashPassword` writes: scrypt, its three parameters, then the
-- salt and the key as base64url. The application refuses a cost that would
-- ask for more than 64 MiB; this only pins the shape, so hand-written SQL
-- cannot leave a plain password or an empty string in a password column.
-- The salt and key floors (22 base64url characters) are not arbitrary: a
-- 16-byte value — the application's own salt length, and the shortest key
-- length it will ever verify against — never encodes to fewer than 22
-- base64url characters, so a hash whose key is too short for the application
-- to accept is already refused here rather than merely rejected later, and
-- the 200-character cap matches the application's own MAX_PASSWORD_HASH_LENGTH.
CREATE FUNCTION is_password_hash(h text) RETURNS boolean
IMMUTABLE LANGUAGE sql AS $$
  SELECT length(h) <= 200
     AND h ~ '^scrypt\$[0-9]{1,9}\$[0-9]{1,4}\$[0-9]{1,4}\$[A-Za-z0-9_-]{22,}\$[A-Za-z0-9_-]{22,}$'
$$;

-- One row, like `settings`: v1 has one admin and no teams, roles or
-- workspaces. The row can be absent — before `clickmonk admin create` runs —
-- and the admin service answers every request with "no admin account yet"
-- while it is.
CREATE TABLE admin_account (
  id             boolean     PRIMARY KEY DEFAULT true CONSTRAINT admin_account_id_valid CHECK (id),
  email          text        NOT NULL
                             CONSTRAINT admin_account_email_valid
                             CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 320
                                    AND position('@' IN email) > 1),
  password_hash  text        NOT NULL
                             CONSTRAINT admin_account_password_hash_valid CHECK (is_password_hash(password_hash)),
  -- Base32, as every authenticator app expects. NULL: not enrolled.
  totp_secret    text        CONSTRAINT admin_account_totp_secret_valid
                             CHECK (totp_secret IS NULL OR totp_secret ~ '^[A-Z2-7]{16,64}$'),
  -- An enrolment the admin started and has not confirmed. The secret is
  -- minted on the server and kept here until a code proves the authenticator
  -- app holds it, so no request field decides which secret gets enrolled; a
  -- pending secret older than the application's window is refused and
  -- replaced rather than honoured.
  totp_pending_secret text  CONSTRAINT admin_account_totp_pending_secret_valid
                             CHECK (totp_pending_secret IS NULL
                                    OR totp_pending_secret ~ '^[A-Z2-7]{16,64}$'),
  totp_pending_at timestamptz,
  -- The last TOTP step accepted. A code is accepted once: anything at or
  -- below this is refused, so a code seen over a shoulder or in a log is
  -- already spent.
  totp_last_step bigint      NOT NULL DEFAULT 0
                             CONSTRAINT admin_account_totp_last_step_valid CHECK (totp_last_step >= 0),
  -- Failed sign-ins since the last success, and the lockout they earned.
  failed_logins  integer     NOT NULL DEFAULT 0
                             CONSTRAINT admin_account_failed_logins_valid CHECK (failed_logins >= 0),
  locked_until   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- What the admin uses when the authenticator app is gone. A code is ten
-- characters a person copies down, so it carries about fifty bits: too few to
-- stand behind one fast digest, because ten of them sit in this table together
-- and a stolen backup would let an attacker test candidates against all ten at
-- once, for a complete second-factor bypass. Each is therefore stored the way
-- the password is, at scrypt cost — free here, because a code is verified at
-- most once in its life — and the CHECK is the same one the password columns
-- carry.
--
-- `id` exists because a salted hash cannot be looked up by value: a recovery
-- sign-in reads the unused rows and verifies against each, then updates the
-- row that matched by its id. It also means two rows for the same code are two
-- different values, so there is nothing here to make unique. `used_at` is what
-- makes a code one-time, and it is kept rather than the row deleted, so the
-- admin can be shown how many are left. `account_id` dies with the account: an
-- unused code from a replaced account must stop working, not sit here as a
-- bypass for whichever account now holds `id = true`.
CREATE TABLE admin_recovery_codes (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id boolean     NOT NULL DEFAULT true REFERENCES admin_account(id) ON DELETE CASCADE,
  code_hash  text        NOT NULL
                         CONSTRAINT admin_recovery_codes_code_hash_valid CHECK (is_password_hash(code_hash)),
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at    timestamptz
);

-- One row per signed-in browser. The cookie carries the token; only its
-- digest is here, so a dump of this table cannot be replayed as a session.
-- Both expiries are stored rather than derived: `expires_at` is the absolute
-- end of the session and `last_seen_at` is what the idle bound is measured
-- from, and a reader must not have to know the application's constants.
-- `account_id` dies with the account, the same as a recovery code.
CREATE TABLE sessions (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   boolean     NOT NULL DEFAULT true REFERENCES admin_account(id) ON DELETE CASCADE,
  token_hash   text        NOT NULL UNIQUE
                           CONSTRAINT sessions_token_hash_valid CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  -- Shown in the session list so the admin can recognise a device. Cut to
  -- this length by the application before it is written.
  user_agent   text        NOT NULL DEFAULT ''
                           CONSTRAINT sessions_user_agent_valid CHECK (length(user_agent) <= 200),
  ip           text        NOT NULL DEFAULT ''
                           CONSTRAINT sessions_ip_valid CHECK (length(ip) <= 45)
);
CREATE INDEX sessions_expires_at ON sessions (expires_at);

-- API keys for the REST API. `id` is the half of a presented key that is not
-- secret: it makes authentication one indexed lookup rather than a scan of
-- every digest. A revoked or expired key keeps its row, so the list shows
-- what was revoked rather than forgetting it happened. `account_id` dies with
-- the account, the same as a session.
CREATE TABLE api_keys (
  id           text        PRIMARY KEY CONSTRAINT api_keys_id_valid CHECK (id ~ '^[0-9a-f]{16}$'),
  account_id   boolean     NOT NULL DEFAULT true REFERENCES admin_account(id) ON DELETE CASCADE,
  name         text        NOT NULL CONSTRAINT api_keys_name_valid CHECK (length(name) BETWEEN 1 AND 100),
  secret_hash  text        NOT NULL
                           CONSTRAINT api_keys_secret_hash_valid CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at   timestamptz,
  revoked_at   timestamptz
);

-- A link's password, hashed the same way the admin's is. NULL: no password,
-- which is every link that existed before this migration. The redirect will
-- hold this in its snapshot and verify against it on the link's own domain;
-- it must never be sent to a visitor.
ALTER TABLE links ADD COLUMN password_hash text
  CONSTRAINT links_password_hash_valid CHECK (password_hash IS NULL OR is_password_hash(password_hash));
