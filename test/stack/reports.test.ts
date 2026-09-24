import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  ADMIN_HOST,
  CA_MOUNT,
  type CurlResult,
  WAIT_TIMEOUT,
  cli,
  cliWithInput,
  compose,
  curl,
  publishZone,
  until,
  writeAcmeRoot,
  writeIssuingRoot,
} from './stack.js'

/**
 * A click, all the way through, and then read back out.
 *
 * Every other test of these reports inserts its rows into ClickHouse itself, so
 * none of them can fail when the admin container is given the wrong variable
 * name for the store, when Compose forgets to give it one at all, or when a
 * real click never reaches the rollup. This suite clicks a link through Caddy
 * and reads the number back through the admin host over real HTTPS, which is
 * the one path where every link in the chain has to be right.
 */
const EMAIL = 'admin@example.com'
const PASSWORD = 'a decent admin password'
const LINK_HOST = 'rep.example.test'
const SLUG = 'r1'
const TARGET = 'https://example.com/report'
/** Clicks to make. Three, so a count of one or of every request is visibly wrong. */
const CLICKS = 3

/**
 * What the redirect answers a name it does not serve, in plain text, and the
 * header the admin API puts on every one of its own answers including its
 * refusals. A status alone cannot tell the two services apart — the redirect's
 * 404 for an unknown slug and the admin API's 404 for a host it does not answer
 * on are the same number — so the test that no report is served on a link domain
 * reads both.
 */
const REDIRECT_404 = 'Not found.\n'
const ADMIN_ONLY_HEADER = /^content-security-policy:/im

let root = ''
let cookie = ''
let setUp = false
let failures = 0
/** The address the client container used, read from the client rather than written here. */
let clientIp = ''
/**
 * How many retention passes had logged a result by the time the clicks were
 * countable. The pass the retention test reads has to be one that ran with the
 * clicks already in the store, and this is the only way to say that without
 * sleeping: it waits for the count to grow.
 */
let passesWithClicks = 0

function api(
  method: string,
  path: string,
  o: { body?: string; cookie?: string; origin?: string } = {},
): CurlResult {
  const args = ['--cacert', root, '--max-time', '60', '-X', method, '-D', '-']
  if (o.body !== undefined) {
    args.push('-H', 'content-type: application/json', '--data-binary', o.body)
  }
  if (o.cookie) args.push('-H', `cookie: ${o.cookie}`)
  if (o.origin !== undefined) args.push('-H', `origin: ${o.origin}`)
  args.push(`https://${ADMIN_HOST}${path}`)
  return curl(args, CA_MOUNT, { body: true })
}

/** The window every request below asks for: a day either side of now, in UTC. */
function window(): string {
  const now = Date.now()
  const from = new Date(now - 86_400_000).toISOString()
  const to = new Date(now + 86_400_000).toISOString()
  return `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
}

const cookieFrom = (headers: string): string => {
  const line = headers.split('\n').find((l) => /^set-cookie:/i.test(l)) ?? ''
  return (line.slice(line.indexOf(':') + 1).split(';')[0] ?? '').trim()
}

/**
 * The result line every retention pass writes, one per pass. The line the worker
 * writes at start says the pass was *started*; this one says a pass *ran*, and
 * what it decided, which is the difference between the two things the retention
 * tests below want to know.
 */
const PASS_LINE = /retention: dropped (\d+), blanked (\d+), skipped \d+/g

const passes = (): string[] =>
  [...compose('logs', '--no-color', 'worker').matchAll(PASS_LINE)].map((m) => m[0] as string)

afterEach((ctx) => {
  if (ctx.task.result?.state === 'fail') failures++
})

beforeAll(async () => {
  compose('down', '-v')
  writeAcmeRoot()
  publishZone()
  compose('up', '-d', '--build', '--wait', ...WAIT_TIMEOUT)
  root = writeIssuingRoot()
  cliWithInput(PASSWORD, 'admin', 'create', EMAIL)
  // No DNS proof for this host: the escape hatch exists for exactly this, and
  // the suite that tests verification is the one that publishes a token.
  cli('domain', 'add', LINK_HOST, '--verified')
  cli('link', 'add', LINK_HOST, SLUG, '--target', TARGET)

  // The certificate for the admin host is obtained on the first HTTPS request,
  // so wait for the handshake before signing in.
  await until('a certificate for the admin host', 120_000, () => api('GET', '/api/me').exit === 0)
  const signedIn = api('POST', '/api/session', {
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    origin: `https://${ADMIN_HOST}`,
  })
  if (signedIn.status !== 200)
    throw new Error(`sign-in failed: ${signedIn.status} ${signedIn.body}`)
  cookie = cookieFrom(signedIn.headers)

  // The clicks. Plain HTTP, which is what a link domain with no certificate
  // answers on, and the client's own address is read back out of the last one.
  //
  // No wait for the redirect to know the link: a write to `links` notifies, the
  // snapshot reloads a quarter of a second later, and the certificate wait and
  // the sign-in above both happen in between. A 404 here is therefore a link
  // that was never created rather than one that has not arrived yet, which is
  // what the message says.
  for (let i = 0; i < CLICKS; i++) {
    const r = curl(['--max-time', '30', '-D', '-', `http://${LINK_HOST}/${SLUG}`], [], {
      body: true,
    })
    if (r.status !== 302) throw new Error(`click ${i} answered ${r.status}: ${r.body}`)
    clientIp = r.ip
  }

  // A segment seals after two seconds or 8 MB, and the shipper takes a pass a
  // second: a few seconds in normal operation, waited for rather than slept
  // through.
  await until('the clicks to reach the rollups', 120_000, () => {
    const r = api('GET', `/api/reports/summary?${window()}`, { cookie })
    if (r.status !== 200) return false
    return (JSON.parse(r.body) as { clicks: number }).clicks >= CLICKS
  })
  passesWithClicks = passes().length
  setUp = true
}, 900_000)

afterAll(() => {
  try {
    if (failures > 0 || !setUp) console.error(compose('logs', '--no-color', '--tail', '200'))
  } finally {
    compose('down', '-v')
  }
}, 300_000)

describe('a report of real clicks', () => {
  it('counts them, and counts the one client as one visitor', () => {
    const r = api('GET', `/api/reports/summary?${window()}`, { cookie })
    expect(r.status, r.body).toBe(200)
    const body = JSON.parse(r.body) as {
      clicks: number
      visitors: number
      byOutcome: Record<string, number>
      newestHour: string | null
    }
    expect(body.clicks).toBe(CLICKS)
    // Three requests from one client that kept no cookies: three visitor ids,
    // because a visitor without a cookie is a new visitor. Stated rather than
    // asserted as one, because it is the honest behaviour and the README says
    // so.
    expect(body.visitors).toBe(CLICKS)
    expect(body.byOutcome.target).toBe(CLICKS)
    expect(body.newestHour).not.toBeNull()
  })

  it('puts them in the chart, in the hour they happened', () => {
    const r = api('GET', `/api/reports/timeseries?${window()}&bucket=hour`, { cookie })
    expect(r.status, r.body).toBe(200)
    const buckets = (JSON.parse(r.body) as { buckets: { clicks: number }[] }).buckets
    expect(buckets.reduce((n, b) => n + b.clicks, 0)).toBe(CLICKS)
    // Two days of hours, all present, because a chart fills its gaps.
    expect(buckets.length).toBeGreaterThan(24)
  })

  it('breaks them down by the target rotation chose', () => {
    const r = api('GET', `/api/reports/breakdown?${window()}&dimension=target`, { cookie })
    expect(r.status, r.body).toBe(200)
    const rows = (JSON.parse(r.body) as { rows: { value: string; clicks: number }[] }).rows
    expect(rows).toHaveLength(1)
    expect(rows[0]?.clicks).toBe(CLICKS)
    // One target, so its id is the only value: a uuid, and not an empty string.
    expect(rows[0]?.value).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('shows them in the log as networks, never as the address they came from', () => {
    const r = api('GET', `/api/clicks?${window()}`, { cookie })
    expect(r.status, r.body).toBe(200)
    const clicks = (JSON.parse(r.body) as { clicks: { network: string; destination: string }[] })
      .clicks
    expect(clicks).toHaveLength(CLICKS)
    expect(clicks[0]?.destination).toBe(TARGET)
    expect(clicks[0]?.network).toMatch(/\/(24|64)$/)
    // The whole address the client really used, which is read from the client
    // and never written down here: no response may contain it.
    expect(clientIp.length).toBeGreaterThan(0)
    expect(r.body).not.toContain(clientIp)
  })

  // One assertion here goes through Caddy rather than through `inject`, and a
  // reverse proxy is allowed to buffer a small chunked body and add a length of
  // its own. If `content-length` turns up on this response, read the whole
  // header block and Caddy's configuration before touching the assertion: the
  // property that matters is that this service did not buffer the file, which
  // the unit test pins directly. A length added by the proxy is a different
  // fact, and it belongs in the README's limits rather than in a relaxed
  // assertion here.
  it('exports them as a file, streamed, and says it was not cut', () => {
    const r = api('GET', `/api/clicks.csv?${window()}`, { cookie })
    expect(r.status, r.body).toBe(200)
    expect(r.headers).toMatch(/^content-type: text\/csv; charset=utf-8/im)
    expect(r.headers).toMatch(/^content-disposition: attachment; filename="clicks-/im)
    expect(r.headers).toMatch(/^x-clickmonk-truncated: false/im)
    // Streamed, so no length was known in advance.
    expect(r.headers).not.toMatch(/^content-length:/im)
    // Split on the newline alone, not on the CRLF this file is really written
    // with: the client helper normalises every CRLF in what curl wrote so that
    // a header block can be told from a body at all, so the line ending cannot
    // be read back out here. It is not unpinned — the unit test compares a
    // written line byte for byte. What this counts is the rows.
    const lines = r.body.split('\n').filter((l) => l.length > 0)
    expect(lines).toHaveLength(CLICKS + 1)
    expect(lines[0]).toContain('"network"')
    expect(r.body).not.toContain(clientIp)
  })

  it('answers a script holding a key, not only a browser holding a cookie', () => {
    const made = api('POST', '/api/keys', {
      body: JSON.stringify({ name: 'reporting' }),
      cookie,
      origin: `https://${ADMIN_HOST}`,
    })
    expect(made.status, made.body).toBe(201)
    const key = (JSON.parse(made.body) as { key: string }).key
    const r = curl(
      [
        '--cacert',
        root,
        '--max-time',
        '60',
        '-D',
        '-',
        '-H',
        `authorization: Bearer ${key}`,
        `https://${ADMIN_HOST}/api/reports/summary?${window()}`,
      ],
      CA_MOUNT,
      { body: true },
    )
    expect(r.status, r.body).toBe(200)
    expect((JSON.parse(r.body) as { clicks: number }).clicks).toBe(CLICKS)
  })

  it('does not answer a report on a link domain', () => {
    const r = curl(['--max-time', '30', '-D', '-', `http://${LINK_HOST}/api/reports/summary`], [], {
      body: true,
    })
    // The redirect's own 404 for an unknown slug, not the admin API's anything:
    // the status is the same number on both services, so the body and the header
    // the admin API never leaves off are what say which one answered.
    //
    // **This request is itself a click**, recorded with outcome `not_found`, so
    // from here on the number of clicks in the window is four and not three.
    // Anything after this one reads an outcome rather than the total.
    expect(r.status).toBe(404)
    expect(r.body).toBe(REDIRECT_404)
    expect(r.headers).not.toMatch(ADMIN_ONLY_HEADER)
  })
})

describe('the install', () => {
  it('says how long it keeps what it records', () => {
    const out = cli('settings', 'show')
    expect(out).toContain('keep clicks: 90 days')
    expect(out).toContain('keep addresses: 30 days')
  })

  it('takes a shorter period and reports it back', () => {
    cli('settings', 'set', '--keep-clicks', '30', '--keep-addresses', '7')
    const r = api('GET', '/api/settings', { cookie })
    expect(r.status, r.body).toBe(200)
    expect((JSON.parse(r.body) as { retention: unknown }).retention).toEqual({
      rawRetentionDays: 30,
      ipRetentionDays: 7,
    })
  })

  it('is running the retention pass, and has deleted nothing', async () => {
    // A period is a floor and the partition is this month, so the right
    // behaviour here is that a pass ran and dropped nothing. Two passes past the
    // count taken once the clicks were countable, so at least one of them began
    // after they were in the store: a pass logs its result at the end, so the
    // first one past that count could have read the partition before them.
    await until(
      'a retention pass over a partition holding the clicks',
      120_000,
      () => passes().length >= passesWithClicks + 2,
    )
    // The line the worker writes at start, which says the pass was started at
    // all, and then every pass's own result. Each pass decided about a partition
    // whose month has not ended, and every one of them left it alone.
    expect(compose('logs', '--no-color', 'worker')).toContain('retention periods')
    for (const line of passes()) expect(line).toMatch(/dropped 0, blanked 0,/)
    // What would have changed if any of them had been wrong. The clicks that
    // reached a target, not the total: the 404 above is a click too, so the total
    // here is four, and a number that counts something a test did on its way past
    // is a number that changes when the tests are reordered. A dropped partition
    // takes every outcome with it, so this sees it either way.
    const r = api('GET', `/api/reports/summary?${window()}`, { cookie })
    expect(r.status, r.body).toBe(200)
    const body = JSON.parse(r.body) as { byOutcome: Record<string, number> }
    expect(body.byOutcome.target).toBe(CLICKS)
  })
})
