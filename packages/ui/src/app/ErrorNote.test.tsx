import { ApiError } from '@/api/errors'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ErrorNote } from './ErrorNote'

describe('an error, said', () => {
  it.each([
    [
      new ApiError(400, 'invalid_link', 'targets: weights must sum to 100, got 90'),
      'targets: weights must sum to 100, got 90',
    ],
    [
      new ApiError(0, 'unreachable', 'ClickMonk did not answer'),
      'ClickMonk did not answer. Check that it is running, then try again.',
    ],
    [
      new ApiError(0, 'timeout', 'ClickMonk took too long to answer'),
      'ClickMonk took too long to answer. Try again.',
    ],
    [
      new ApiError(502, 'unknown', 'the service answered 502'),
      'Something between this browser and ClickMonk answered 502.',
    ],
    [
      new ApiError(429, 'too_many_reports', 'too many reports at once; try again', 1),
      'ClickMonk is busy with other reports. Try again in a moment.',
    ],
    [
      new ApiError(503, 'reporting_unavailable', 'reporting is not available on this install'),
      'Reporting is not available right now: ClickMonk cannot reach its click store.',
    ],
    [
      new ApiError(429, 'locked', 'too many failed attempts', 300),
      'too many failed attempts. Try again in 5 minutes.',
    ],
  ])('says %s as the operator should read it', (error, text) => {
    render(<ErrorNote error={error} />)
    expect(screen.getByRole('alert')).toHaveTextContent(text)
  })
})
