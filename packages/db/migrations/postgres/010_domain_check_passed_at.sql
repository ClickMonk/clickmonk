-- When a domain's DNS check last passed, so a domain verified by hand (no
-- check has ever found its token) can be told apart from one that was
-- checked and found wanting. `domains.verified` alone cannot make that
-- distinction: it is set by a passing check or by `domain add --verified`,
-- and never records which.
--
-- Only `domain_dns_checks` is altered here, for the same reason 005 put the
-- check result in its own table rather than on `domains`: the redirect's
-- snapshot load reads `links` and then `domains` in one transaction, and a
-- migration holding a lock on both, in the other order, could deadlock
-- against it and be the statement Postgres aborts. This migration takes an
-- ACCESS EXCLUSIVE lock on `domain_dns_checks` alone, a table the redirect's
-- snapshot load never reads, so it cannot be either half of that deadlock.
--
-- The column is added without a default, backfilled, and left without one:
-- every future row is written by `recordDomainCheck`'s single upsert, which
-- always states `passed_at` explicitly, so a default would only paper over a
-- caller that forgot to.
ALTER TABLE domain_dns_checks ADD COLUMN passed_at timestamptz NULL;
UPDATE domain_dns_checks SET passed_at = checked_at WHERE status = 'verified';
