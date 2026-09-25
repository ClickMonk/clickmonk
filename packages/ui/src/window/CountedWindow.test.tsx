import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CountedWindow } from './CountedWindow'

// The package's tests run in Adelaide (set in the package's test script), so
// this is the path that reads the browser's own zone.
describe('what a report counted', () => {
  it('shows the counted window in local time, and names the zone', () => {
    render(
      <CountedWindow
        counted={{ from: '2026-09-30T14:00:00.000Z', to: '2026-10-07T14:00:00.000Z' }}
        bucket="day"
      />,
    )
    expect(
      screen.getByText('Counted 30 Sept, 23:30 – 8 Oct, 00:30 (Australia/Adelaide)'),
    ).toBeInTheDocument()
    expect(screen.getByText(/Days are counted from 23:30 rather than midnight/)).toBeInTheDocument()
  })

  it('says nothing about days for an hour chart', () => {
    render(
      <CountedWindow
        counted={{ from: '2026-10-06T13:00:00.000Z', to: '2026-10-07T04:00:00.000Z' }}
        bucket="hour"
      />,
    )
    expect(screen.queryByText(/Days are counted/)).not.toBeInTheDocument()
  })
})
