/**
 * The web interface, served from the same origin as the API.
 *
 * Same origin because the session cookie is host-only and `SameSite=Strict`,
 * and the API answers no cross-origin request at all: the interface can only
 * be on this host. Served by this service rather than by the proxy in front of
 * it so that the files answer on exactly the host this service answers on,
 * behind the same host guard, from the same image.
 *
 * **Two policies.** The API keeps `default-src 'none'`; the interface's files
 * get a policy that allows exactly what the interface loads — its own scripts,
 * styles, fonts and images, and requests to its own origin — and no inline
 * script or style of any kind. Only a 200 to a path outside the API gets it:
 * every error, every 404 and every refusal keeps the API's.
 *
 * **One cache rule.** A file under /assets/ is named by its content and never
 * changes, so it is cached for a year; everything else — the page, the theme
 * script, the icon — is never cached, so an upgrade is one reload away.
 *
 * **A narrow fallback.** A client route (a GET, outside the API, whose last
 * segment has no dot) is answered with the page. Nothing else is: a write to a
 * path that does not exist stays a JSON 404, and so does a request for a file
 * that is not there — including a hashed asset from a previous build, which a
 * browser holding an old page asks for, and which must fail as a missing file
 * rather than arrive as a web page where a script was expected.
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
    etag: true,
  })

  app.addHook('onSend', async (req, reply, payload) => {
    const path = pathOf(req)
    if (reply.statusCode !== 200 || isApi(path)) return payload
    reply.header('content-security-policy', UI_POLICY)
    reply.header('cache-control', path.startsWith('/assets/') ? HASHED : 'no-store')
    return payload
  })

  app.setNotFoundHandler((req, reply) => {
    const path = pathOf(req)
    if (req.method === 'GET' && !isApi(path) && !looksLikeFile(path))
      return reply.sendFile('index.html')
    return reply.code(404).send({ error: 'not_found', message: 'no such route' })
  })
  return true
}
