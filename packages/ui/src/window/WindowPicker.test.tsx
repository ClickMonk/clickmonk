import { NowProvider } from '@/app/clock'
import { RefreshProvider, useRefresh } from '@/app/refresh'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation } from 'react-router'
import { describe, expect, it } from 'vitest'
import { WindowPicker } from './WindowPicker'
import { useWindow } from './useWindow'

function Where() {
  const l = useLocation()
  return <output aria-label="address">{`${l.pathname}${l.search}`}</output>
}

const NOW = () => Date.parse('2026-10-07T03:00:00.000Z')

function setup(start = '/overview') {
  render(
    <NowProvider now={NOW}>
      <MemoryRouter initialEntries={[start]}>
        <WindowPicker />
        <Where />
      </MemoryRouter>
    </NowProvider>,
  )
  return userEvent.setup()
}

describe('the window picker', () => {
  it('shows the preset the address names', () => {
    setup('/overview?range=30d')
    expect(screen.getByRole('combobox', { name: 'Time range' })).toHaveValue('30d')
  })

  it('writes a preset to the address and keeps the rest of it', async () => {
    const user = setup('/clicks?class=bot')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Time range' }), 'today')
    expect(screen.getByLabelText('address')).toHaveTextContent('/clicks?class=bot&range=today')
  })

  // The address is compared whole: a `from` left behind beside `range` would
  // pass a comparison that only looks for `range=today` in it.
  it('replaces a custom range with a preset, leaving no dates in the address', async () => {
    const user = setup('/overview?from=2026-10-01&to=2026-10-04')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Time range' }), 'today')
    expect(screen.getByLabelText('address').textContent).toBe('/overview?range=today')
  })

  it('takes a custom range of local dates', async () => {
    const user = setup()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Time range' }), 'custom')
    await user.type(screen.getByLabelText('From'), '2026-10-01')
    await user.type(screen.getByLabelText('To'), '2026-10-04')
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    expect(screen.getByLabelText('address')).toHaveTextContent(
      '/overview?from=2026-10-01&to=2026-10-04',
    )
  })

  it('refuses a custom range that ends before it starts, and leaves the address alone', async () => {
    const user = setup('/overview?range=7d')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Time range' }), 'custom')
    await user.type(screen.getByLabelText('From'), '2026-10-04')
    await user.type(screen.getByLabelText('To'), '2026-10-01')
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    expect(screen.getByRole('alert')).toHaveTextContent('The end date is before the start date.')
    expect(screen.getByLabelText('address')).toHaveTextContent('/overview?range=7d')
  })

  it('refuses a custom range longer than 366 days, and leaves the address alone', async () => {
    const user = setup('/overview?range=7d')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Time range' }), 'custom')
    await user.type(screen.getByLabelText('From'), '2025-01-01')
    await user.type(screen.getByLabelText('To'), '2026-01-02')
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    expect(screen.getByRole('alert')).toHaveTextContent('A custom range is at most 366 days.')
    expect(screen.getByLabelText('address').textContent).toBe('/overview?range=7d')
  })

  it('asks for both dates before applying a custom range, and leaves the address alone', async () => {
    const user = setup('/overview?range=7d')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Time range' }), 'custom')
    await user.type(screen.getByLabelText('To'), '2026-10-04')
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Choose both dates.')
    expect(screen.getByLabelText('address').textContent).toBe('/overview?range=7d')
  })

  // The window a preset names ends at "now", and a refresh is what moves now:
  // without it, "Today" on a screen left open would never show a new click.
  it('moves a preset’s end forward when the screen is refreshed', async () => {
    let now = Date.parse('2026-10-07T03:00:00.000Z')
    function End() {
      const w = useWindow()
      const { refresh } = useRefresh()
      return (
        <>
          <output aria-label="end">{new Date(w.span.toMs).toISOString()}</output>
          <button type="button" onClick={refresh}>
            Refresh
          </button>
        </>
      )
    }
    render(
      <NowProvider now={() => now}>
        <RefreshProvider now={() => now}>
          <MemoryRouter initialEntries={['/overview?range=today']}>
            <End />
          </MemoryRouter>
        </RefreshProvider>
      </NowProvider>,
    )
    expect(screen.getByLabelText('end')).toHaveTextContent('2026-10-07T03:00:00.000Z')
    now = Date.parse('2026-10-07T03:20:00.000Z')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Refresh' }))
    expect(screen.getByLabelText('end')).toHaveTextContent('2026-10-07T03:20:00.000Z')
  })

  it('says once that an address it could not use was replaced', () => {
    setup('/overview?range=forever')
    // The address display above is an <output> too, so it is set aside here.
    const said = screen
      .getAllByRole('status')
      .filter((el) => el.getAttribute('aria-label') !== 'address')
    expect(said).toHaveLength(1)
    expect(said[0]).toHaveTextContent(
      'That time range could not be used, so this shows the last 7 days.',
    )
  })
})
