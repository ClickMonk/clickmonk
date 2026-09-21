-- One row per click the redirect answered, including 404s and blocks.
--
-- ReplacingMergeTree keyed by (link_id, time, click_id): a spool segment the
-- worker ships twice (a crash between insert and delete) produces duplicate
-- rows until a merge collapses them. `time` is assigned once by the redirect
-- and travels in the spool, so both copies are identical. Every count must
-- still aggregate by click_id, because merges run when ClickHouse chooses.
--
-- Location is country, region, city and the source database from day one.
-- v1 fills country only; city-level later is a lookup change, not a
-- migration. Traffic class and signals arrive in a later additive migration.
CREATE TABLE IF NOT EXISTS clicks (
  click_id      UUID,
  time          DateTime64(3, 'UTC'),
  host          String,
  path          String,
  domain_id     UUID,
  link_id       UUID,
  outcome       LowCardinality(String),
  step          LowCardinality(String),
  status        UInt16,
  destination   String,
  target_id     String,
  visitor_id    String,
  returning     UInt8,
  country       LowCardinality(String),
  region        String,
  city          String,
  geo_source    LowCardinality(String),
  device        LowCardinality(String),
  user_agent    String,
  referrer      String,
  ip            String,
  cap_unchecked UInt8
)
ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(time)
ORDER BY (link_id, time, click_id);
