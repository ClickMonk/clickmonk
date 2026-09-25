import { ClientProvider } from '@/api/context'
import { ApiError } from '@/api/errors'
import { fakeClient } from '@/api/fake'
import type { Domain } from '@/api/types'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { Domains } from './Domains'

const TOKEN = 'clickmonk-verify=0123456789abcdef0123456789abcdef'

const domain = (host: string, over: Partial<Domain> = {}): Domain => ({
  id: `d-${host}`,
  host,
  verified: false,
  rootUrl: null,
  notFoundUrl: null,
  verificationRecord: { name: `_clickmonk.${host}`, type: 'TXT', value: TOKEN },
  lastCheck: null,
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
    ...over,
  })
  render(
    <MemoryRouter>
      <ClientProvider client={client}>
        <Domains />
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

  it('dims the list and marks it busy while a reload is in flight, rather than blanking it', async () => {
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
    const busy = heading.closest('[aria-busy]')
    expect(busy).toHaveAttribute('aria-busy', 'true')
    expect(busy).toHaveClass('opacity-50')
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
})

describe('adding a domain', () => {
  it('sends the host and nothing else, and shows the new domain with its record', async () => {
    const { client, user } = show([])
    await user.type(screen.getByLabelText('Host name'), 'go.example.test')
    await user.click(screen.getByRole('button', { name: 'Add domain' }))
    expect(await card('go.example.test')).toBeInTheDocument()
    expect(calls(client, 'addDomain')).toEqual([[{ host: 'go.example.test' }]])
  })

  it.each([
    ['host_taken', 'this install already has that domain'],
    [
      'host_is_admin_host',
      'that is the host name this API answers on, so links on it would never resolve',
    ],
    ['invalid_host', 'not a valid host name'],
  ])('says %s beside the host name', async (code, message) => {
    const { user } = show([], {
      addDomain: () =>
        Promise.reject(new ApiError(code === 'invalid_host' ? 400 : 409, code, message)),
    })
    await user.type(screen.getByLabelText('Host name'), 'go.example.test')
    await user.click(screen.getByRole('button', { name: 'Add domain' }))
    expect(await screen.findByText(message)).toBeInTheDocument()
    expect(screen.getByLabelText('Host name')).toHaveAccessibleDescription(message)
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
          new ApiError(
            429,
            'checked_recently',
            'this domain was checked less than a minute ago; its last result was missing_token',
            42,
          ),
        ),
    })
    await user.click(
      within(await card('go.example.test')).getByRole('button', { name: 'Check now' }),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'this domain was checked less than a minute ago',
    )
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

  it('stops serving a verified domain after saying what that does and does not do', async () => {
    const { client, user } = show([domain('go.example.test', { verified: true })], {
      unverifyDomain: () =>
        Promise.resolve({
          ok: true as const,
          note: 'links on this domain now answer 404 and no certificate will be renewed for it',
        }),
    })
    await user.click(
      within(await card('go.example.test')).getByRole('button', { name: 'Stop serving' }),
    )
    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      'A certificate already issued is presented until it expires',
    )
    await user.click(screen.getByRole('button', { name: 'Stop serving go.example.test' }))
    expect(
      await screen.findByText(
        'links on this domain now answer 404 and no certificate will be renewed for it',
      ),
    ).toBeInTheDocument()
    expect(calls(client, 'unverifyDomain')).toEqual([['d-go.example.test']])
  })

  it('offers no way to stop serving a domain that is not verified', async () => {
    show([domain('go.example.test')])
    expect(
      within(await card('go.example.test')).queryByRole('button', { name: 'Stop serving' }),
    ).not.toBeInTheDocument()
  })

  it('deletes a domain after saying its links go with it', async () => {
    const { client, user } = show([domain('go.example.test')], {
      deleteDomain: () => Promise.resolve({ ok: true as const }),
    })
    await user.click(within(await card('go.example.test')).getByRole('button', { name: 'Delete' }))
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Every link on it goes with it')
    await user.click(screen.getByRole('button', { name: 'Delete go.example.test' }))
    expect(calls(client, 'deleteDomain')).toEqual([['d-go.example.test']])
  })
})
