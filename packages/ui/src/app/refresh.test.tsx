import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { RefreshProvider, useRefresh } from './refresh'

/** jsdom's `visibilityState` has no setter; this stands in for the tab going away. */
function stubVisibility(value: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { value, configurable: true })
}

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

  it('does not refresh a visibility change into a hidden tab, however long it was away', () => {
    let now = 0
    render(
      <RefreshProvider now={() => now}>
        <Round />
      </RefreshProvider>,
    )
    now = 61_000
    stubVisibility('hidden')
    try {
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'))
      })
    } finally {
      stubVisibility('visible')
    }
    expect(screen.getByRole('button')).toHaveTextContent('round 0')
  })

  it('stops listening once unmounted', () => {
    const windowRemove = vi.spyOn(window, 'removeEventListener')
    const documentRemove = vi.spyOn(document, 'removeEventListener')
    const { unmount } = render(
      <RefreshProvider>
        <Round />
      </RefreshProvider>,
    )
    unmount()
    expect(windowRemove).toHaveBeenCalledWith('focus', expect.any(Function))
    expect(documentRemove).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
    windowRemove.mockRestore()
    documentRemove.mockRestore()
  })
})
