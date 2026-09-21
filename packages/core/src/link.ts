import { z } from 'zod'

export type Device = 'ios' | 'android' | 'desktop'
export const DEVICES: readonly Device[] = ['ios', 'android', 'desktop']

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
  slug: string
  enabled: boolean
  targets: Target[]
  backupUrl: string | null
  deviceUrls: Partial<Record<Device, string>>
  returningUrl: string | null
  countries: CountryRule
  clickCap: number | null
  expiresAt: Date | null
  passthrough: boolean
}

export interface Domain {
  id: string
  host: string
  verified: boolean
  rootUrl: string | null
  notFoundUrl: string | null
}

/** Letters, digits, `_` and `-`; starts with a letter or digit; at most 64. Case-sensitive. */
export const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
export const MAX_URL_LENGTH = 2048
export const MAX_TARGETS = 20
const MAX_CLICK_CAP = 1_000_000_000

/**
 * A destination may carry tokens (see tokens.ts). To validate it, every token
 * is replaced with a harmless sample value and the result must parse as an
 * absolute http(s) URL. A token in the host part therefore fails: `{param:x}`
 * renders as `x`, and a host like `x` is allowed by URL, so hosts are also
 * checked to contain no token at all.
 */
export function isDestinationUrl(s: string): boolean {
  if (s.length === 0 || s.length > MAX_URL_LENGTH) return false
  const sample = s.replace(/\{[^{}]{1,80}\}/g, 'x')
  let u: URL
  try {
    u = new URL(sample)
  } catch {
    return false
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false
  const hostPart = /^https?:\/\/([^/?#]*)/i.exec(s)?.[1] ?? ''
  return !hostPart.includes('{')
}

const HOST_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/

/** Lower-cases, strips one trailing dot, and validates a DNS host name. No port. */
export function normaliseHost(host: string): string | null {
  let h = host.trim().toLowerCase()
  if (h.endsWith('.')) h = h.slice(0, -1)
  if (h.length === 0 || h.length > 253) return null
  const labels = h.split('.')
  if (!labels.every((l) => HOST_LABEL.test(l))) return null
  return h
}

const Destination = z.string().refine(isDestinationUrl, {
  message: 'must be an absolute http(s) URL of at most 2048 characters, with no token in the host',
})
const Country = z.string().regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2, upper case')

const CountryRuleSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('all') }),
  z.object({ mode: z.literal('allow'), list: z.array(Country).min(1).max(250) }),
  z.object({ mode: z.literal('block'), list: z.array(Country).min(1).max(250) }),
])

const TargetInput = z.object({
  url: Destination,
  weight: z.number().int().min(1).max(100).optional(),
})

export const LinkInputSchema = z
  .object({
    slug: z.string().regex(SLUG_RE),
    name: z.string().max(200).nullable().default(null),
    enabled: z.boolean().default(true),
    targets: z.array(TargetInput).min(1).max(MAX_TARGETS),
    backupUrl: Destination.nullable().default(null),
    deviceUrls: z
      .object({ ios: Destination, android: Destination, desktop: Destination })
      .partial()
      .strict()
      .default({}),
    returningUrl: Destination.nullable().default(null),
    countries: CountryRuleSchema.default({ mode: 'all' }),
    clickCap: z.number().int().min(1).max(MAX_CLICK_CAP).nullable().default(null),
    expiresAt: z.coerce.date().nullable().default(null),
    passthrough: z.boolean().default(true),
  })
  .strict()
  .transform((l, ctx) => {
    if (l.targets.length === 1) {
      return { ...l, targets: [{ url: l.targets[0]?.url as string, weight: 100 }] }
    }
    if (l.targets.some((t) => t.weight === undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: 'every target needs a weight when there are several',
      })
      return z.NEVER
    }
    const sum = l.targets.reduce((s, t) => s + (t.weight ?? 0), 0)
    if (sum !== 100) {
      ctx.addIssue({ code: 'custom', message: `target weights must sum to 100, got ${sum}` })
      return z.NEVER
    }
    return { ...l, targets: l.targets.map((t) => ({ url: t.url, weight: t.weight as number })) }
  })

export type LinkInput = z.input<typeof LinkInputSchema>
export type ParsedLinkInput = z.output<typeof LinkInputSchema>

export function parseLinkInput(input: unknown): ParsedLinkInput {
  return LinkInputSchema.parse(input)
}
