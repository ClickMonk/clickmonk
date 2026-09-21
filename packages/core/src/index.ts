/**
 * The highest migration version this build understands. Every migration bumps
 * it; `migrate()` refuses to run against a database whose ledger is newer.
 */
export const SCHEMA_VERSION = 0
