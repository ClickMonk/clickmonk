/**
 * The highest migration version this build understands. Every migration bumps
 * it; `migrate()` refuses to run against a database whose ledger is newer.
 */
export const SCHEMA_VERSION = 6

export * from './attempts.js'
export * from './click-id.js'
export * from './click-record.js'
export * from './config-error.js'
export * from './device.js'
export * from './domain-verification.js'
export * from './evaluate.js'
export * from './link.js'
export * from './passthrough.js'
export * from './rotation.js'
export * from './secrets.js'
export * from './settings.js'
export * from './tokens.js'
export * from './totp.js'
export * from './traffic.js'
export * from './user-agent.js'
