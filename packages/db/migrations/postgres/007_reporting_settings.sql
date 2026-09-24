-- How long this install keeps the two things it can stop keeping. Both are
-- an operator's policy rather than a deployment's, which is why they are on
-- this row and not in the environment, and it is the same argument that put
-- the traffic actions here.
--
-- NULL means for ever, for either. Zero was rejected as the forever value
-- because it reads equally as "drop everything now", and the difference
-- between those two readings is every click this install has.
--
-- Only `settings` is altered. The redirect's snapshot load reads links, then
-- domains, then settings in one transaction, so this takes an exclusive lock
-- on exactly one of the tables that reload reads — and the last of them — so
-- it can block a reload but can never be half of a deadlock.
--
-- Deliberately NOT a check that the IP period is the shorter of the two. It
-- usually is, and an IP period that outlives the clicks it belongs to simply
-- never runs, but a constraint saying so would refuse an operator who is
-- *lowering* the raw period below the IP period — the tightening direction —
-- and being refused for keeping less is the wrong way round. The API and the
-- CLI say so in a note instead.
ALTER TABLE settings
  ADD COLUMN raw_retention_days integer DEFAULT 90,
  ADD COLUMN ip_retention_days  integer DEFAULT 30,
  ADD CONSTRAINT settings_raw_retention_valid
    CHECK (raw_retention_days IS NULL OR raw_retention_days BETWEEN 1 AND 3650),
  ADD CONSTRAINT settings_ip_retention_valid
    CHECK (ip_retention_days IS NULL OR ip_retention_days BETWEEN 1 AND 3650);
