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
const HOUR_MS = 3_600_000
/**
 * An address per click, so that "no response carries the address a click came
 * from" is a claim about every row rather than about whichever row happens to
 * carry the newest client's. Docker hands a container the next free address in
 * the pool, which gave all three of these the same one when the suite let it
 * choose — and an older row leaking its address then passed, because the address
 * it leaked was the newest one. High in the range the compose file declares, so
 * they are clear of the addresses the stack's own containers are allocated.
 */
const CLIENT_IPS = ['172.30.0.201', '172.30.0.202', '172.30.0.203']

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
/**
 * The addresses the client containers reported for themselves, one per click.
 * Read back out of each client rather than trusted to be the ones asked for
 * above, and asserted to be three different addresses before anything is
 * concluded from them.
 */
const clientIps: string[] = []
/**
 * The hours the clicks could have landed in: the hour the first went out and the
 * hour the last did. One hour in every run so far — three requests take under a
 * second — and two if a run crosses a boundary between them, which is why it is
 * a list.
 */
let clickHours: string[] = []
/**
 * The outcome on the one row the retention test writes for itself, which is how
 * that row is counted and told apart from every click this suite really made.
 */
const OLD_OUTCOME = 'expired'
/**
 * And the outcome on the row the blanking test writes for itself. Its own value,
 * so the two retention tests cannot read each other's row: the first drops its
 * row and the second must find exactly one.
 */
const BLANK_OUTCOME = 'capped'

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

/** Hours either side of the hour this run is in that the window below covers. */
const WINDOW_HOURS_EITHER_SIDE = 24

/**
 * The window every request below asks for, in UTC, with both ends **on the
 * hour**.
 *
 * Aligned rather than "now, give or take a day", because a report raises an
 * unaligned `to` to the next hour and the chart then holds 48 buckets or 49
 * depending on what minute the run started. Aligned, the count is one number and
 * the chart test can assert it.
 */
function window(): string {
  const hour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS
  const from = new Date(hour - WINDOW_HOURS_EITHER_SIDE * HOUR_MS).toISOString()
  const to = new Date(hour + WINDOW_HOURS_EITHER_SIDE * HOUR_MS).toISOString()
  return `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
}

/** The hour an instant falls in, spelled the way a chart bucket spells it. */
const hourOf = (ms: number): string => new Date(Math.floor(ms / HOUR_MS) * HOUR_MS).toISOString()

const cookieFrom = (headers: string): string => {
  const line = headers.split('\n').find((l) => /^set-cookie:/i.test(l)) ?? ''
  return (line.slice(line.indexOf(':') + 1).split(';')[0] ?? '').trim()
}

/**
 * One statement against ClickHouse, run from the worker container and therefore
 * through the four variables the install gives it: the store is reached with the
 * install's own configuration, and no password is written here.
 *
 * It exists because no report can answer what the retention test asks. Every
 * report reads a rollup; the pass drops partitions of `clicks` and blanks
 * addresses in `clicks`, and never touches a rollup. A pass that had deleted
 * every raw click would leave the summary, the chart and the breakdown answering
 * exactly what they answered before.
 *
 * POST with the statement as the body rather than a query parameter, because the
 * HTTP interface treats a GET as read-only and the retention test writes a row.
 */
const RUN_IN_STORE = `
const u = new URL(process.env.CLICKMONK_CLICKHOUSE_URL)
u.searchParams.set('database', process.env.CLICKMONK_CLICKHOUSE_DB)
fetch(u, {
  method: 'POST',
  body: process.env.CM_SQL,
  headers: {
    'x-clickhouse-user': process.env.CLICKMONK_CLICKHOUSE_USER,
    'x-clickhouse-key': process.env.CLICKMONK_CLICKHOUSE_PASSWORD,
  },
}).then(async (r) => {
  const text = await r.text()
  if (!r.ok) throw new Error(r.status + ' ' + text)
  process.stdout.write(text)
})
`

const storeRun = (sql: string): string =>
  compose('exec', '-T', '-e', `CM_SQL=${sql}`, 'worker', 'node', '-e', RUN_IN_STORE)

function storeCount(sql: string): number {
  const out = storeRun(sql).trim()
  const n = Number(out)
  // Never a silent NaN or a silent zero: an unreachable store answers nothing and
  // `Number('')` is 0, which would reach an assertion looking like a count of
  // none.
  if (out === '' || !Number.isInteger(n)) throw new Error(`the store answered "${out}"`)
  return n
}

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
  //
  // One address per client, and `-4` so that the address the client reports for
  // itself is the one that was asked for: a container on this network also gets
  // an IPv6 address, which `--ip` does not set, and curl would prefer it.
  const startedMs = Date.now()
  for (let i = 0; i < CLICKS; i++) {
    const r = curl(
      ['-4', '--max-time', '30', '-D', '-', `http://${LINK_HOST}/${SLUG}`],
      ['--ip', CLIENT_IPS[i] as string],
      { body: true },
    )
    if (r.status !== 302) throw new Error(`click ${i} answered ${r.status}: ${r.body}`)
    clientIps.push(r.ip)
  }
  clickHours = [...new Set([hourOf(startedMs), hourOf(Date.now())])]

  // A segment seals after two seconds or 8 MB, and the shipper takes a pass a
  // second: a few seconds in normal operation, waited for rather than slept
  // through.
  await until('the clicks to reach the rollups', 120_000, () => {
    const r = api('GET', `/api/reports/summary?${window()}`, { cookie })
    if (r.status !== 200) return false
    return (JSON.parse(r.body) as { clicks: number }).clicks >= CLICKS
  })
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
  it('counts every click, under the outcome it took, and says how fresh it is', () => {
    const r = api('GET', `/api/reports/summary?${window()}`, { cookie })
    expect(r.status, r.body).toBe(200)
    const body = JSON.parse(r.body) as {
      clicks: number
      visitors: number
      byOutcome: Record<string, number>
      newestHour: string | null
    }
    expect(body.clicks).toBe(CLICKS)
    // **This number is the one above, and the test is not named for it.** Three
    // requests that kept no cookies are three visitors, because a request with no
    // visitor cookie is minted a new id — `mints a new visitor when there is no
    // cookie` in the redirect's own suite is where that is pinned, not the README,
    // which does not say it. So `visitors` here is a second reading of the click
    // count and replacing it with that count would pass. It is asserted because
    // the field has to be populated at all in the shipped stack; the property
    // worth pinning — one visitor merged across buckets rather than summed — needs
    // a visitor who clicked twice, which is `gives one bucket a day, and counts a
    // visitor across the hours of that day once` in the admin service's suite.
    expect(body.visitors).toBe(CLICKS)
    expect(body.byOutcome.target).toBe(CLICKS)
    expect(body.newestHour).not.toBeNull()
  })

  it('puts them in the chart, in the hour they happened', () => {
    const r = api('GET', `/api/reports/timeseries?${window()}&bucket=hour`, { cookie })
    expect(r.status, r.body).toBe(200)
    const buckets = (JSON.parse(r.body) as { buckets: { at: string; clicks: number }[] }).buckets
    // Two days of hours, every one of them there because a chart fills its gaps.
    // The number and not a floor: "more than 24" is satisfied by 25, and the
    // window is aligned at both ends precisely so this can be one number.
    expect(buckets.length).toBe(48)
    // Which bucket carries them, not only that some bucket does. Shifting the
    // fill's lookup key by an hour leaves the length and the total untouched and
    // draws the clicks in the wrong hour, which is the whole of what a chart
    // says.
    const carrying = buckets.filter((b) => b.clicks > 0)
    expect(carrying.reduce((n, b) => n + b.clicks, 0)).toBe(CLICKS)
    for (const b of carrying) expect(clickHours).toContain(b.at)
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
    for (const c of clicks) {
      expect(c.destination).toBe(TARGET)
      expect(c.network).toMatch(/\/(24|64)$/)
    }
    // Three different addresses, asserted before anything is concluded from them:
    // the check below is only about every row while the rows carry addresses that
    // differ, and letting Docker choose gave all three clients the same one.
    expect(new Set(clientIps).size).toBe(CLICKS)
    for (const ip of clientIps) expect(r.body).not.toContain(ip)
  })

  // **What the absent length does and does not prove.** It proves no length was
  // decided before the first row, which is what a handler that hands back the
  // whole file as a string does: measured, that shape fails here and fails the
  // unit test `holds nothing: no content-length, and a chunked body`. It does not
  // prove the file was never held in memory — a body read to the end and handed
  // over as a single-chunk stream is still chunked and still carries no length,
  // and measured, it passes this assertion. What catches that shape is the unit
  // test `gives the caller bytes before the store has produced the last block`,
  // which asks the question a length cannot: whether the caller was reading while
  // the store was still producing. Do not read this assertion as more than the
  // header it reads.
  //
  // This one answer travels through Caddy rather than through `inject`, and a
  // reverse proxy may buffer a small chunked body and add a length of its own.
  // Measured on this stack, Caddy adds none. If one turns up, read the whole
  // header block and Caddy's configuration before touching the assertion: a
  // length added by the proxy is a different fact from a length added here.
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
    // be read back out here. It is not unpinned — `csv.test.ts` compares a
    // written line byte for byte. What this counts is the rows.
    const lines = r.body.split('\n').filter((l) => l.length > 0)
    expect(lines).toHaveLength(CLICKS + 1)
    expect(lines[0]).toContain('"network"')
    expect(new Set(clientIps).size).toBe(CLICKS)
    for (const ip of clientIps) expect(r.body).not.toContain(ip)
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
    // Through the API before the change as well as after. With only the second
    // read, two constants in the settings response satisfy this test: nothing
    // would have seen this surface answer anything else.
    const before = api('GET', '/api/settings', { cookie })
    expect(before.status, before.body).toBe(200)
    expect((JSON.parse(before.body) as { retention: unknown }).retention).toEqual({
      rawRetentionDays: 90,
      ipRetentionDays: 30,
    })
    cli('settings', 'set', '--keep-clicks', '30', '--keep-addresses', '7')
    const after = api('GET', '/api/settings', { cookie })
    expect(after.status, after.body).toBe(200)
    expect((JSON.parse(after.body) as { retention: unknown }).retention).toEqual({
      rawRetentionDays: 30,
      ipRetentionDays: 7,
    })
  })

  it('drops a month past the period it was just given, and keeps the month it is in', async () => {
    // **A pass needs something to delete before a test can watch it delete.**
    // Nothing that can be clicked is past a period on a fresh install: a period is
    // a floor, partitions go whole, and the month this run is in has not ended. So
    // a pass here has no work, and a test that only watched for one — a log line,
    // a count of passes — is satisfied by a pass that prints that it ran and
    // returns. This row is the work: a click in a month that ended long before the
    // thirty days set above, written straight into the store because no click can
    // be made 120 days ago.
    //
    // Its own outcome, so that it is counted apart from every real click, and an
    // address from the documentation range, so that the row the pass considers is
    // shaped like the rows beside it.
    const oldMs = Date.now() - 120 * 24 * HOUR_MS
    const at = new Date(oldMs).toISOString().replace('T', ' ').replace('Z', '')
    storeRun(
      `INSERT INTO clicks (click_id, time, outcome, ip)
         VALUES (generateUUIDv4(), toDateTime64('${at}', 3, 'UTC'), '${OLD_OUTCOME}', '198.51.100.7')`,
    )
    const old = `SELECT count() FROM clicks WHERE outcome = '${OLD_OUTCOME}'`
    expect(storeCount(old)).toBe(1)

    // **The pass is provoked, not waited for.** A pass runs at start and then once
    // an interval, and the interval is the shipped hour, so restarting the worker
    // is a pass on demand — and it is what makes the count above a premise rather
    // than a race. On a short interval a pass lands between the insert and that
    // count often enough to have failed this test on its second run: the row was
    // already gone, and "it is there" is not something a test can check while
    // something else is removing it.
    //
    // Watched for by its effect, never by anything it printed. Sixty seconds, half
    // the file's test timeout, so that a worker which never runs a pass fails with
    // the sentence naming what was missing: measured, with the two deadlines equal
    // they landed on the same millisecond and vitest's own "test timed out" won,
    // which says nothing about retention.
    compose('restart', 'worker')
    await until('the pass to drop the month past the period', 60_000, () => storeCount(old) === 0)

    // And the month this run is in, which the same pass considered and had to
    // leave alone: every raw click still there, and every one of them still
    // holding the address it came from. Read out of `clicks` and not out of a
    // report, because the pass deletes from `clicks` and no report reads it — a
    // pass that dropped every raw click would leave every report answering exactly
    // what it answered before, which is how a test that read one of them passed
    // with every raw click gone.
    //
    // Counted by outcome rather than as a total, because the 404 further up is a
    // click too: a number that counts what another test did on its way past
    // changes when the tests are reordered.
    const kept = `FROM clicks WHERE outcome = 'target'`
    expect(storeCount(`SELECT uniqExact(click_id) ${kept}`)).toBe(CLICKS)
    expect(storeCount(`SELECT uniqExact(click_id) ${kept} AND ip != ''`)).toBe(CLICKS)
  })

  /**
   * The pass's other half, end to end: the address blanked in place, the click
   * kept.
   *
   * It is the half that had unit cover and no cover here, in the one suite whose
   * reason for existing is that the others cannot see a real chain — a real
   * worker, reading a real settings row, issuing a real mutation against a real
   * partition. The unit tests mock nothing either, but they call the pass; this
   * one only restarts the worker and watches the store.
   *
   * **The periods are chosen so that the arithmetic does not depend on today's
   * date.** A month goes only once every click it could hold is past the period,
   * so which month is past a 30-day period depends on how far into the month the
   * run happens to be. Four hundred days ago against `--keep-addresses 7` is past
   * the address period by about a year whatever the date, and against
   * `--keep-clicks 3650` is nowhere near the click period — so the row must be
   * blanked and must not be dropped, and the difference between those two is what
   * this test is for.
   */
  it('blanks the address on a month past the address period, and keeps the click', async () => {
    cli('settings', 'set', '--keep-clicks', '3650', '--keep-addresses', '7')
    const oldMs = Date.now() - 400 * 24 * HOUR_MS
    const at = new Date(oldMs).toISOString().replace('T', ' ').replace('Z', '')
    storeRun(
      `INSERT INTO clicks (click_id, time, outcome, ip)
         VALUES (generateUUIDv4(), toDateTime64('${at}', 3, 'UTC'), '${BLANK_OUTCOME}', '198.51.100.8')`,
    )
    const mine = `FROM clicks WHERE outcome = '${BLANK_OUTCOME}'`
    // The premise, and it is a premise rather than a race: the pass that would
    // touch this row is an hour away, and the restart below is what brings the
    // next one forward.
    expect(storeCount(`SELECT count() ${mine} AND ip != ''`)).toBe(1)

    compose('restart', 'worker')
    await until(
      'the pass to blank the month past the address period',
      60_000,
      () => storeCount(`SELECT count() ${mine} AND ip = ''`) === 1,
    )
    // And the click itself is still there: a dropped partition would satisfy an
    // assertion about no address being left, which is the wrong outcome reached by
    // the same number. Blanking and dropping are the two halves of this pass and
    // the whole point of the periods is that they are different.
    expect(storeCount(`SELECT count() ${mine}`)).toBe(1)
  })
})
