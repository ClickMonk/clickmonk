/**
 * The web interface, served from the same origin as the API.
 *
 * Same origin because the session cookie is host-only and `SameSite=Strict`,
 * and the API answers no cross-origin request at all: the interface can only
 * be on this host. Served by this service rather than by the proxy in front of
 * it so that the files answer on exactly the host this service answers on,
 * behind the same host guard, from the same image.
 *
 * **Two policies, chosen by what answered.** The API keeps `default-src
 * 'none'`; the interface's files get a policy that allows exactly what the
 * interface loads — its own scripts, styles, fonts and images, and requests to
 * its own origin — and no inline script or style of any kind. Only a `200`
 * gets either header changed at all: every other status — a 404, a 401, a
 * 403, a 500 — keeps whatever the request hook already set, untouched. Among
 * the 200s, the decision is `req.routeOptions.url`, the route that actually
 * answered, never the request's own URL: a percent-encoded path
 * (`/%61pi/me`) still routes to `/api/me`, and `routeOptions.url` names that
 * route the same way regardless of how the request spelled it — a raw-URL
 * prefix check would miss it. The one 200 with no matched route at all is the
 * not-found handler's own fallback (`routeOptions.url` is `undefined` exactly
 * when nothing matched, per Fastify's own `is404`); the only way that handler
 * reaches a 200 is by sending the page, so that case gets the interface's
 * headers too.
 *
 * **One cache rule.** A file under /assets/ is named by its content and never
 * changes, so it is cached for a year; everything else — the page, the theme
 * script, the icon — is never cached, so an upgrade is one reload away. This
 * scheme has no cache rule for a partial `206`, so `acceptRanges` is off:
 * without it, a `Range` request gets the whole body under the interface's own
 * headers, the same as any other request for that file, rather than a slice
 * of it under the wrong cache-control. `etag` and `lastModified` are off too,
 * so nothing here issues a validator — but Fastify's own freshness check
 * still runs ahead of that, so a conditional request (`If-None-Match: *`, or
 * a future `If-Modified-Since`) can still get a `304`. No browser sends one
 * here, because nothing on this path ever hands one out.
 *
 * **A narrow fallback.** A client route (a GET, outside the API and outside
 * /assets/, whose last segment has no dot) is answered with the page. Nothing
 * else is: a write to a path that does not exist stays a JSON 404, and so
 * does a request for a file that is not there — including a hashed asset from
 * a previous build, which a browser holding an old page asks for, and which
 * must fail as a missing file rather than arrive as a web page where a script
 * was expected. Nothing under /assets/ is ever a client route, so
 * `/assets/anything` refuses rather than falling back, whether or not its
 * last segment happens to have a dot.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import fastifyStatic from '@fastify/static'
import type { FastifyInstance, FastifyRequest } from 'fastify'

export const UI_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

const HASHED = 'public, max-age=31536000, immutable'

const pathOf = (req: FastifyRequest): string => req.url.split('?')[0] ?? '/'
const isApi = (path: string): boolean =>
  path === '/health' || path === '/api' || path.startsWith('/api/')
const isAsset = (path: string): boolean => path.startsWith('/assets/')
const looksLikeFile = (path: string): boolean => (path.split('/').pop() ?? '').includes('.')

/** Registers the interface when it has been built. Answers whether it did. */
export function registerUiStatic(app: FastifyInstance, uiDir: string): boolean {
  if (!existsSync(join(uiDir, 'index.html'))) {
    app.log.info({ uiDir }, 'no built interface found; serving the API alone')
    return false
  }
  app.register(fastifyStatic, {
    root: uiDir,
    wildcard: false,
    cacheControl: false,
    index: false,
    etag: false,
    lastModified: false,
    acceptRanges: false,
  })

  app.addHook('onSend', async (req, reply, payload) => {
    if (reply.statusCode !== 200) return payload
    const routeUrl = req.routeOptions.url
    if (routeUrl !== undefined && isApi(routeUrl)) return payload
    reply.header('content-security-policy', UI_POLICY)
    reply.header('cache-control', routeUrl !== undefined && isAsset(routeUrl) ? HASHED : 'no-store')
    return payload
  })

  app.setNotFoundHandler((req, reply) => {
    const path = pathOf(req)
    if (req.method === 'GET' && !isApi(path) && !isAsset(path) && !looksLikeFile(path))
      return reply.sendFile('index.html')
    return reply.code(404).send({ error: 'not_found', message: 'no such route' })
  })
  return true
}
