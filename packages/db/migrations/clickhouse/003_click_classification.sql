-- Traffic classification, user-agent families and the ASN, written from
-- spool record version 2 on. A click shipped from a version 1 record has
-- the defaults: an empty class, no signals, no action, an empty OS and
-- browser, and ASN 0. An empty class means "not classified", which is not
-- the same as 'human'.
ALTER TABLE clicks
  ADD COLUMN IF NOT EXISTS traffic_class LowCardinality(String) DEFAULT '',
  ADD COLUMN IF NOT EXISTS signals Array(LowCardinality(String)),
  ADD COLUMN IF NOT EXISTS action LowCardinality(String) DEFAULT '',
  ADD COLUMN IF NOT EXISTS os LowCardinality(String) DEFAULT '',
  ADD COLUMN IF NOT EXISTS browser LowCardinality(String) DEFAULT '',
  ADD COLUMN IF NOT EXISTS asn UInt32 DEFAULT 0;
