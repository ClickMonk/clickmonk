import { z } from 'zod'
import { normaliseHost } from './link.js'

/**
 * The host name the admin API answers on, as every service that has to agree
 * on it reads it: one schema, imported, rather than a copy per package kept
 * honest by matching rows in two test files.
 *
 * Empty is allowed and means "not configured". The admin service starts and
 * answers 503 on every route rather than refusing to boot, because it ships in
 * the same stack as the redirect and an install that has not set this must
 * still get its links served; the redirect reads the same value because the
 * certificate check has to approve that one name, which is not a link domain
 * and so has no verified row of its own.
 *
 * Nothing here accepts a port, a scheme or a wildcard. The value is compared
 * against the `Host` header of a request and used to build the one `Origin`
 * the API believes, so a value carrying `https://` would silently match
 * nothing and the install would look configured with no admin interface at
 * all. The two wildcards are worth stating: a reverse proxy's own host matcher
 * would honour `*.example.test`, so an operator who wrote one here would be
 * routing every link domain under it to the admin API. A bad value fails the
 * configuration with the variable named, which is a crash-loop an operator
 * sees rather than a mis-route nobody sees.
 */
export const AdminHostSchema = z
  .string()
  .default('')
  .transform((s) => s.trim())
  .superRefine((value, ctx) => {
    if (value !== '' && normaliseHost(value) !== value) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `not a lower-case host name without a port or scheme: ${value}`,
      })
    }
  })
