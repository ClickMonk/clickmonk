-- Hourly rollups, written by materialized views as clicks arrive. Every report
-- but the click log and its export reads these and never the raw table.
--
-- WHY EVERY MEASURE IS A SET AND NOT A COUNTER. A materialized view fires on
-- the block that was inserted, before any merge, so it never sees the
-- ReplacingMergeTree collapse that makes a re-shipped segment harmless in
-- `clicks`. The spool's contract says a segment will be shipped twice: the
-- worker deletes a segment after ClickHouse accepts it, and a crash in between
-- re-ships it byte for byte. A count() column would double that segment's
-- clicks here while `uniqExact(click_id)` on the raw table stayed right, and
-- the chart and the log would disagree with nobody able to say which was
-- true. uniqExact over the click id makes the second copy free.
--
-- AND WHY VISITORS ARE A SET TOO, for a second reason: they do not sum. A
-- visitor who clicks two links is one visitor for the install and one for each
-- link, so adding the per-link numbers gives two. Merging the states gives
-- one. The same holds across any other dimension: one visitor with a human
-- click and a bot click is one visitor.
--
-- WHY TWO TABLES. Keying one table by every dimension is a cross product, and
-- a referrer host is whatever somebody linked from: one click carrying a new
-- referrer, browser and country makes its own row, and at worst the rollup
-- grows as fast as the raw table it exists to avoid reading. So the three
-- closed dimensions — class, action and outcome, none of which can gain a
-- value without a new click record version — are keys here, and the six open
-- ones are rows of clicks_hourly_dim below.
--
-- The state columns are named `_state` because a column called `clicks` that
-- holds an AggregateFunction is a name a query cannot alias its own output to:
-- `uniqExactMerge(clicks) AS clicks, uniqExactMergeIf(clicks, …)` resolves the
-- second `clicks` to the alias and fails with "Illegal type UInt64 of argument
-- for aggregate function with Merge suffix", which reads like a schema fault
-- and is not one.
--
-- Nothing here is ever dropped by the retention pass. These tables are small,
-- and they are what answers a question older than the raw window.
--
-- WHY THE KEY BELOW IS WHAT IT IS. `hour` leads it because every report bounds
-- a window first, and the link comes next because per-link is the other filter
-- every report has. Every one of the six columns is in the key rather than
-- merely carried, and a column left out of it is not a smaller breakdown but a
-- wrong one: AggregatingMergeTree merges rows that share a sort key, so two
-- rows differing only in the missing column become one, its value taken from
-- whichever row the merge read first, while the total over the table stays
-- right. `domain_id` needs saying twice over, because a click on no link at
-- all — an unknown slug, a domain root — has the zero link id and its domain
-- is whichever domain was asked, so without it in the key those rows merge
-- across domains.
CREATE TABLE IF NOT EXISTS clicks_hourly (
  hour           DateTime('UTC'),
  link_id        UUID,
  domain_id      UUID,
  traffic_class  LowCardinality(String),
  action         LowCardinality(String),
  outcome        LowCardinality(String),
  clicks_state   AggregateFunction(uniqExact, UUID),
  visitors_state AggregateFunction(uniqExact, String)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(hour)
ORDER BY (hour, link_id, domain_id, traffic_class, action, outcome);

-- The same holds for the key below, and `dimension` is the column it is
-- easiest to think safe: the six views write one table, and a click with no
-- country, no referrer and no target writes an empty value under three
-- different dimensions in the same hour for the same link. Those three rows
-- differ in nothing but `dimension`, so leaving it out of the key does not
-- blur a breakdown — it makes two of the six dimensions disappear.
--
-- `domain_id` is here although nothing reads it yet, and that is a decision
-- rather than an oversight. A per-domain breakdown is the first thing an
-- operator with several domains asks for, and adding a key column to an
-- aggregating rollup after the fact is a migration *and* a backfill of every
-- row already in it. It also costs nothing now: the only groups that can span
-- two domains are the ones on the zero link id, because every other click's
-- domain follows from its link. It is in the sort key for the same reason it is
-- on the table above — rows that differ only by domain must not merge.
CREATE TABLE IF NOT EXISTS clicks_hourly_dim (
  hour           DateTime('UTC'),
  link_id        UUID,
  domain_id      UUID,
  dimension      LowCardinality(String),
  value          String,
  clicks_state   AggregateFunction(uniqExact, UUID),
  visitors_state AggregateFunction(uniqExact, String)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(hour)
ORDER BY (hour, link_id, domain_id, dimension, value);

-- One view per dimension, all writing here. An empty value is kept rather than
-- filtered out: an empty country is a click whose address could not be looked
-- up, an empty referrer is a visitor who arrived with none, and an empty target
-- is a click that reached no target. A breakdown that silently dropped them
-- would not add up to the total beside it.

CREATE MATERIALIZED VIEW IF NOT EXISTS clicks_hourly_mv TO clicks_hourly AS
SELECT
  toStartOfHour(time) AS hour,
  link_id,
  domain_id,
  traffic_class,
  action,
  outcome,
  uniqExactState(click_id) AS clicks_state,
  uniqExactState(visitor_id) AS visitors_state
FROM clicks
GROUP BY hour, link_id, domain_id, traffic_class, action, outcome;

CREATE MATERIALIZED VIEW IF NOT EXISTS clicks_hourly_country_mv TO clicks_hourly_dim AS
SELECT toStartOfHour(time) AS hour, link_id, domain_id, 'country' AS dimension, country AS value,
       uniqExactState(click_id) AS clicks_state, uniqExactState(visitor_id) AS visitors_state
FROM clicks GROUP BY hour, link_id, domain_id, value;

CREATE MATERIALIZED VIEW IF NOT EXISTS clicks_hourly_device_mv TO clicks_hourly_dim AS
SELECT toStartOfHour(time) AS hour, link_id, domain_id, 'device' AS dimension, device AS value,
       uniqExactState(click_id) AS clicks_state, uniqExactState(visitor_id) AS visitors_state
FROM clicks GROUP BY hour, link_id, domain_id, value;

CREATE MATERIALIZED VIEW IF NOT EXISTS clicks_hourly_os_mv TO clicks_hourly_dim AS
SELECT toStartOfHour(time) AS hour, link_id, domain_id, 'os' AS dimension, os AS value,
       uniqExactState(click_id) AS clicks_state, uniqExactState(visitor_id) AS visitors_state
FROM clicks GROUP BY hour, link_id, domain_id, value;

CREATE MATERIALIZED VIEW IF NOT EXISTS clicks_hourly_browser_mv TO clicks_hourly_dim AS
SELECT toStartOfHour(time) AS hour, link_id, domain_id, 'browser' AS dimension, browser AS value,
       uniqExactState(click_id) AS clicks_state, uniqExactState(visitor_id) AS visitors_state
FROM clicks GROUP BY hour, link_id, domain_id, value;

-- The referrer is stored whole and rolled up by host, which is what a report
-- shows: `domain()` is ClickHouse's own host extraction, so the rollup and the
-- raw log cannot come to disagree about where a click came from. A referrer
-- that is not a URL gives an empty host, which is the same value as none.
CREATE MATERIALIZED VIEW IF NOT EXISTS clicks_hourly_referrer_mv TO clicks_hourly_dim AS
SELECT toStartOfHour(time) AS hour, link_id, domain_id, 'referrer' AS dimension, domain(referrer) AS value,
       uniqExactState(click_id) AS clicks_state, uniqExactState(visitor_id) AS visitors_state
FROM clicks GROUP BY hour, link_id, domain_id, value;

-- Which target rotation chose, which is the per-target count the product
-- promises. Empty for a click that reached no target at all.
CREATE MATERIALIZED VIEW IF NOT EXISTS clicks_hourly_target_mv TO clicks_hourly_dim AS
SELECT toStartOfHour(time) AS hour, link_id, domain_id, 'target' AS dimension, target_id AS value,
       uniqExactState(click_id) AS clicks_state, uniqExactState(visitor_id) AS visitors_state
FROM clicks GROUP BY hour, link_id, domain_id, value;
