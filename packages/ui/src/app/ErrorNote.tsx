import type { ApiError } from '@/api/errors'

/**
 * An error as the operator should read it. The service's own message where it
 * wrote one for a person; a sentence of this package's where the failure was
 * not the service's (no answer, a proxy's page) or where the service's message
 * was written for a script (a busy gate). A wait is said in words.
 */
export function explain(e: ApiError): string {
  const wait =
    e.retryAfterSeconds && e.retryAfterSeconds >= 60
      ? ` Try again in ${Math.ceil(e.retryAfterSeconds / 60)} minutes.`
      : ''
  switch (e.code) {
    case 'unreachable':
      return 'ClickMonk did not answer. Check that it is running, then try again.'
    case 'timeout':
      return 'ClickMonk took too long to answer. Try again.'
    case 'unknown':
      return `Something between this browser and ClickMonk answered ${e.status}.`
    case 'too_many_reports':
      return 'ClickMonk is busy with other reports. Try again in a moment.'
    case 'reporting_unavailable':
      return 'Reporting is not available right now: ClickMonk cannot reach its click store.'
    default:
      return `${e.message}.${wait}`.replace(/\.\./g, '.')
  }
}

export function ErrorNote({ error }: { error: ApiError }) {
  return (
    <p role="alert" className="text-sm text-destructive">
      {explain(error)}
    </p>
  )
}
