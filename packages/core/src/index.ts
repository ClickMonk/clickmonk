/**
 * The highest migration version this build understands. Every migration bumps
 * it; `migrate()` refuses to run against a database whose ledger is newer.
 */
export const SCHEMA_VERSION = 0

export * from './click-id.js'
export * from './device.js'
export * from './link.js'
export * from './passthrough.js'
export * from './rotation.js'
export * from './tokens.js'
