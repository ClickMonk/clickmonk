import { SESSION_COOKIE } from '@clickmonk/admin/auth'
import { passwordCookieName } from '@clickmonk/redirect/password'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  ADMIN_HOST,
  CA_MOUNT,
  type CurlResult,
  WAIT_TIMEOUT,
  cli,
  cliWithInput,
  compose,
  composeWith,
  curl,
  publishZone,
  until,
  writeAcmeRoot,
  writeIssuingRoot,
} from './stack.js'

/**
 * The admin API through the whole shipped stack: Caddy routing by host name, a
 * certificate for the admin host from the local authority, and the properties a
 * unit test cannot show — that the admin name reaches the admin service only
 * once an install has been given it, that a link domain never reaches the admin
 * API, that the host guard holds over a real connection where `Host` can be
 * absent, repeated or claimed in a forwarded header, and that a
 * password-protected link works over real HTTPS, where its `Secure` cookie is
 * the only reason the proof survives the redirect.
 */
const EMAIL = 'admin@example.com'
const PASSWORD = 'a decent admin password'
const LINK_HOST = 'pw.example.test'
const LINK_PASSWORD = 'spring2026'
const TARGET = 'https://example.com/offer'
const OPEN_TARGET = 'https://example.com/open'
/** A host name a cross-origin write tries to add, and must never manage to. */
const EVIL_HOST = 'evil.example.test'

/**
 * How every test below tells *which service* answered, rather than trusting a
 * status code that both of them use. The redirect answers a host it does not
 * serve with this, in plain text; the admin API answers JSON and puts a content
 * security policy on every response, including every refusal. A status alone
 * cannot tell the redirect's 404 for an unknown host from the admin API's 404
 * for a host it does not answer on — and the mutation that sends every name to
 * the admin service is exactly the one that produces the second where the first
 * belongs.
 */
const REDIRECT_404 = 'Not found.\n'
const ADMIN_ONLY_HEADER = /^content-security-policy: default-src 'none'/im

let root = ''
let cookie = ''
let setUp = false
let failures = 0
/**
 * What the admin name answered on an install that was never given one. Taken in
 * `beforeAll` rather than in the test that reads it, because it is the answer of
 * a *different stack*: the variable cannot be changed on a running container, so
 * the suite starts the unconfigured install first, keeps what it said, and then
 * brings the configured one up over it.
 */
let unconfigured: CurlResult | null = null

/** A request to the admin API over HTTPS, trusting the local authority only. */
function api(
  method: string,
  path: string,
  o: {
    body?: string
    cookie?: string
    host?: string
    origin?: string
    forwardedFor?: string
    client?: string[]
  } = {},
) {
  const args = ['--cacert', root, '--max-time', '30', '-X', method, '-D', '-']
  if (o.client) args.push(...o.client)
  if (o.body !== undefined) {
    args.push('-H', 'content-type: application/json', '--data-binary', o.body)
  }
  if (o.cookie) args.push('-H', `cookie: ${o.cookie}`)
  if (o.origin !== undefined) args.push('-H', `origin: ${o.origin}`)
  if (o.forwardedFor !== undefined) args.push('-H', `x-forwarded-for: ${o.forwardedFor}`)
  args.push(`https://${o.host ?? ADMIN_HOST}${path}`)
  return curl(args, CA_MOUNT, { body: true })
}

/** Every `Set-Cookie` of a response, without the header name. */
function setCookies(headers: string): string[] {
  return headers
    .split('\n')
    .filter((l) => /^set-cookie:/i.test(l))
    .map((l) => l.slice(l.indexOf(':') + 1).trim())
}

/**
 * One named cookie a response set, with its attributes, or null when it set no
 * cookie of that name. The name is never written out here: both cookie names
 * come from the modules that mint them, so a rename reaches this suite instead
 * of leaving a regex that quietly matches nothing.
 */
function cookieNamed(
  headers: string,
  name: string,
): { value: string; attributes: string[] } | null {
  for (const c of setCookies(headers)) {
    const [pair = '', ...attributes] = c.split(';')
    const eq = pair.indexOf('=')
    if (eq === -1 || pair.slice(0, eq).trim() !== name) continue
    return { value: pair.slice(eq + 1).trim(), attributes: attributes.map((a) => a.trim()) }
  }
  return null
}

/**
 * The refusal code in an admin API answer, or the whole body when the answer was
 * not one of this API's at all — which is a failure worth reading, so it is
 * returned rather than thrown away.
 */
function errorCode(r: { body: string }): string {
  try {
    const parsed = JSON.parse(r.body) as { error?: unknown }
    return typeof parsed.error === 'string' ? parsed.error : r.body
  } catch {
    return r.body
  }
}

/**
 * A request written byte for byte onto a real connection to the admin port,
 * from a container on the stack's own network — which is what any container in
 * an install can do, so it is the connection the host guard exists for.
 *
 * `app.inject` supplies a `Host` header of its own, so an absent one, a repeated
 * one and an absolute-form request line cannot be expressed against it at all;
 * they are refused by Node or by the guard, and only a real socket can say
 * which. The lines travel as JSON in an environment variable because a CRLF
 * cannot travel in a command argument, and are joined with CRLF inside.
 */
const RAW_CLIENT = `
const lines = JSON.parse(process.env.CM_LINES)
import('node:net').then(({ default: net }) => {
  let out = ''
  const s = net.connect(9100, 'admin', () => s.write(lines.join('\\r\\n') + '\\r\\n\\r\\n'))
  s.setEncoding('utf8')
  s.setTimeout(10000, () => s.destroy())
  s.on('data', (d) => { out += d })
  s.on('error', (e) => { out += 'SOCKET ERROR: ' + e.message })
  s.on('close', () => process.stdout.write(out))
})
`

interface RawResponse {
  status: number
  headers: string
  body: string
  raw: string
}

function rawToAdmin(...lines: string[]): RawResponse {
  const out = compose(
    'exec',
    '-T',
    '-e',
    `CM_LINES=${JSON.stringify(lines)}`,
    'redirect',
    'node',
    '-e',
    RAW_CLIENT,
  )
  const text = out.replace(/\r\n/g, '\n')
  const blank = text.indexOf('\n\n')
  const head = blank === -1 ? text : text.slice(0, blank)
  return {
    status: Number(/^HTTP\/1\.\d (\d{3})/.exec(head)?.[1] ?? 0),
    headers: head,
    body: blank === -1 ? '' : text.slice(blank + 2),
    raw: out,
  }
}

/** A GET of a link over plain HTTP from a client container, headers and body kept. */
const visit = (path: string, extra: string[] = []): CurlResult =>
  curl(['--max-time', '30', '-D', '-', ...extra, `http://${LINK_HOST}${path}`], [], { body: true })

/** The same over HTTPS, trusting the local authority. */
const visitTls = (path: string, extra: string[] = []): CurlResult =>
  curl(
    ['--cacert', root, '--max-time', '30', '-D', '-', ...extra, `https://${LINK_HOST}${path}`],
    CA_MOUNT,
    {
      body: true,
    },
  )

afterEach((ctx) => {
  if (ctx.task.result?.state === 'fail') failures++
})

beforeAll(async () => {
  compose('down', '-v')
  writeAcmeRoot()
  publishZone()
  // First the install that was never told an admin host name: Compose resolves
  // the variable to the empty string either way, so the only way to see what
  // that install does with the admin name is to run it.
  composeWith({ CLICKMONK_ADMIN_HOST: undefined }, 'up', '-d', '--build', '--wait', ...WAIT_TIMEOUT)
  unconfigured = curl(['--max-time', '30', '-D', '-', `http://${ADMIN_HOST}/api/me`], [], {
    body: true,
  })
  // Then the same stack with the name set, which recreates every service that
  // reads it and leaves the authority and the databases alone.
  compose('up', '-d', '--wait', ...WAIT_TIMEOUT)
  root = writeIssuingRoot()
  // The account is created on the server, by whoever installed it: the API has
  // nothing to authenticate as until it exists.
  cliWithInput(PASSWORD, 'admin', 'create', EMAIL)
  setUp = true
}, 900_000)

afterAll(() => {
  try {
    if (failures > 0 || !setUp) console.error(compose('logs', '--no-color', '--tail', '200'))
  } finally {
    compose('down', '-v')
  }
}, 300_000)

describe('an install that was never given an admin host name', () => {
  // The routing this stack ships is a CEL expression that matches nothing when
  // the variable is empty, so the admin name is an ordinary name: it reaches the
  // redirect, which has never heard of it. Until now that was pinned by
  // `caddy validate` accepting the file and by assertions on the file's text,
  // neither of which is a request arriving somewhere.
  it('sends the admin name to the redirect, not to the admin API', () => {
    const r = unconfigured as CurlResult
    expect(r.exit, r.stderr).toBe(0)
    // Not 308: that is what the configured install answers here, and it is the
    // one answer that would mean the name had matched.
    expect(r.status).toBe(404)
    expect(r.body).toBe(REDIRECT_404)
    expect(r.headers).not.toMatch(ADMIN_ONLY_HEADER)
  })
})

describe('the admin host', () => {
  it('gets a certificate from the authority, although it is not a link domain', async () => {
    // The `ask` check approves it because the operator named it in the
    // configuration, not because any row says it is verified.
    //
    // The handshake is what is being waited for, so the request is one that
    // needs a credential: a 401 over TLS proves the certificate exists, and
    // asking a route that answers anyone would mean this suite's own liveness
    // probe was the thing reachable from the internet.
    await until('a certificate for the admin host', 120_000, () => {
      const r = api('GET', '/api/me')
      return r.exit === 0 && r.status === 401
    })
    const r = api('GET', '/api/me')
    expect(r.exit, r.stderr).toBe(0)
    expect(r.status).toBe(401)
    // The admin API's own refusal, over its own certificate: the name now
    // reaches the admin service and nothing else.
    expect(errorCode(r)).toBe('unauthenticated')
    expect(r.headers).toMatch(ADMIN_ONLY_HEADER)
  })

  // /health is in front of the host guard, so Caddy serves it here to anyone.
  // It must therefore say nothing an outsider could use — above all not
  // whether the admin account has been created yet.
  it('answers liveness to a stranger, and tells them nothing else', () => {
    const r = api('GET', '/health')
    // Reachable without a credential, over the real certificate...
    expect(r.status).toBe(200)
    // ...and this is the whole of what it says, at this point in the suite with
    // an account already created: a field that grew here would say so.
    expect(r.body).toBe('{"status":"ok"}')
  })

  it('sends a plain-HTTP visitor to HTTPS rather than serving the API', () => {
    const r = curl(['--max-time', '30', '-D', '-', `http://${ADMIN_HOST}/api/me`], [], {
      body: true,
    })
    // 308 and not 301: a 301 lets a client turn a POST into a GET, so a
    // sign-in sent here would arrive over HTTPS as an empty GET instead of
    // being retried as itself.
    expect(r.status).toBe(308)
    expect(r.headers).toMatch(new RegExp(`^location: https://${ADMIN_HOST}/api/me$`, 'im'))
  })

  it('signs in over HTTPS and answers as the admin', () => {
    const r = api('POST', '/api/session', {
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
      origin: `https://${ADMIN_HOST}`,
    })
    expect(r.status).toBe(200)
    const set = cookieNamed(r.headers, SESSION_COOKIE)
    expect(set, `no session cookie in ${r.headers}`).not.toBeNull()
    const session = set as NonNullable<typeof set>
    expect(session.value).not.toBe('')
    // `__Host-` is a browser rule, and this is the only place the real thing is
    // seen over a real certificate: the attributes it demands — Secure, Path=/,
    // no Domain — are what the service actually sends, read off this cookie
    // rather than searched for anywhere in the response.
    expect(session.attributes).toContain('Secure')
    expect(session.attributes).toContain('HttpOnly')
    expect(session.attributes).toContain('Path=/')
    expect(session.attributes.filter((a) => /^Domain=/i.test(a))).toEqual([])
    cookie = `${SESSION_COOKIE}=${session.value}`
    const me = api('GET', '/api/me', { cookie })
    expect(me.status).toBe(200)
    expect(JSON.parse(me.body).email).toBe(EMAIL)
  })

  it('refuses a write from another origin', () => {
    const r = api('POST', '/api/domains', {
      body: JSON.stringify({ host: EVIL_HOST }),
      cookie,
      origin: 'https://evil.example.com',
    })
    expect(r.status).toBe(403)
    expect(errorCode(r)).toBe('bad_origin')
    // Refused, and nothing written: a 403 that had already stored the domain
    // would be a refusal in name only.
    expect(cli('domain', 'list')).not.toContain(EVIL_HOST)
  })

  // Readiness, which is the thing /health deliberately does not say, reaches the
  // same answer from behind the guards — and only from behind them. Both halves
  // are here, because a test that only shows the credential working still passes
  // for a service that answers everyone.
  it('reports the account only to a credential', () => {
    const anonymous = api('GET', '/api/me')
    expect(anonymous.status).toBe(401)
    expect(errorCode(anonymous)).toBe('unauthenticated')
    const me = api('GET', '/api/me', { cookie })
    expect(me.status).toBe(200)
    expect(JSON.parse(me.body).email).toBe(EMAIL)
  })
})

describe('the admin service on its own port, over a real connection', () => {
  // The positive control for every refusal below: the same helper, the same
  // port, the same route, one `Host` different. Without it a broken client
  // script would make all five refusals pass while proving nothing.
  it('answers a connection that carries its own host name', () => {
    const r = rawToAdmin('GET /api/me HTTP/1.1', `Host: ${ADMIN_HOST}`, 'Connection: close')
    expect(r.status, r.raw).toBe(401)
    expect(errorCode(r)).toBe('unauthenticated')
  })

  it('refuses a connection carrying a link domain’s host name', () => {
    const r = rawToAdmin('GET /api/me HTTP/1.1', `Host: ${LINK_HOST}`, 'Connection: close')
    expect(r.status, r.raw).toBe(404)
    // The guard's refusal, not the router's: `no such route` here would mean the
    // request had got past the host check and simply found nothing.
    expect(errorCode(r)).toBe('not_found')
    expect(r.body).toContain('no such host on this service')
  })

  // The defeat this guard is written against: every container on the bridge is a
  // trusted peer, so a forwarded header from one of them is believed. `Host` is
  // what the connection carried; `X-Forwarded-Host` is what the sender claimed.
  it('refuses the admin name claimed in a forwarded header', () => {
    const r = rawToAdmin(
      'GET /api/me HTTP/1.1',
      `Host: ${LINK_HOST}`,
      `X-Forwarded-Host: ${ADMIN_HOST}`,
      'Connection: close',
    )
    expect(r.status, r.raw).toBe(404)
    expect(r.body).toContain('no such host on this service')
  })

  // Refused by Node's own parser, which requires a host name on an HTTP/1.1
  // request, so the guard never sees it — recorded here because that is the
  // reason the guard is allowed to treat an absent `Host` as unremarkable, and
  // until now nothing said which layer refused it.
  it('refuses a connection with no host name at all', () => {
    const r = rawToAdmin('GET /api/me HTTP/1.1', 'Connection: close')
    expect(r.status, r.raw).toBe(400)
    // Node's refusal comes with no body of this API's, which is the evidence
    // that it never reached a route: a 400 carrying `invalid_body` would be the
    // service's own, from somewhere past the guard.
    expect(r.body).not.toContain('no such host on this service')
    expect(r.headers).not.toMatch(ADMIN_ONLY_HEADER)
  })

  // Two `Host` headers, the second of them the name the sender wants. Node keeps
  // the first and drops the rest, and the guard reads that one — so the claim in
  // the second buys nothing. Were the last one to win instead, this connection
  // would be answered as the admin host.
  it('refuses a connection that sends two host names', () => {
    const r = rawToAdmin(
      'GET /api/me HTTP/1.1',
      `Host: ${LINK_HOST}`,
      `Host: ${ADMIN_HOST}`,
      'Connection: close',
    )
    expect(r.status, r.raw).toBe(404)
    expect(r.body).toContain('no such host on this service')
  })

  // An absolute-form request line, which is how a request to a proxy is
  // written. The name in it is not the name the guard reads.
  it('refuses an absolute-form request line naming the admin host', () => {
    const r = rawToAdmin(
      `GET http://${ADMIN_HOST}/api/me HTTP/1.1`,
      `Host: ${LINK_HOST}`,
      'Connection: close',
    )
    expect(r.status, r.raw).toBe(404)
    expect(r.body).toContain('no such host on this service')
  })
})

describe('a link with a password, end to end', () => {
  let token = ''
  let linkId = ''

  it('is created through the API, unverified, with a token to publish', () => {
    const created = api('POST', '/api/domains', {
      body: JSON.stringify({ host: LINK_HOST }),
      cookie,
      origin: `https://${ADMIN_HOST}`,
    })
    expect(created.status).toBe(201)
    expect(JSON.parse(created.body).verified).toBe(false)
    const listed = cli('domain', 'list')
    expect(listed).toMatch(new RegExp(`^${LINK_HOST.replace(/\./g, '\\.')}: unverified;`, 'm'))
    token = new RegExp(
      `_clickmonk\\.${LINK_HOST.replace(/\./g, '\\.')}  TXT  "clickmonk-verify=([0-9a-f]{32})"`,
    ).exec(listed)?.[1] as string
    expect(token).toMatch(/^[0-9a-f]{32}$/)
  })

  it('serves once the token is published', async () => {
    // Only the domain this suite added: `go.example.test` belongs to the TLS
    // suite and is not in this install at all, so a record for it would be a
    // line nothing ever reads.
    publishZone(`_clickmonk.pw IN TXT "clickmonk-verify=${token}"`)
    await until('the worker to verify the new domain', 120_000, () =>
      cli('domain', 'list').includes(`${LINK_HOST}: verified`),
    )
    const created = api('POST', '/api/links', {
      body: JSON.stringify({
        host: LINK_HOST,
        slug: 'secret',
        targets: [{ url: TARGET }],
        password: LINK_PASSWORD,
      }),
      cookie,
      origin: `https://${ADMIN_HOST}`,
    })
    expect(created.status).toBe(201)
    const link = JSON.parse(created.body)
    expect(link.hasPassword).toBe(true)
    linkId = link.id
    // A second link on the same domain with no password, for the two tests that
    // need a link whose answer is a destination rather than a form.
    const open = api('POST', '/api/links', {
      body: JSON.stringify({ host: LINK_HOST, slug: 'open', targets: [{ url: OPEN_TARGET }] }),
      cookie,
      origin: `https://${ADMIN_HOST}`,
    })
    expect(open.status).toBe(201)
    expect(JSON.parse(open.body).hasPassword).toBe(false)
  })

  it('asks the visitor for the password, over HTTPS, and sends them on when it is right', async () => {
    await until('a certificate for the new link domain', 120_000, () => {
      const r = visitTls('/secret')
      return r.exit === 0 && r.status === 200
    })
    const page = visitTls('/secret')
    expect(page.status).toBe(200)
    expect(page.headers).toMatch(/^content-type: text\/html/im)
    // No proof cookie yet: nothing is granted by asking.
    expect(cookieNamed(page.headers, passwordCookieName(linkId))).toBeNull()

    const wrong = visitTls('/secret', ['--data-urlencode', 'password=not-it'])
    expect(wrong.status).toBe(200)
    expect(cookieNamed(wrong.headers, passwordCookieName(linkId))).toBeNull()

    const right = visitTls('/secret', ['--data-urlencode', `password=${LINK_PASSWORD}`])
    expect(right.status).toBe(302)
    // Named for this link, so a proof is a proof of one link and not of any.
    const proof = cookieNamed(right.headers, passwordCookieName(linkId))
    expect(proof, `no proof cookie in ${right.headers}`).not.toBeNull()
    const set = proof as NonNullable<typeof proof>
    // Secure, which is why this can only be tested here: over plain HTTP the
    // browser drops the proof and the visitor is asked again forever.
    expect(set.attributes).toContain('Secure')
    expect(set.attributes).toContain('HttpOnly')

    const followed = visitTls('/secret', [
      '-H',
      `cookie: ${passwordCookieName(linkId)}=${set.value}`,
    ])
    expect(followed.status).toBe(302)
    expect(followed.headers).toMatch(new RegExp(`^location: ${TARGET}$`, 'im'))
  })

  // Eight guesses from ONE container, in one shell loop. The limiter keys on the
  // visitor's address and the link, and a fresh `docker run` per guess would be
  // a fresh address whenever Docker did not happen to reuse the one it had just
  // freed — so the test would pass or fail on the IPAM's mood and would prove
  // nothing about the limiter.
  //
  // Plain HTTP, because this container has no reason to trust the local
  // authority and every one of these answers is a refusal, which carries no
  // cookie: the `Secure` proof is the test above's subject, not this one's.
  it('refuses an address that keeps guessing, from one address', async () => {
    // The limiter counts in fixed windows held in the redirect's memory, and the
    // window turns over 60 seconds after the first attempt this process saw —
    // which by now is an earlier test's. A restarted process has seen none, so
    // the window starts with this loop's first guess and cannot turn over in the
    // middle of it, which is the difference between a guard and a coin toss.
    compose('restart', 'redirect')
    await until('the restarted redirect to serve the link again', 120_000, () => {
      const r = visit('/open')
      return r.exit === 0 && r.status === 302
    })
    const r = compose(
      'exec',
      '-T',
      'redirect',
      'sh',
      '-c',
      `for i in 1 2 3 4 5 6 7 8; do
         node -e "fetch('http://${LINK_HOST}/secret',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'password=still-not-it',redirect:'manual'}).then(r=>console.log(r.status)).catch(()=>console.log(0))"
       done`,
    )
    const statuses = r
      .split('\n')
      .map((l) => Number(l.trim()))
      .filter((n) => n > 0)
    // Five wrong answers are answered with the page, and every guess after them
    // is refused. Written out rather than counted from the limit, so a limit
    // that moved is a red here instead of a test that follows it.
    expect(statuses, r).toEqual([200, 200, 200, 200, 200, 429, 429, 429])
  })
})

describe('what Caddy tells the redirect about the visitor', () => {
  // Two facts the redirect's own reasoning rests on, which were until now held
  // in nobody's test: the redirect reads the host name off `req.hostname`, which
  // with a trusted proxy configured comes from `X-Forwarded-Host`, and it counts
  // by `req.ip`, which comes from `X-Forwarded-For`. Both are safe only because
  // Caddy does not pass a client's version of either through.
  it('overwrites a host name the client claimed', () => {
    // If the client's header were believed, the redirect would look for a link
    // on the name in it and answer 404 for the one that was actually asked for.
    const r = visit('/open', ['-H', `x-forwarded-host: ${ADMIN_HOST}`])
    expect(r.status, r.body).toBe(302)
    expect(r.headers).toMatch(new RegExp(`^location: ${OPEN_TARGET}$`, 'im'))
  })

  it('replaces an address the client claimed', () => {
    const forged = '203.0.113.9'
    const signIn = api('POST', '/api/session', {
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
      origin: `https://${ADMIN_HOST}`,
      forwardedFor: forged,
      // One address family, so what the client reports about itself and what the
      // server recorded are the same kind of thing.
      client: ['-4'],
    })
    expect(signIn.status).toBe(200)
    const set = cookieNamed(signIn.headers, SESSION_COOKIE)
    expect(set, `no session cookie in ${signIn.headers}`).not.toBeNull()
    const value = (set as NonNullable<typeof set>).value
    const listed = api('GET', '/api/sessions', { cookie: `${SESSION_COOKIE}=${value}` })
    expect(listed.status).toBe(200)
    const sessions = JSON.parse(listed.body).sessions as { ip: string; current: boolean }[]
    const current = sessions.find((s) => s.current)
    expect(current, listed.body).not.toBeUndefined()
    // The address the client actually came from, which curl reports for itself,
    // and not the one it asked to be recorded as.
    expect((current as { ip: string }).ip).toBe(signIn.ip)
    expect(sessions.map((s) => s.ip)).not.toContain(forged)
  })
})

describe('a link domain', () => {
  // The property the whole arrangement exists for: the admin surface is not
  // reachable from a name a visitor clicks. Caddy routes by host name, and the
  // admin service refuses any Host but its own — so a name that reached the
  // admin service would answer in the admin service's words, whatever its
  // status code happened to be.
  // Both ports, because they are two separate routing decisions in the shipped
  // file and a link domain has a certificate of its own: the port a visitor
  // reaches this name on is theirs to choose.
  it('does not reach the admin API', () => {
    for (const r of [visit('/api/session'), visitTls('/api/session')]) {
      expect(r.exit, r.stderr).toBe(0)
      expect(r.status, r.body).toBe(404)
      expect(r.body).toBe(REDIRECT_404)
      expect(r.headers).not.toMatch(ADMIN_ONLY_HEADER)
    }
    const post = visitTls('/api/session', [
      '-X',
      'POST',
      '-H',
      'content-type: application/json',
      '--data-binary',
      JSON.stringify({ email: EMAIL, password: PASSWORD }),
    ])
    // 415, because the only body the redirect reads is a password form and it
    // has no parser for JSON — which is itself the proof that this sign-in
    // reached the redirect. The admin API parses JSON, so a request that got
    // there would be answered past this point, in its words and with its
    // headers.
    expect(post.status).toBe(415)
    expect(post.body).toBe('That content type is not read here.\n')
    expect(post.headers).not.toMatch(ADMIN_ONLY_HEADER)
  })
})

describe('the admin service in the stack', () => {
  it('publishes no port of its own', () => {
    const ports = compose('ps', '--format', '{{.Service}} {{.Ports}}')
    const line = (s: string) => ports.split('\n').find((l) => l.startsWith(`${s} `)) ?? ''
    expect(line('admin'), 'no admin service running').not.toBe('')
    expect(line('admin')).not.toMatch(/0\.0\.0\.0|\[::\]|->/)
    // The same probe on the one service that does publish something, so the
    // assertion above is discriminating rather than reading a format this no
    // longer parses.
    expect(line('caddy'), ports).toMatch(/->/)
  })

  it('answers its healthcheck on the internal port, which is where Compose asks', () => {
    // From a container on the stack's own network, because nothing outside can
    // reach this port at all.
    const r = compose(
      'exec',
      '-T',
      'redirect',
      'node',
      '-e',
      "fetch('http://admin:9100/health').then(r=>r.json()).then(j=>console.log(JSON.stringify(j)))",
    )
    expect(r.trim()).toBe('{"status":"ok"}')
  })
})
