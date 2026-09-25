import { ClientProvider } from '@/api/context'
import { ApiError } from '@/api/errors'
import { fakeClient } from '@/api/fake'
import type { Domain, Link, Settings } from '@/api/types'
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Link as RouterLink, Routes } from 'react-router'
import { describe, expect, it } from 'vitest'
import { LinkForm } from './LinkForm'

const domain = (host: string, verified: boolean): Domain => ({
  id: `d-${host}`,
  host,
  verified,
  rootUrl: null,
  notFoundUrl: null,
  verificationRecord: {
    name: `_clickmonk.${host}`,
    type: 'TXT',
    value: 'clickmonk-verify=0123456789abcdef0123456789abcdef',
  },
  lastCheck: null,
})

const SETTINGS: Settings = {
  traffic: {
    actions: { bot: 'flag', abuser: 'flag', anonymous: 'flag', datacenter: 'flag' },
    safeUrl: null,
    abuserThreshold: 60,
  },
  retention: { rawRetentionDays: 90, ipRetentionDays: 30 },
  note: null,
  problem: null,
}

const LINK: Link = {
  id: 'l1',
  domainId: 'd-go.example.test',
  host: 'go.example.test',
  slug: 'spring',
  url: 'https://go.example.test/spring',
  name: 'Spring offer',
  enabled: true,
  targets: [{ id: 't1', url: 'https://example.com/offer', weight: 100 }],
  backupUrl: null,
  deviceUrls: {},
  returningUrl: null,
  countries: { mode: 'all' },
  clickCap: null,
  capUsed: null,
  expiresAt: null,
  passthrough: true,
  trafficActions: {},
  hasPassword: true,
  createdAt: '2026-09-01T00:00:00.000Z',
}

function show(mode: 'create' | 'edit', over: Parameters<typeof fakeClient>[0] = {}) {
  const client = fakeClient({
    domains: () =>
      Promise.resolve({
        domains: [domain('go.example.test', true), domain('new.example.test', false)],
        truncated: false,
      }),
    settings: () => Promise.resolve(SETTINGS),
    link: () => Promise.resolve(LINK),
    createLink: () => Promise.resolve({ ...LINK, id: 'l-new' }),
    updateLink: () => Promise.resolve(LINK),
    ...over,
  })
  render(
    <MemoryRouter initialEntries={[mode === 'create' ? '/links/new' : '/links/l1/edit']}>
      <ClientProvider client={client}>
        <Routes>
          <Route path="/links/new" element={<LinkForm mode="create" />} />
          <Route path="/links/:id/edit" element={<LinkForm mode="edit" />} />
          <Route path="/links/:id" element={<h1>the link page</h1>} />
        </Routes>
      </ClientProvider>
    </MemoryRouter>,
  )
  return { client, user: userEvent.setup() }
}

const sent = (client: ReturnType<typeof fakeClient>, method: 'createLink' | 'updateLink') =>
  client.calls.filter((c) => c.method === method).map((c) => c.args)

describe('creating a link', () => {
  it('is titled as a screen', async () => {
    show('create')
    expect(await screen.findByRole('heading', { level: 1, name: 'New link' })).toBeInTheDocument()
  })

  it('sends the domain and the target, leaves the slug to the install, and opens the new link', async () => {
    const { client, user } = show('create')
    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'Domain' }),
      'go.example.test',
    )
    await user.type(screen.getByLabelText('Target 1 URL'), 'https://example.com/offer')
    await user.click(screen.getByRole('button', { name: 'Create link' }))
    expect(await screen.findByRole('heading', { name: 'the link page' })).toBeInTheDocument()
    expect(sent(client, 'createLink')).toEqual([
      [{ host: 'go.example.test', targets: [{ url: 'https://example.com/offer' }] }],
    ])
  })

  it('says a link on an unverified domain will answer 404 until it is verified', async () => {
    const { user } = show('create')
    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'Domain' }),
      'new.example.test',
    )
    expect(
      screen.getByText('new.example.test is not verified yet: its links answer 404 until it is.'),
    ).toBeInTheDocument()
  })

  it('puts the service’s refusal under the field it names', async () => {
    const { user } = show('create', {
      createLink: () =>
        Promise.reject(
          new ApiError(400, 'invalid_link', 'targets.0.url: must be an absolute http or https URL'),
        ),
    })
    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'Domain' }),
      'go.example.test',
    )
    await user.type(screen.getByLabelText('Target 1 URL'), 'example.com/offer')
    await user.click(screen.getByRole('button', { name: 'Create link' }))
    expect(await screen.findByText('must be an absolute http or https URL')).toBeInTheDocument()
    expect(screen.getByLabelText('Target 1 URL')).toHaveAccessibleDescription(
      /^must be an absolute http or https URL/,
    )
    expect(screen.getByLabelText('Target 1 URL')).toHaveValue('example.com/offer')
    expect(screen.queryByRole('heading', { name: 'the link page' })).not.toBeInTheDocument()
  })

  // Two targets, and the service refuses the second one's weight: the words
  // belong to that weight's input, not to its URL, and a refusal with the
  // `invalid_body` code is placed the same way as one with `invalid_link`.
  it('puts a refusal of a weight under that weight', async () => {
    const { client, user } = show('create', {
      createLink: () =>
        Promise.reject(new ApiError(400, 'invalid_body', 'targets.1.weight: Expected number')),
    })
    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'Domain' }),
      'go.example.test',
    )
    await user.type(screen.getByLabelText('Target 1 URL'), 'https://example.com/a')
    await user.click(screen.getByRole('button', { name: 'Add a target' }))
    await user.type(screen.getByLabelText('Target 2 URL'), 'https://example.com/b')
    await user.clear(screen.getByLabelText('Target 1 weight'))
    await user.type(screen.getByLabelText('Target 1 weight'), '60')
    await user.type(screen.getByLabelText('Target 2 weight'), '40')
    await user.click(screen.getByRole('button', { name: 'Create link' }))
    expect(await screen.findByText('Expected number')).toBeInTheDocument()
    expect(screen.getByLabelText('Target 2 weight')).toHaveAccessibleDescription('Expected number')
    expect(screen.getByLabelText('Target 2 URL')).not.toHaveAccessibleDescription(/Expected number/)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(sent(client, 'createLink')).toEqual([
      [
        {
          host: 'go.example.test',
          targets: [
            { url: 'https://example.com/a', weight: 60 },
            { url: 'https://example.com/b', weight: 40 },
          ],
        },
      ],
    ])
  })

  it('says a slug is taken beside the slug', async () => {
    const { user } = show('create', {
      createLink: () =>
        Promise.reject(
          new ApiError(409, 'slug_taken', 'go.example.test already has a link at spring'),
        ),
    })
    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'Domain' }),
      'go.example.test',
    )
    await user.type(screen.getByLabelText('Slug'), 'spring')
    await user.type(screen.getByLabelText('Target 1 URL'), 'https://example.com/offer')
    await user.click(screen.getByRole('button', { name: 'Create link' }))
    expect(
      await screen.findByText('go.example.test already has a link at spring'),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Slug')).toHaveAccessibleDescription(
      /^go.example.test already has a link at spring/,
    )
    expect(screen.getByLabelText('Slug')).toHaveValue('spring')
    expect(screen.queryByRole('heading', { name: 'the link page' })).not.toBeInTheDocument()
  })

  // The link password is the visitors', not the operator's: a browser must not
  // offer to fill it in, or to save it as the operator's own.
  it('asks for a new password that a browser will not fill in', async () => {
    const { user } = show('create')
    await user.click(await screen.findByRole('checkbox', { name: 'Ask visitors for a password' }))
    const input = screen.getByLabelText('Link password')
    expect(input).toHaveAttribute('type', 'password')
    expect(input).toHaveAttribute('autocomplete', 'new-password')
    expect(input).toHaveValue('')
  })

  it('refuses weights that do not add up, and sends nothing', async () => {
    const { client, user } = show('create')
    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'Domain' }),
      'go.example.test',
    )
    await user.type(screen.getByLabelText('Target 1 URL'), 'https://example.com/a')
    await user.click(screen.getByRole('button', { name: 'Add a target' }))
    await user.type(screen.getByLabelText('Target 2 URL'), 'https://example.com/b')
    await user.clear(screen.getByLabelText('Target 1 weight'))
    await user.type(screen.getByLabelText('Target 1 weight'), '70')
    await user.clear(screen.getByLabelText('Target 2 weight'))
    await user.type(screen.getByLabelText('Target 2 weight'), '20')
    await user.click(screen.getByRole('button', { name: 'Create link' }))
    expect(screen.getByText('Weights add up to 90; they must add up to 100.')).toBeInTheDocument()
    expect(screen.getByLabelText('Target 2 weight')).toHaveAccessibleDescription(
      'Weights add up to 90; they must add up to 100.',
    )
    expect(sent(client, 'createLink')).toEqual([])
  })

  // Two submits in one tick, before the render that disables the button: the
  // second must not become a second link.
  it('sends one request however quickly it is submitted twice', async () => {
    const { client, user } = show('create', { createLink: () => new Promise<Link>(() => {}) })
    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'Domain' }),
      'go.example.test',
    )
    await user.type(screen.getByLabelText('Target 1 URL'), 'https://example.com/offer')
    const form = screen
      .getByRole('button', { name: 'Create link' })
      .closest('form') as HTMLFormElement
    act(() => {
      fireEvent.submit(form)
      fireEvent.submit(form)
    })
    expect(sent(client, 'createLink')).toEqual([
      [{ host: 'go.example.test', targets: [{ url: 'https://example.com/offer' }] }],
    ])
  })

  it('says a safe override needs the install’s safe URL, when there is none', async () => {
    const { user } = show('create')
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Bots' }), 'safe')
    expect(
      screen.getByText(
        'This install has no safe URL, so bots are flagged instead. Set one in Settings.',
      ),
    ).toBeInTheDocument()
  })

  // Before the settings answer, the form does not know whether there is a safe
  // URL, and must not say there is none.
  it('says nothing about the safe URL until the settings have loaded', async () => {
    let answer: (s: Settings) => void = () => {}
    const { user } = show('create', {
      settings: () =>
        new Promise<Settings>((r) => {
          answer = r
        }),
    })
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Bots' }), 'safe')
    expect(screen.queryByText(/has no safe URL/)).not.toBeInTheDocument()
    await act(async () => answer(SETTINGS))
    expect(
      screen.getByText(
        'This install has no safe URL, so bots are flagged instead. Set one in Settings.',
      ),
    ).toBeInTheDocument()
  })
})

describe('editing a link', () => {
  it('is titled by the link it edits', async () => {
    show('edit')
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Edit go.example.test/spring' }),
    ).toBeInTheDocument()
  })

  // The link has a password this form never saw. Renaming it must send the
  // name and nothing else, or the password goes with it.
  it('sends only the name when only the name was changed', async () => {
    const { client, user } = show('edit')
    const name = await screen.findByLabelText('Name')
    await user.clear(name)
    await user.type(name, 'Autumn offer')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByRole('heading', { name: 'the link page' })).toBeInTheDocument()
    expect(sent(client, 'updateLink')).toEqual([['l1', { name: 'Autumn offer' }]])
  })

  it('says there is nothing to save, and sends nothing, when nothing changed', async () => {
    const { client, user } = show('edit')
    await screen.findByLabelText('Name')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(screen.getByRole('status')).toHaveTextContent('Nothing has changed.')
    expect(sent(client, 'updateLink')).toEqual([])
  })

  it('removes the password only when told to', async () => {
    const { client, user } = show('edit')
    await user.click(await screen.findByRole('radio', { name: 'Remove the password' }))
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByRole('heading', { name: 'the link page' })).toBeInTheDocument()
    expect(sent(client, 'updateLink')).toEqual([['l1', { password: null }]])
  })

  // From one link's edit to another's: until the second link has answered,
  // nothing of the first — its title, its values, what was typed into it — is
  // shown, and what is then shown is the second link's.
  it('shows only the link the address names, after moving from one to another', async () => {
    let answer: (l: Link) => void = () => {}
    const client = fakeClient({
      domains: () =>
        Promise.resolve({ domains: [domain('go.example.test', true)], truncated: false }),
      settings: () => Promise.resolve(SETTINGS),
      link: (id) =>
        id === 'l1'
          ? Promise.resolve(LINK)
          : new Promise<Link>((r) => {
              answer = r
            }),
    })
    render(
      <MemoryRouter initialEntries={['/links/l1/edit']}>
        <ClientProvider client={client}>
          <RouterLink to="/links/l2/edit">the next link</RouterLink>
          <Routes>
            <Route path="/links/:id/edit" element={<LinkForm mode="edit" />} />
          </Routes>
        </ClientProvider>
      </MemoryRouter>,
    )
    const user = userEvent.setup()
    const name = await screen.findByLabelText('Name')
    await user.clear(name)
    await user.type(name, 'Typed into the first')
    await user.click(screen.getByRole('link', { name: 'the next link' }))
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument()
    await act(async () =>
      answer({ ...LINK, id: 'l2', slug: 'autumn', name: 'Autumn offer', hasPassword: false }),
    )
    expect(
      screen.getByRole('heading', { level: 1, name: 'Edit go.example.test/autumn' }),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Name')).toHaveValue('Autumn offer')
  })

  it('asks for a changed password that a browser will not fill in', async () => {
    const { user } = show('edit')
    await user.click(await screen.findByRole('radio', { name: 'Change the password' }))
    const input = screen.getByLabelText('New link password')
    expect(input).toHaveAttribute('type', 'password')
    expect(input).toHaveAttribute('autocomplete', 'new-password')
    expect(input).toHaveValue('')
  })

  // The domain has no field in an edit, so a refusal that names it is shown
  // with the form's own rather than dropped.
  it('shows a refusal of a field it has no place for', async () => {
    const { user } = show('edit', {
      updateLink: () =>
        Promise.reject(new ApiError(400, 'invalid_link', 'host: cannot be changed')),
    })
    const name = await screen.findByLabelText('Name')
    await user.type(name, ' 2')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/^host: cannot be changed$/)
  })

  // Each paragraph about a group of fields is read with every field it is about.
  it('describes each field with the refusal of the group it belongs to', async () => {
    const { user } = show('edit', {
      updateLink: () =>
        Promise.reject(
          new ApiError(
            400,
            'invalid_link',
            'targets: too many targets; deviceUrls.ios: bad device; countries: bad countries; password: bad password; trafficActions.bot: bad action',
          ),
        ),
    })
    const name = await screen.findByLabelText('Name')
    await user.type(name, ' 2')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('bad device')
    expect(screen.getByLabelText('Target 1 URL')).toHaveAccessibleDescription(/too many targets$/)
    for (const label of ['iPhone and iPad URL', 'Android URL', 'Desktop URL']) {
      expect(screen.getByLabelText(label)).toHaveAccessibleDescription(
        'bad device Each overrides the targets for that device.',
      )
    }
    expect(screen.getByRole('combobox', { name: 'Countries' })).toHaveAccessibleDescription(
      'bad countries',
    )
    expect(screen.getByRole('radio', { name: 'Keep the password' })).toHaveAccessibleDescription(
      'bad password',
    )
    expect(screen.getByRole('combobox', { name: 'Bots' })).toHaveAccessibleDescription('bad action')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('says a link that does not exist does not exist', async () => {
    show('edit', { link: () => Promise.reject(new ApiError(404, 'not_found', 'no such link')) })
    expect(
      await screen.findByRole('heading', { level: 1, name: 'No such link' }),
    ).toBeInTheDocument()
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument()
  })

  it('takes back “nothing has changed” once something is changed', async () => {
    const { user } = show('edit')
    const name = await screen.findByLabelText('Name')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(screen.getByRole('status')).toHaveTextContent('Nothing has changed.')
    await user.type(name, ' 2')
    expect(screen.queryByText('Nothing has changed.')).not.toBeInTheDocument()
  })

  it('does not show the domain as something it can change', async () => {
    show('edit')
    await screen.findByLabelText('Name')
    expect(screen.queryByRole('combobox', { name: 'Domain' })).not.toBeInTheDocument()
  })
})
