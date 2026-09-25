import { act, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { RefreshProvider, useRefresh } from './refresh'

function Round() {
  const { round, refresh } = useRefresh()
  return (
    <button type="button" onClick={refresh}>
      {`round ${round}`}
    </button>
  )
}

describe('refreshing', () => {
  it('counts a press of Refresh', async () => {
    render(
      <RefreshProvider>
        <Round />
      </RefreshProvider>,
    )
    await act(async () => screen.getByRole('button').click())
    expect(screen.getByRole('button')).toHaveTextContent('round 1')
  })

  it('refreshes on focus after a minute away, and not before', () => {
    let now = 0
    render(
      <RefreshProvider now={() => now}>
        <Round />
      </RefreshProvider>,
    )
    now = 59_000
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(screen.getByRole('button')).toHaveTextContent('round 0')
    now = 61_000
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(screen.getByRole('button')).toHaveTextContent('round 1')
  })
})
