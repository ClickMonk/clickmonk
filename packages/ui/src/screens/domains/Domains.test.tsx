import { ClientProvider } from '@/api/context'
import { ApiError } from '@/api/errors'
import { fakeClient } from '@/api/fake'
import type { Domain, Status } from '@/api/types'
import { Freshness } from '@/app/Freshness'
import { RefreshProvider } from '@/app/refresh'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { Domains } from './Domains'

const TOKEN = 'clickmonk-verify=0123456789abcdef0123456789abcdef'

/** The service's own words (admin/src/domains.ts), verbatim. */
const UNVERIFY_NOTE =
  'links on this domain now answer 404 and no certificate will be renewed for it; a certificate already issued is presented until it expires'
const CHECKED_RECENTLY = (lastStatus: string) =>
  `this domain was checked less than 60 seconds ago; its last result was ${lastStatus}`

const domain = (host: string, over: Partial<Domain> = {}): Domain => ({
  id: `d-${host}`,
  host,
  verified: false,
  rootUrl: null,
  notFoundUrl: null,
  verificationRecord: { name: `_clickmonk.${host}`, type: 'TXT', value: TOKEN },
  lastCheck: null,
  passedAt: null,
  handVerified: false,
  ...over,
})

function show(list: Domain[], over: Parameters<typeof fakeClient>[0] = {}, truncated = false) {
  let current = list
  const client = fakeClient({
    domains: () => Promise.resolve({ domains: current, truncated }),
    addDomain: ((body: { host: string }) => {
      const d = domain(body.host)
      current = [...current, d]
      return Promise.resolve(d)
    }) as never,
    deleteDomain: ((id: string) => {
      current = current.filter((d) => d.id !== id)
      return Promise.resolve({ ok: true as const })
    }) as never,
    unverifyDomain: ((id: string) => {
      current = current.map((d) => (d.id === id ? { ...d, verified: false } : d))
      return Promise.resolve({ ok: true as const, note: UNVERIFY_NOTE })
    }) as never,
    ...over,
  })
  render(
    <MemoryRouter>
      <ClientProvider client={client}>
        {/* The real app always renders `Domains` inside one `RefreshProvider`
            (`App.tsx`); a screen test with none would test a `refresh()`
            that is a no-op, which is not how the screen is ever used. */}
        <RefreshProvider>
          <Domains />
        </RefreshProvider>
      </ClientProvider>
    </MemoryRouter>,
  )
  return { client, user: userEvent.setup() }
}

const card = async (host: string) =>
  (await screen.findByRole('heading', { level: 2, name: host })).closest('section') as HTMLElement

const calls = (client: ReturnType<typeof fakeClient>, method: string) =>
  client.calls.filter((c) => c.method === method).map((c) => c.args)

describe('the domain list', () => {
  it('is titled as a screen, and says how a domain becomes verified', () => {
    show([])
    expect(screen.getByRole('heading', { level: 1, name: 'Domains' })).toBeInTheDocument()
    expect(
      screen.getByText(
        /verified only by finding its TXT record, or by clickmonk domain add --verified on the server/,
      ),
    ).toBeInTheDocument()
  })

  it('shows an unverified domain the record to publish, to copy', async () => {
    show([domain('go.example.test')])
    const c = await card('go.example.test')
    expect(within(c).getByText('Not verified: its links answer 404')).toBeInTheDocument()
    expect(within(c).getByText('_clickmonk.go.example.test')).toBeInTheDocument()
    expect(within(c).getByText(TOKEN)).toBeInTheDocument()
    expect(within(c).getByRole('button', { name: 'Copy the record name' })).toBeInTheDocument()
    expect(within(c).getByRole('button', { name: 'Copy the record value' })).toBeInTheDocument()
  })

  it('says a domain has not been checked yet', async () => {
    show([domain('go.example.test')])
    expect(within(await card('go.example.test')).getByText('Not checked yet')).toBeInTheDocument()
  })

  it.each([
    ['verified', 'Found the record'],
    ['missing_token', 'Record not found'],
    ['error', 'The DNS lookup failed'],
  ] as const)('says a check that answered %s in words', async (status, words) => {
    show([
      domain('go.example.test', {
        lastCheck: {
          status,
          detail: 'no TXT record at _clickmonk.go.example.test',
          checkedAt: '2026-10-07T02:00:00.000Z',
        },
      }),
    ])
    const c = await card('go.example.test')
    expect(within(c).getByText(words)).toBeInTheDocument()
    expect(within(c).getByText('no TXT record at _clickmonk.go.example.test')).toBeInTheDocument()
  })

  it('says a hand-verified domain has no TXT record, in place of its failing check, and still badges it Verified', async () => {
    show([
      domain('go.example.test', {
        verified: true,
        handVerified: true,
        lastCheck: {
          status: 'missing_token',
          detail: 'no TXT record at _clickmonk.go.example.test',
          checkedAt: '2026-10-07T02:00:00.000Z',
        },
      }),
    ])
    const c = await card('go.example.test')
    expect(within(c).getByText('Verified')).toBeInTheDocument()
    expect(within(c).getByText('Verified by hand, no TXT record')).toBeInTheDocument()
    expect(within(c).queryByText('Record not found')).not.toBeInTheDocument()
    // The card is not claiming DNS proved anything — the label above the
    // record says to publish it, the same as an unverified domain's does.
    expect(within(c).getByText('Publish this TXT record, then check:')).toBeInTheDocument()
    expect(within(c).queryByText('The record that proved it:')).not.toBeInTheDocument()
    // The record to publish is still there, unaffected.
    expect(within(c).getByText('_clickmonk.go.example.test')).toBeInTheDocument()
    // The last check's own result is not lost — shown under the hand-verified
    // line, in that order, muted rather than framed as a problem.
    const handVerifiedLine = within(c).getByText('Verified by hand, no TXT record')
    const lastCheckLine = within(c).getByText(/no TXT record at _clickmonk\.go\.example\.test/)
    expect(
      handVerifiedLine.compareDocumentPosition(lastCheckLine) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('keeps the hand-verified framing even right after Check now finds nothing, rather than flashing the raw result', async () => {
    const { user } = show(
      [
        domain('go.example.test', {
          verified: true,
          handVerified: true,
          lastCheck: {
            status: 'missing_token',
            detail: 'no TXT record at _clickmonk.go.example.test',
            checkedAt: '2026-10-07T02:00:00.000Z',
          },
        }),
      ],
      { checkDomain: () => Promise.resolve({ status: 'missing_token', detail: 'still nothing' }) },
    )
    const c = await card('go.example.test')
    await user.click(within(c).getByRole('button', { name: 'Check now' }))
    // Neither the un-muted, un-framed rendering `check` alone would produce
    // nor a bare "Record not found" ever appears: hand-verified outranks it.
    expect(within(c).getByText('Verified by hand, no TXT record')).toBeInTheDocument()
    expect(within(c).queryByText('Record not found: still nothing')).not.toBeInTheDocument()
  })

  it('offers no way to mark a domain verified', async () => {
    show([domain('go.example.test')])
    await card('go.example.test')
    expect(screen.queryByRole('button', { name: /mark.*verified/i })).not.toBeInTheDocument()
  })

  it('says when the list was cut, and where the rest are', async () => {
    show([domain('a.example.test')], {}, true)
    expect(
      await screen.findByText(
        /Only the first 500 domains by name are shown; clickmonk domain list shows every one./,
      ),
    ).toBeInTheDocument()
  })

  it('still shows the record for a verified domain, as what proved it', async () => {
    show([domain('go.example.test', { verified: true })])
    const c = await card('go.example.test')
    expect(within(c).getByText('The record that proved it:')).toBeInTheDocument()
    expect(within(c).getByText('_clickmonk.go.example.test')).toBeInTheDocument()
    expect(within(c).getByText(TOKEN)).toBeInTheDocument()
  })

  it('marks the list busy while a reload is in flight, without losing it', async () => {
    let resolveSecond: ((p: { domains: Domain[]; truncated: boolean }) => void) | undefined
    let calls = 0
    const { user } = show([], {
      domains: (() => {
        calls += 1
        if (calls === 1)
          return Promise.resolve({ domains: [domain('go.example.test')], truncated: false })
        return new Promise<{ domains: Domain[]; truncated: boolean }>((resolve) => {
          resolveSecond = resolve
        })
      }) as never,
      addDomain: () => Promise.resolve(domain('added.example.test')),
    })
    const heading = await screen.findByRole('heading', { level: 2, name: 'go.example.test' })
    await user.type(screen.getByLabelText('Host name'), 'added.example.test')
    await user.click(screen.getByRole('button', { name: 'Add domain' }))
    await waitFor(() => expect(heading.closest('[aria-busy]')).toHaveAttribute('aria-busy', 'true'))
    resolveSecond?.({
      domains: [domain('go.example.test'), domain('added.example.test')],
      truncated: false,
    })
    await waitFor(() =>
      expect(heading.closest('[aria-busy]')).toHaveAttribute('aria-busy', 'false'),
    )
  })

  it('hides the list rather than showing stale data once a reload fails', async () => {
    let calls = 0
    const { user } = show([], {
      domains: (() => {
        calls += 1
        if (calls === 1)
          return Promise.resolve({ domains: [domain('go.example.test')], truncated: false })
        return Promise.reject(new ApiError(500, 'server_error', 'the service is down'))
      }) as never,
      addDomain: () => Promise.resolve(domain('added.example.test')),
    })
    await screen.findByRole('heading', { level: 2, name: 'go.example.test' })
    await user.type(screen.getByLabelText('Host name'), 'added.example.test')
    await user.click(screen.getByRole('button', { name: 'Add domain' }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { level: 2, name: 'go.example.test' }),
    ).not.toBeInTheDocument()
  })

  it('hides the truncation notice too, once a reload fails', async () => {
    let calls = 0
    const { user } = show([], {
      domains: (() => {
        calls += 1
        if (calls === 1)
          return Promise.resolve({ domains: [domain('go.example.test')], truncated: true })
        return Promise.reject(new ApiError(500, 'server_error', 'the service is down'))
      }) as never,
      addDomain: () => Promise.resolve(domain('added.example.test')),
    })
    await screen.findByText(/Only the first 500 domains by name are shown/)
    await user.type(screen.getByLabelText('Host name'), 'added.example.test')
    await user.click(screen.getByRole('button', { name: 'Add domain' }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(
      screen.queryByText(/Only the first 500 domains by name are shown/),
    ).not.toBeInTheDocument()
  })

  it('resyncs a card’s URL inputs when a reload changes the domain from elsewhere', async () => {
    let calls = 0
    const { user } = show([], {
      domains: (() => {
        calls += 1
        if (calls === 1)
          return Promise.resolve({
            domains: [domain('go.example.test', { rootUrl: 'https://example.com/old' })],
            truncated: false,
          })
        return Promise.resolve({
          domains: [domain('go.example.test', { rootUrl: 'https://example.com/new' })],
          truncated: false,
        })
      }) as never,
      addDomain: () => Promise.resolve(domain('second.example.test')),
    })
    const c = await card('go.example.test')
    expect(within(c).getByLabelText('Root URL')).toHaveValue('https://example.com/old')
    await user.type(screen.getByLabelText('Host name'), 'second.example.test')
    await user.click(screen.getByRole('button', { name: 'Add domain' }))
    await waitFor(async () => {
      expect(within(await card('go.example.test')).getByLabelText('Root URL')).toHaveValue(
        'https://example.com/new',
      )
    })
  })

  it('reloads after a check, so the stored result — with its time — replaces the local one', async () => {
    let calls = 0
    const { user } = show([domain('go.example.test')], {
      domains: (() => {
        calls += 1
        if (calls === 1)
          return Promise.resolve({ domains: [domain('go.example.test')], truncated: false })
        return Promise.resolve({
          domains: [
            domain('go.example.test', {
              verified: true,
              lastCheck: {
                status: 'verified',
                detail: null,
                checkedAt: '2026-10-07T03:00:00.000Z',
              },
            }),
          ],
          truncated: false,
        })
      }) as never,
      checkDomain: () => Promise.resolve({ status: 'verified', detail: 'dns ok' }),
    })
    const c = await card('go.example.test')
    await user.click(within(c).getByRole('button', { name: 'Check now' }))
    await waitFor(async () => {
      expect(within(await card('go.example.test')).getByText('Verified')).toBeInTheDocument()
    })
    const c2 = await card('go.example.test')
    // The fresh local result (with its own detail, no time) has stepped
    // aside for the stored one (no detail here, but its own checked-at time)
    // — not stayed forever, which is what a check that never reloads would do.
    expect(within(c2).queryByText('Found the record: dns ok')).not.toBeInTheDocument()
    expect(within(c2).getByText('Found the record')).toBeInTheDocument()
    expect(within(c2).getByText(/13:30/)).toBeInTheDocument()
    expect(within(c2).getByRole('button', { name: 'Stop serving' })).toBeInTheDocument()
  })
})

describe('adding a domain', () => {
  it('sends the host and nothing else, shows the new domain, and clears the field', async () => {
    const { client, user } = show([])
    await user.type(screen.getByLabelText('Host name'), 'go.example.test')
    await user.click(screen.getByRole('button', { name: 'Add domain' }))
    expect(await card('go.example.test')).toBeInTheDocument()
    expect(calls(client, 'addDomain')).toEqual([[{ host: 'go.example.test' }]])
    expect(screen.getByLabelText('Host name')).toHaveValue('')
  })

  it.each([
    ['host_taken', 'this install already has that domain', 'this install already has that domain.'],
    [
      'host_is_admin_host',
      'that is the host name this API answers on, so links on it would never resolve',
      'that is the host name this API answers on, so links on it would never resolve.',
    ],
    ['invalid_host', 'not a valid host name', 'not a valid host name.'],
  ])(
    'says %s beside the host name, through explain(), and keeps what was typed',
    async (code, message, shown) => {
      const { user } = show([], {
        addDomain: () =>
          Promise.reject(new ApiError(code === 'invalid_host' ? 400 : 409, code, message)),
      })
      await user.type(screen.getByLabelText('Host name'), 'go.example.test')
      await user.click(screen.getByRole('button', { name: 'Add domain' }))
      expect(await screen.findByText(shown)).toBeInTheDocument()
      expect(screen.getByLabelText('Host name')).toHaveAccessibleDescription(shown)
      expect(screen.getByLabelText('Host name')).toHaveValue('go.example.test')
    },
  )

  it('routes a proxy failure through explain(), not the raw message', async () => {
    const { user } = show([], {
      addDomain: () => Promise.reject(new ApiError(502, 'unknown', 'the service answered 502')),
    })
    await user.type(screen.getByLabelText('Host name'), 'go.example.test')
    await user.click(screen.getByRole('button', { name: 'Add domain' }))
    expect(
      await screen.findByText('Something between this browser and ClickMonk answered 502.'),
    ).toBeInTheDocument()
  })

  it('does not clear the host field before the add answers', async () => {
    let resolveAdd: ((d: Domain) => void) | undefined
    const { user } = show([], {
      addDomain: () =>
        new Promise<Domain>((resolve) => {
          resolveAdd = resolve
        }),
    })
    await user.type(screen.getByLabelText('Host name'), 'go.example.test')
    await user.click(screen.getByRole('button', { name: 'Add domain' }))
    expect(screen.getByLabelText('Host name')).toHaveValue('go.example.test')
    resolveAdd?.(domain('go.example.test'))
    await waitFor(() => expect(screen.getByLabelText('Host name')).toHaveValue(''))
  })
})

describe('a domain’s actions', () => {
  it('checks it now and says what was found', async () => {
    const { client, user } = show([domain('go.example.test')], {
      checkDomain: () =>
        Promise.resolve({
          status: 'missing_token',
          detail: 'no TXT record at _clickmonk.go.example.test',
        }),
    })
    await user.click(
      within(await card('go.example.test')).getByRole('button', { name: 'Check now' }),
    )
    expect(
      await screen.findByText('Record not found: no TXT record at _clickmonk.go.example.test'),
    ).toBeInTheDocument()
    expect(calls(client, 'checkDomain')).toEqual([['d-go.example.test']])
  })

  it('says a check was refused because one ran a moment ago', async () => {
    const { user } = show([domain('go.example.test')], {
      checkDomain: () =>
        Promise.reject(
          new ApiError(429, 'checked_recently', CHECKED_RECENTLY('missing_token'), 42),
        ),
    })
    await user.click(
      within(await card('go.example.test')).getByRole('button', { name: 'Check now' }),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(CHECKED_RECENTLY('missing_token'))
  })

  it('changes a root URL and sends only that, and clears one with null', async () => {
    const { client, user } = show(
      [domain('go.example.test', { verified: true, notFoundUrl: 'https://example.com/404' })],
      {
        updateDomain: ((_id: string, body: object) =>
          Promise.resolve(domain('go.example.test', body))) as never,
      },
    )
    const c = await card('go.example.test')
    await user.type(within(c).getByLabelText('Root URL'), 'https://example.com/')
    await user.clear(within(c).getByLabelText('Not-found URL'))
    await user.click(within(c).getByRole('button', { name: 'Save URLs' }))
    expect(calls(client, 'updateDomain')).toEqual([
      ['d-go.example.test', { rootUrl: 'https://example.com/', notFoundUrl: null }],
    ])
  })

  it('leaves an untouched URL out of the request entirely', async () => {
    const { client, user } = show(
      [domain('go.example.test', { verified: true, rootUrl: 'https://example.com/old' })],
      {
        updateDomain: ((_id: string, body: object) =>
          Promise.resolve(domain('go.example.test', body))) as never,
      },
    )
    const c = await card('go.example.test')
    await user.clear(within(c).getByLabelText('Root URL'))
    await user.type(within(c).getByLabelText('Root URL'), 'https://example.com/new')
    await user.click(within(c).getByRole('button', { name: 'Save URLs' }))
    expect(calls(client, 'updateDomain')).toEqual([
      ['d-go.example.test', { rootUrl: 'https://example.com/new' }],
    ])
  })

  it('sends only the not-found URL when only it changed', async () => {
    const { client, user } = show(
      [domain('go.example.test', { verified: true, notFoundUrl: 'https://example.com/old' })],
      {
        updateDomain: ((_id: string, body: object) =>
          Promise.resolve(domain('go.example.test', body))) as never,
      },
    )
    const c = await card('go.example.test')
    await user.clear(within(c).getByLabelText('Not-found URL'))
    await user.type(within(c).getByLabelText('Not-found URL'), 'https://example.com/new')
    await user.click(within(c).getByRole('button', { name: 'Save URLs' }))
    expect(calls(client, 'updateDomain')).toEqual([
      ['d-go.example.test', { notFoundUrl: 'https://example.com/new' }],
    ])
  })

  it('splits a Save URLs refusal per field, keeping what was typed', async () => {
    const { user } = show([domain('go.example.test', { verified: true })], {
      updateDomain: () =>
        Promise.reject(
          new ApiError(
            400,
            'invalid_body',
            'rootUrl: must be an absolute http(s) URL of printable ASCII with no token',
          ),
        ),
    })
    const c = await card('go.example.test')
    await user.type(within(c).getByLabelText('Root URL'), 'not a url')
    await user.click(within(c).getByRole('button', { name: 'Save URLs' }))
    const message = 'must be an absolute http(s) URL of printable ASCII with no token'
    expect(await within(c).findByText(message)).toBeInTheDocument()
    expect(within(c).getByLabelText('Root URL')).toHaveAccessibleDescription(message)
    expect(within(c).getByLabelText('Root URL')).toHaveValue('not a url')
    expect(within(c).getByLabelText('Not-found URL')).toHaveValue('')
  })

  it('stops serving a verified domain after saying what that does and does not do, and the badge follows the reload', async () => {
    const { client, user } = show([domain('go.example.test', { verified: true })])
    await user.click(
      within(await card('go.example.test')).getByRole('button', { name: 'Stop serving' }),
    )
    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      'A certificate already issued is presented until it expires',
    )
    await user.click(screen.getByRole('button', { name: 'Stop serving go.example.test' }))
    expect(await screen.findByText(UNVERIFY_NOTE)).toBeInTheDocument()
    expect(calls(client, 'unverifyDomain')).toEqual([['d-go.example.test']])
    const c = await card('go.example.test')
    expect(within(c).getByText('Not verified: its links answer 404')).toBeInTheDocument()
    expect(within(c).getByText(UNVERIFY_NOTE)).toBeInTheDocument()
  })

  it('offers no way to stop serving a domain that is not verified', async () => {
    show([domain('go.example.test')])
    expect(
      within(await card('go.example.test')).queryByRole('button', { name: 'Stop serving' }),
    ).not.toBeInTheDocument()
  })

  it('deletes a domain after saying its links go with it, and drops its card on reload', async () => {
    const { client, user } = show([domain('go.example.test')])
    await user.click(within(await card('go.example.test')).getByRole('button', { name: 'Delete' }))
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Every link on it goes with it')
    await user.click(screen.getByRole('button', { name: 'Delete go.example.test' }))
    expect(calls(client, 'deleteDomain')).toEqual([['d-go.example.test']])
    await waitFor(() =>
      expect(
        screen.queryByRole('heading', { level: 2, name: 'go.example.test' }),
      ).not.toBeInTheDocument(),
    )
  })

  it('keeps the second card’s own inputs after the first is deleted', async () => {
    const { user } = show([
      domain('a.example.test', { rootUrl: 'https://example.com/a' }),
      domain('b.example.test', { rootUrl: 'https://example.com/b' }),
    ])
    const b = await card('b.example.test')
    expect(within(b).getByLabelText('Root URL')).toHaveValue('https://example.com/b')
    await user.click(within(await card('a.example.test')).getByRole('button', { name: 'Delete' }))
    await user.click(screen.getByRole('button', { name: 'Delete a.example.test' }))
    await waitFor(() =>
      expect(
        screen.queryByRole('heading', { level: 2, name: 'a.example.test' }),
      ).not.toBeInTheDocument(),
    )
    const b2 = await card('b.example.test')
    expect(within(b2).getByLabelText('Root URL')).toHaveValue('https://example.com/b')
  })

  it('does not leak the first card’s own note onto the second after the first is deleted', async () => {
    const { user } = show([
      domain('a.example.test', { verified: true }),
      domain('b.example.test', { verified: true }),
    ])
    await user.click(
      within(await card('a.example.test')).getByRole('button', { name: 'Stop serving' }),
    )
    await user.click(screen.getByRole('button', { name: 'Stop serving a.example.test' }))
    expect(await within(await card('a.example.test')).findByText(UNVERIFY_NOTE)).toBeInTheDocument()
    await user.click(within(await card('a.example.test')).getByRole('button', { name: 'Delete' }))
    await user.click(screen.getByRole('button', { name: 'Delete a.example.test' }))
    await waitFor(() =>
      expect(
        screen.queryByRole('heading', { level: 2, name: 'a.example.test' }),
      ).not.toBeInTheDocument(),
    )
    const b = await card('b.example.test')
    expect(within(b).queryByText(UNVERIFY_NOTE)).not.toBeInTheDocument()
  })
})

describe('the header, elsewhere on the same refresh round', () => {
  const status: Status = {
    newestHour: null,
    reporting: 'ok',
    ipData: null,
    ipDataProblem: null,
    alerts: 0,
  }

  function showWithHeader(over: Parameters<typeof fakeClient>[0] = {}) {
    let statusCalls = 0
    const client = fakeClient({
      domains: () => Promise.resolve({ domains: [domain('go.example.test')], truncated: false }),
      status: (() => {
        statusCalls += 1
        return Promise.resolve(status)
      }) as never,
      ...over,
    })
    render(
      <MemoryRouter>
        <ClientProvider client={client}>
          <RefreshProvider>
            <Freshness />
            <Domains />
          </RefreshProvider>
        </ClientProvider>
      </MemoryRouter>,
    )
    return { client, user: userEvent.setup(), calls: () => statusCalls }
  }

  // Domains reloading its own list is not enough: the header's alert count
  // depends on a separate load, and only the shared refresh round reaches it.
  it('asks the header to reload too, after adding a domain', async () => {
    const { user, calls } = showWithHeader({
      addDomain: () => Promise.resolve(domain('new.example.test')),
    })
    await card('go.example.test')
    expect(calls()).toBe(1)
    await user.type(screen.getByLabelText('Host name'), 'new.example.test')
    await user.click(screen.getByRole('button', { name: 'Add domain' }))
    await waitFor(() => expect(calls()).toBe(2))
  })

  it('asks the header to reload too, after a check succeeds', async () => {
    const { user, calls } = showWithHeader({
      checkDomain: () => Promise.resolve({ status: 'verified', detail: null }),
    })
    const c = await card('go.example.test')
    expect(calls()).toBe(1)
    await user.click(within(c).getByRole('button', { name: 'Check now' }))
    await waitFor(() => expect(calls()).toBe(2))
  })

  it('asks the header to reload too, after a delete', async () => {
    const { user, calls } = showWithHeader({
      deleteDomain: () => Promise.resolve({ ok: true as const }),
    })
    const c = await card('go.example.test')
    expect(calls()).toBe(1)
    await user.click(within(c).getByRole('button', { name: 'Delete' }))
    await user.click(screen.getByRole('button', { name: 'Delete go.example.test' }))
    await waitFor(() => expect(calls()).toBe(2))
  })
})
