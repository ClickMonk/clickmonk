import { ClientProvider } from '@/api/context'
import { ApiError } from '@/api/errors'
import { fakeClient } from '@/api/fake'
import type { Settings as S } from '@/api/types'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { Settings } from './Settings'

const SETTINGS: S = {
  traffic: {
    actions: { bot: 'flag', abuser: 'flag', anonymous: 'flag', datacenter: 'flag' },
    safeUrl: null,
    abuserThreshold: 60,
  },
  retention: { rawRetentionDays: 90, ipRetentionDays: 30 },
  note: null,
  problem: null,
}

function show(
  settings: S = SETTINGS,
  put: (b: unknown) => Promise<S> = (b) =>
    Promise.resolve({ ...SETTINGS, ...(b as object), note: null, problem: null }),
) {
  const client = fakeClient({
    settings: () => Promise.resolve(settings),
    putSettings: put as never,
  })
  render(
    <ClientProvider client={client}>
      <Settings />
    </ClientProvider>,
  )
  return { client, user: userEvent.setup() }
}

const puts = (client: ReturnType<typeof fakeClient>) =>
  client.calls.filter((c) => c.method === 'putSettings').map((c) => c.args[0])

describe('the settings screen', () => {
  it('is titled as a screen, and shows what is set', async () => {
    show()
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument()
    expect(await screen.findByLabelText('Abuser threshold')).toHaveValue('60')
    expect(screen.getByLabelText('Keep clicks for (days)')).toHaveValue('90')
  })

  it('saves both halves together, as a whole', async () => {
    const { client, user } = show()
    const t = await screen.findByLabelText('Abuser threshold')
    await user.clear(t)
    await user.type(t, '120')
    await user.click(screen.getByRole('button', { name: 'Save settings' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Saved.')
    expect(puts(client)).toEqual([
      {
        traffic: { ...SETTINGS.traffic, abuserThreshold: 120 },
        retention: { rawRetentionDays: 90, ipRetentionDays: 30 },
      },
    ])
  })

  it('asks before a save that deletes clicks, and sends nothing if the answer is no', async () => {
    const { client, user } = show()
    const raw = await screen.findByLabelText('Keep clicks for (days)')
    await user.clear(raw)
    await user.type(raw, '30')
    await user.click(screen.getByRole('button', { name: 'Save settings' }))
    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      'Clicks older than 30 days will be deleted within the hour',
    )
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(puts(client)).toEqual([])
    await user.click(screen.getByRole('button', { name: 'Save settings' }))
    await user.click(screen.getByRole('button', { name: 'Delete older clicks and save' }))
    expect(puts(client)).toHaveLength(1)
  })

  it('asks to delete older data, and sends the whole body, when both periods are shorter', async () => {
    const { client, user } = show()
    const raw = await screen.findByLabelText('Keep clicks for (days)')
    await user.clear(raw)
    await user.type(raw, '30')
    const ip = screen.getByLabelText('Keep addresses for (days)')
    await user.clear(ip)
    await user.type(ip, '7')
    await user.click(screen.getByRole('button', { name: 'Save settings' }))
    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      'Clicks older than 30 days will be deleted within the hour',
    )
    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      'Addresses older than 7 days will be blanked within the hour',
    )
    await user.click(screen.getByRole('button', { name: 'Delete older data and save' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Saved.')
    expect(puts(client)).toEqual([
      {
        traffic: SETTINGS.traffic,
        retention: { rawRetentionDays: 30, ipRetentionDays: 7 },
      },
    ])
  })

  it('confirms against what was last saved, not what first loaded', async () => {
    const { user } = show()
    const raw = await screen.findByLabelText('Keep clicks for (days)')
    await user.clear(raw)
    await user.type(raw, '180')
    await user.click(screen.getByRole('button', { name: 'Save settings' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Saved.')
    await user.clear(raw)
    await user.type(raw, '120')
    await user.click(screen.getByRole('button', { name: 'Save settings' }))
    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      'Clicks older than 120 days will be deleted within the hour',
    )
  })

  it('shows a refusal met while confirming inside the dialog, which stays open', async () => {
    const { user } = show(SETTINGS, () =>
      Promise.reject(
        new ApiError(
          503,
          'settings_locked',
          'the settings row is held by another writer, most likely the retention pass, which holds it for the length of one pass; nothing was written, so run this again in a moment',
          5,
        ),
      ),
    )
    const raw = await screen.findByLabelText('Keep clicks for (days)')
    await user.clear(raw)
    await user.type(raw, '30')
    await user.click(screen.getByRole('button', { name: 'Save settings' }))
    await user.click(screen.getByRole('button', { name: 'Delete older clicks and save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('most likely the retention pass')
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
  })

  it('rejects an unreadable retention row that was never filled in, and sends nothing', async () => {
    const { client, user } = show({
      ...SETTINGS,
      retention: null,
      problem: 'the stored row could not be read',
    })
    await user.click(await screen.findByRole('button', { name: 'Save settings' }))
    expect(screen.getAllByText('Choose a number of days, or for ever.')).toHaveLength(2)
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(puts(client)).toEqual([])
  })

  it('resets the form from what the service actually saved, not from what was typed', async () => {
    const put = (b: unknown) => {
      const body = b as { traffic: S['traffic']; retention: S['retention'] }
      return Promise.resolve({
        traffic: { ...body.traffic, abuserThreshold: 75 },
        retention: body.retention,
        note: null,
        problem: null,
      })
    }
    const { user } = show(SETTINGS, put)
    const t = await screen.findByLabelText('Abuser threshold')
    await user.clear(t)
    await user.type(t, '120')
    await user.click(screen.getByRole('button', { name: 'Save settings' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Saved.')
    expect(screen.getByLabelText('Abuser threshold')).toHaveValue('75')
  })

  it('keeps clicks for ever when asked, without asking', async () => {
    const { client, user } = show()
    await user.click(await screen.findByRole('checkbox', { name: 'Keep clicks for ever' }))
    expect(screen.getByLabelText('Keep clicks for (days)')).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Save settings' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Saved.')
    expect((puts(client)[0] as { retention: unknown }).retention).toEqual({
      rawRetentionDays: null,
      ipRetentionDays: 30,
    })
  })

  it('says settings it could not read delete nothing, and does not fill in defaults', async () => {
    show({ ...SETTINGS, retention: null, problem: 'the stored row could not be read' })
    expect(
      await screen.findByText(
        /could not be read, so nothing is being deleted until retention is saved again/,
      ),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Keep clicks for (days)')).toHaveValue('')
  })

  it('shows the service’s note about the two periods', async () => {
    show({
      ...SETTINGS,
      note: 'addresses are set to be kept for 120 days but clicks for 90 days, so an address goes when its click does, after 90 days',
    })
    expect(await screen.findByText(/an address goes when its click does/)).toBeInTheDocument()
  })

  it('says the retention pass is holding the settings, in the service’s words', async () => {
    const { user } = show(SETTINGS, () =>
      Promise.reject(
        new ApiError(
          503,
          'settings_locked',
          'the settings row is held by another writer, most likely the retention pass, which holds it for the length of one pass; nothing was written, so run this again in a moment',
          5,
        ),
      ),
    )
    await user.click(await screen.findByRole('button', { name: 'Save settings' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('most likely the retention pass')
  })
})
