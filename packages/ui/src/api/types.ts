/**
 * The admin API's requests and responses, as the interface uses them. Written
 * from the routes; nothing else in this package declares an API shape.
 *
 * Instants are ISO strings with milliseconds and `Z`, exactly as the service
 * sends them. Nothing here is a `Date`: a value is parsed where it is shown,
 * by `app/format.ts`, and only there.
 */

export type Instant = string

export interface Me {
  email: string
  totpEnabled: boolean
  recoveryCodesLeft: number
  failedLogins?: number
  lockedUntil?: Instant | null
  credential: 'session' | 'key'
}

export interface SignIn {
  email: string
  password: string
  code?: string
  recoveryCode?: string
}

export interface Session {
  id: string
  createdAt: Instant
  lastSeenAt: Instant
  expiresAt: Instant
  userAgent: string
  /** The whole address this session was opened from — the operator's own. */
  ip: string
  current: boolean
}

export interface ApiKey {
  id: string
  name: string
  createdAt: Instant
  lastUsedAt: Instant | null
  expiresAt: Instant | null
  revokedAt: Instant | null
}

/** The one response that carries a key's secret, once. */
export interface NewApiKey {
  id: string
  name: string
  key: string
  expiresAt: Instant | null
}

export type DomainStatus = 'verified' | 'missing_token' | 'error'

export interface Domain {
  id: string
  host: string
  verified: boolean
  rootUrl: string | null
  notFoundUrl: string | null
  verificationRecord: { name: string; type: 'TXT'; value: string }
  lastCheck: { status: DomainStatus; detail: string | null; checkedAt: Instant } | null
  /** When a check last found the token, or never has. */
  passedAt: Instant | null
  /** `verified && passedAt === null`: verified by hand, with no check having passed for it yet. */
  handVerified: boolean
}

export interface DomainCheck {
  status: DomainStatus
  detail: string | null
}

export type TrafficAction = 'nothing' | 'flag' | 'block' | 'safe'
export type NonHumanClass = 'bot' | 'abuser' | 'anonymous' | 'datacenter'

export type CountryRule =
  | { mode: 'all' }
  | { mode: 'allow'; list: string[] }
  | { mode: 'block'; list: string[] }

export interface Target {
  id: string
  url: string
  weight: number
}

export interface Link {
  id: string
  domainId: string
  host: string
  slug: string
  url: string
  name: string | null
  enabled: boolean
  targets: Target[]
  backupUrl: string | null
  deviceUrls: { ios?: string; android?: string; desktop?: string }
  returningUrl: string | null
  countries: CountryRule
  clickCap: number | null
  capUsed: number | null
  expiresAt: Instant | null
  passthrough: boolean
  trafficActions: Partial<Record<NonHumanClass, TrafficAction>>
  hasPassword: boolean
  createdAt: Instant
}

/** What a create sends. `host` names the domain; everything else as `Link`. */
export interface LinkInput {
  host: string
  slug?: string
  name?: string | null
  enabled?: boolean
  targets: { url: string; weight?: number }[]
  backupUrl?: string | null
  deviceUrls?: { ios?: string; android?: string; desktop?: string }
  returningUrl?: string | null
  countries?: CountryRule
  clickCap?: number | null
  expiresAt?: Instant | null
  passthrough?: boolean
  trafficActions?: Partial<Record<NonHumanClass, TrafficAction>>
  password?: string | null
}

/** What an edit sends: only what changed. `password` absent leaves it alone. */
export type LinkPatch = Partial<Omit<LinkInput, 'host'>>

export interface Page<T> {
  items: T[]
  nextCursor: string | null
}

export interface TrafficSettings {
  actions: Record<NonHumanClass, TrafficAction>
  safeUrl: string | null
  abuserThreshold: number
}

export interface RetentionSettings {
  rawRetentionDays: number | null
  ipRetentionDays: number | null
}

export interface Settings {
  traffic: TrafficSettings
  /** Null when the stored row cannot be read — which is not "for ever". */
  retention: RetentionSettings | null
  note: string | null
  problem: string | null
}

export interface SettingsInput {
  traffic: TrafficSettings
  retention: RetentionSettings
}

/** The window a report counted, which may be wider than the one asked for. */
export interface ReportWindow {
  from: Instant
  to: Instant
}

export interface WindowQuery {
  from: Instant
  to: Instant
  link?: string
}

export interface Summary {
  window: ReportWindow
  link: string | null
  clicks: number
  visitors: number
  byClass: Record<string, number>
  byAction: Record<string, number>
  byOutcome: Record<string, number>
  newestHour: Instant | null
}

export interface Timeseries {
  window: ReportWindow
  link: string | null
  bucket: 'hour' | 'day'
  buckets: { at: Instant; clicks: number; visitors: number }[]
  newestHour: Instant | null
}

export interface BreakdownRow {
  value: string
  clicks: number
  visitors: number
  /** Only on a breakdown by link: the link the value names, or null when there is none. */
  link?: { slug: string; host: string; name: string | null } | null
}

export interface Breakdown {
  window: ReportWindow
  link: string | null
  dimension: string
  truncated: boolean
  rows: BreakdownRow[]
}

export interface ClickFilters extends WindowQuery {
  class?: string
  outcome?: string
  country?: string
}

export interface Click {
  clickId: string
  at: Instant
  host: string
  path: string
  domainId: string
  linkId: string
  outcome: string
  step: string
  status: number
  destination: string | null
  targetId: string | null
  visitorId: string
  returning: boolean
  country: string | null
  region: string | null
  city: string | null
  geoSource: string | null
  device: string
  os: string | null
  browser: string | null
  asn: number | null
  class: string | null
  signals: string[]
  action: string | null
  referrer: string | null
  userAgent: string | null
  /** Always a network, never an address; null when blanked or unreadable. */
  network: string | null
  capUnchecked: boolean
}

export interface ClickPage {
  window: ReportWindow
  link: string | null
  clicks: Click[]
  nextCursor: string | null
}

export interface ClickCount {
  window: ReportWindow
  link: string | null
  count: number
  cap: number
  truncated: boolean
}

export type IpSourceStatus = { version: string; fetchedAt: Instant } | null

export interface Status {
  newestHour: Instant | null
  reporting: 'ok' | 'unavailable'
  ipData: Record<'country' | 'asn' | 'datacenter' | 'tor', IpSourceStatus> | null
  ipDataProblem: string | null
  alerts: number
}
