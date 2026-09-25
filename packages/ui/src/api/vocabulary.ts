/**
 * The closed lists the interface offers, restated from the service's own.
 *
 * Restated rather than imported because the interface imports nothing from the
 * shared package at runtime: its root pulls in Node's crypto module, and a
 * bundle that evaluates a server module at load is a blank page. The test
 * beside this file imports the service's lists — in Node, where that is fine —
 * and fails when the two differ, so a value added there is a failing test here
 * rather than a filter that cannot select it.
 */

export const NON_HUMAN_CLASSES = ['bot', 'abuser', 'anonymous', 'datacenter'] as const
export const TRAFFIC_CLASSES = [...NON_HUMAN_CLASSES, 'human', 'unknown'] as const
export const TRAFFIC_ACTIONS = ['nothing', 'flag', 'block', 'safe'] as const
export const OUTCOMES = [
  'target',
  'device',
  'returning',
  'root',
  'not_found',
  'unknown_domain',
  'expired',
  'capped',
  'country_blocked',
  'blocked',
  'safe',
  'password',
] as const
export const REPORT_DIMENSIONS = [
  'country',
  'device',
  'os',
  'browser',
  'referrer',
  'target',
  'class',
  'action',
  'outcome',
  'link',
] as const
export const DEVICES = ['ios', 'android', 'desktop'] as const
export const IP_SOURCES = ['country', 'asn', 'datacenter', 'tor'] as const

export const CLASS_LABELS: Record<(typeof TRAFFIC_CLASSES)[number], string> = {
  bot: 'Bot',
  abuser: 'Abuser',
  anonymous: 'Anonymous',
  datacenter: 'Datacenter',
  human: 'Human',
  unknown: 'Unknown',
}

export const ACTION_LABELS: Record<(typeof TRAFFIC_ACTIONS)[number], string> = {
  nothing: 'Count it',
  flag: 'Flag it',
  block: 'Block it',
  safe: 'Send to the safe URL',
}

export const OUTCOME_LABELS: Record<(typeof OUTCOMES)[number], string> = {
  target: 'Sent to a target',
  device: 'Sent to a device URL',
  returning: 'Sent to the returning-visitor URL',
  root: 'Domain root',
  not_found: 'Unknown slug',
  unknown_domain: 'Unknown domain',
  expired: 'Link expired',
  capped: 'Click cap reached',
  country_blocked: 'Country not allowed',
  blocked: 'Blocked',
  safe: 'Sent to the safe URL',
  password: 'Asked for the password',
}

export const DIMENSION_LABELS: Record<(typeof REPORT_DIMENSIONS)[number], string> = {
  country: 'Countries',
  device: 'Devices',
  os: 'Operating systems',
  browser: 'Browsers',
  referrer: 'Referrers',
  target: 'Targets',
  class: 'Traffic classes',
  action: 'Actions',
  outcome: 'Outcomes',
  link: 'Links',
}

export const IP_SOURCE_LABELS: Record<(typeof IP_SOURCES)[number], string> = {
  country: 'Countries',
  asn: 'Networks',
  datacenter: 'Hosting networks',
  tor: 'Tor exits',
}
