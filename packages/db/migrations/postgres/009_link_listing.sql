-- The order the link list is read in: newest first, the id breaking ties
-- between links created in the same transaction.
--
-- CREATE INDEX takes a SHARE lock on links for as long as it runs. That blocks
-- writes to links and does not conflict with the ACCESS SHARE lock the
-- redirect's snapshot load takes, so a reload during this migration is not
-- held up by it, and the lock is on one table, so it cannot be half of a
-- deadlock. Not CONCURRENTLY: the migrator runs each file in a transaction,
-- and CREATE INDEX CONCURRENTLY cannot run inside one.
CREATE INDEX IF NOT EXISTS links_created_idx ON links (created_at DESC, id DESC);
