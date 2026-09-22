/**
 * The message every service throws for a bad environment: each variable on
 * its own line, so an operator fixes them all in one pass rather than one
 * restart at a time. Takes the shape of a ZodError rather than the class, so
 * a caller's own copy of zod works too.
 */
export function formatConfigError(error: {
  issues: readonly { path: readonly (string | number)[]; message: string }[]
}): string {
  const lines = error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`)
  return `invalid configuration:\n${lines.join('\n')}`
}
