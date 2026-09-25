import { useClient } from '@/api/context'
import { ApiError } from '@/api/errors'
import type { Link, NonHumanClass, Settings, TrafficAction } from '@/api/types'
import { ACTION_LABELS, NON_HUMAN_CLASSES, TRAFFIC_ACTIONS } from '@/api/vocabulary'
import { ErrorNote } from '@/app/ErrorNote'
import { PageHeader } from '@/app/PageHeader'
import { browserZone } from '@/app/clock'
import { countryName } from '@/app/format'
import { useLoad } from '@/app/useLoad'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
import { type FormEvent, type ReactNode, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import {
  type LinkFormState,
  blankForm,
  countryCodes,
  fieldErrors,
  formOf,
  inputOf,
  patchOf,
  problemsOf,
} from './linkForm'

const TOKENS = 'A destination may use {click_id}, {country}, {device}, {link} and {param:NAME}.'

/** The API's most targets on one link. */
const MAX_TARGETS = 20

const PLURAL: Record<NonHumanClass, string> = {
  bot: 'Bots',
  abuser: 'Abusers',
  anonymous: 'Anonymous visitors',
  datacenter: 'Datacenter visitors',
}

const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1)

/** The ids of the `<p>`s that describe a control: its error first, then its hint. */
const describedBy = (id: string, error?: string, hint?: string): string | undefined =>
  [error ? `${id}-error` : null, hint ? `${id}-hint` : null].filter(Boolean).join(' ') || undefined

function Notes({ id, error, hint }: { id: string; error?: string; hint?: ReactNode }) {
  return (
    <>
      {error && (
        <p id={`${id}-error`} className="text-sm text-destructive">
          {error}
        </p>
      )}
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
    </>
  )
}

/** A labelled input with its error wired to it, the way every field in this form is. */
function Field(props: {
  id: string
  label: string
  value: string
  onChange: (v: string) => void
  error?: string
  hint?: string
  type?: string
  inputMode?: 'numeric' | 'url' | 'text'
  autoComplete?: string
}) {
  return (
    <div className="grid gap-1">
      <Label htmlFor={props.id}>{props.label}</Label>
      <Input
        id={props.id}
        type={props.type ?? 'text'}
        inputMode={props.inputMode}
        autoComplete={props.autoComplete}
        value={props.value}
        aria-invalid={props.error ? true : undefined}
        aria-describedby={describedBy(props.id, props.error, props.hint)}
        onChange={(e) => props.onChange(e.target.value)}
      />
      <Notes id={props.id} error={props.error} hint={props.hint} />
    </div>
  )
}

function CheckField(props: {
  id: string
  label: string
  checked: boolean
  onChange: (v: boolean) => void
  hint?: string
}) {
  return (
    <div className="grid gap-1">
      <div className="flex items-center gap-2">
        <Checkbox
          id={props.id}
          checked={props.checked}
          aria-describedby={describedBy(props.id, undefined, props.hint)}
          onCheckedChange={(v) => props.onChange(v === true)}
        />
        <Label htmlFor={props.id}>{props.label}</Label>
      </div>
      <Notes id={props.id} hint={props.hint} />
    </div>
  )
}

function Section({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset className="grid gap-4 rounded-md border border-border p-4">
      <legend className="px-1 text-sm font-semibold text-foreground">{legend}</legend>
      {children}
    </fieldset>
  )
}

/**
 * Creating a link, or editing one.
 *
 * The edit screen is keyed by the link's id, so moving from one link's edit to
 * another's starts again from nothing: the previous link's answer, its error
 * and anything typed into its form are gone, and the form never shows or sends
 * one link's values under another's address.
 */
export function LinkForm({ mode }: { mode: 'create' | 'edit' }) {
  const { id = '' } = useParams()
  return mode === 'create' ? <CreateScreen /> : <EditScreen key={id} id={id} />
}

function CreateScreen() {
  const client = useClient()
  const domains = useLoad(() => client.domains(), [])
  const settings = useLoad(() => client.settings(), [])
  return (
    <div className="grid gap-6">
      <PageHeader title="New link" />
      {domains.error && <ErrorNote error={domains.error} />}
      <FormBody
        mode="create"
        linkId={null}
        initial={blankForm('')}
        hasPassword={false}
        domains={domains.data?.domains ?? null}
        settings={settings.data ?? null}
      />
    </div>
  )
}

function EditScreen({ id }: { id: string }) {
  const client = useClient()
  const settings = useLoad(() => client.settings(), [])
  const existing = useLoad((signal) => client.link(id, { signal }), [id])
  const zone = browserZone()

  if (existing.error?.status === 404) {
    return <PageHeader title="No such link" description="It may have been deleted." />
  }
  if (existing.error) {
    return (
      <div className="grid gap-6">
        <PageHeader title="Edit link" />
        <ErrorNote error={existing.error} />
      </div>
    )
  }
  const link: Link | undefined = existing.data
  if (!link) return null
  return (
    <div className="grid gap-6">
      <PageHeader title={`Edit ${link.host}/${link.slug}`} />
      <FormBody
        mode="edit"
        linkId={link.id}
        initial={formOf(link, zone)}
        hasPassword={link.hasPassword}
        domains={null}
        settings={settings.data ?? null}
      />
    </div>
  )
}

function FormBody(props: {
  mode: 'create' | 'edit'
  linkId: string | null
  initial: LinkFormState
  hasPassword: boolean
  domains: { host: string; verified: boolean }[] | null
  settings: Settings | null
}) {
  const { mode, linkId, hasPassword, domains, settings } = props
  const client = useClient()
  const navigate = useNavigate()
  const zone = browserZone()
  const [before] = useState(props.initial)
  const [s, setS] = useState(props.initial)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [failure, setFailure] = useState<ApiError | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // One request at a time: a ref rather than the disabled state, because a
  // second press can land before the render that disables the button.
  const inFlight = useRef(false)

  const set = (patch: Partial<LinkFormState>) => {
    setStatus(null)
    setS((prev) => ({ ...prev, ...patch }))
  }
  const setTarget = (i: number, patch: Partial<{ url: string; weight: string }>) =>
    set({ targets: s.targets.map((t, j) => (j === i ? { ...t, ...patch } : t)) })

  const chosen = domains?.find((d) => d.host === s.host)
  const unverified =
    chosen && !chosen.verified
      ? `${chosen.host} is not verified yet: its links answer 404 until it is.`
      : undefined
  const several = s.targets.length > 1
  const weights = s.targets.map((t) => t.weight)
  const weightSum = weights.every((w) => /^\d+$/.test(w))
    ? weights.reduce((n, w) => n + Number(w), 0)
    : null
  const named = countryCodes(s.countryList).filter((c) => /^[A-Z]{2}$/.test(c))

  // Every key an error can land under that has a place of its own in the form.
  // A refusal under any other key (the domain, in an edit) is shown with the
  // form's own, so no message the service sent is dropped.
  const placed = new Set([
    'slug',
    'name',
    'targets',
    ...s.targets.map((_, i) => `targets.${i}`),
    'backupUrl',
    'deviceUrls',
    'returningUrl',
    'countries',
    'clickCap',
    'expiresAt',
    'password',
    'trafficActions',
    'passthrough',
    'enabled',
    ...(mode === 'create' ? ['host'] : []),
  ])
  const unplaced = Object.entries(errors)
    .filter(([k]) => k !== 'form' && !placed.has(k))
    .map(([k, v]) => `${k}: ${v}`)
  const formError = [errors.form, ...unplaced].filter(Boolean).join('; ')

  const save = async (e: FormEvent) => {
    e.preventDefault()
    if (inFlight.current) return
    setStatus(null)
    setFailure(null)
    const problems = problemsOf(s)
    setErrors(problems)
    if (Object.keys(problems).length > 0) return
    inFlight.current = true
    setBusy(true)
    try {
      if (mode === 'create') {
        const created = await client.createLink(inputOf(s, zone))
        navigate(`/links/${encodeURIComponent(created.id)}`)
      } else if (linkId !== null) {
        const patch = patchOf(before, s, zone)
        if (Object.keys(patch).length === 0) {
          setStatus('Nothing has changed.')
          return
        }
        await client.updateLink(linkId, patch)
        navigate(`/links/${encodeURIComponent(linkId)}`)
      }
    } catch (err) {
      if (!(err instanceof ApiError)) throw err
      if (err.code === 'invalid_link' || err.code === 'invalid_body')
        setErrors(fieldErrors(err.message))
      else if (err.code === 'slug_taken') setErrors({ slug: err.message })
      else setFailure(err)
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  const passwordBox = (
    <CheckField
      id="password-ask"
      label="Ask visitors for a password"
      checked={s.password.mode === 'set'}
      onChange={(on) => set({ password: { mode: on ? 'set' : 'keep', value: '' } })}
    />
  )

  return (
    <form className="grid gap-6" onSubmit={save} noValidate>
      <Section legend="Where">
        {mode === 'create' ? (
          <div className="grid gap-1">
            <Label htmlFor="host">Domain</Label>
            <NativeSelect
              id="host"
              value={s.host}
              aria-invalid={errors.host ? true : undefined}
              aria-describedby={describedBy('host', errors.host, unverified)}
              onChange={(e) => set({ host: e.target.value })}
            >
              <option value="">Choose a domain</option>
              {(domains ?? []).map((d) => (
                <option key={d.host} value={d.host}>
                  {d.host}
                </option>
              ))}
            </NativeSelect>
            <Notes id="host" error={errors.host} hint={unverified} />
            {domains !== null && domains.length === 0 && (
              <p className="text-sm text-muted-foreground">
                This install has no domains yet. Add one in Domains.
              </p>
            )}
          </div>
        ) : (
          <p className="text-sm">
            <span className="text-muted-foreground">Domain </span>
            <span className="font-mono">{s.host}</span>
          </p>
        )}
        <Field
          id="slug"
          label="Slug"
          value={s.slug}
          onChange={(slug) => set({ slug })}
          error={errors.slug}
          hint={mode === 'create' ? 'Leave empty and one is made for you.' : undefined}
        />
      </Section>

      <Section legend="Name">
        <Field
          id="name"
          label="Name"
          value={s.name}
          onChange={(name) => set({ name })}
          error={errors.name}
          hint="Shown in this interface only."
        />
      </Section>

      <Section legend="Targets">
        {s.targets.map((t, i) => {
          const n = i + 1
          return (
            // Targets have no id of their own until they are saved, and an
            // index is what the service's refusals name them by.
            // biome-ignore lint/suspicious/noArrayIndexKey: see above.
            <div key={i} className="grid gap-2">
              <Field
                id={`target-${i}-url`}
                label={`Target ${n} URL`}
                inputMode="url"
                value={t.url}
                onChange={(url) => setTarget(i, { url })}
                error={errors[`targets.${i}`]}
                hint={i === 0 ? TOKENS : undefined}
              />
              {several && (
                <div className="flex flex-wrap items-end gap-2">
                  <div className="w-28">
                    <Field
                      id={`target-${i}-weight`}
                      label={`Target ${n} weight`}
                      inputMode="numeric"
                      value={t.weight}
                      onChange={(weight) => setTarget(i, { weight })}
                    />
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => set({ targets: s.targets.filter((_, j) => j !== i) })}
                  >
                    {`Remove target ${n}`}
                  </Button>
                </div>
              )}
            </div>
          )
        })}
        {s.targets.length < MAX_TARGETS && (
          <Button
            type="button"
            variant="outline"
            className="justify-self-start"
            onClick={() => set({ targets: [...s.targets, { url: '', weight: '' }] })}
          >
            Add a target
          </Button>
        )}
        {several && weightSum !== null && (
          <output className="block text-sm text-muted-foreground">{`Weights add up to ${weightSum}.`}</output>
        )}
        {errors.targets && <p className="text-sm text-destructive">{errors.targets}</p>}
      </Section>

      <Section legend="When a visitor is turned away">
        <Field
          id="backup-url"
          label="Backup URL"
          inputMode="url"
          value={s.backupUrl}
          onChange={(backupUrl) => set({ backupUrl })}
          error={errors.backupUrl}
          hint="Where a visitor goes when the cap is reached, the link has expired, or their country is not allowed. Without one, they get an error page."
        />
      </Section>

      <Section legend="By device">
        <Field
          id="device-ios"
          label="iPhone and iPad URL"
          inputMode="url"
          value={s.deviceUrls.ios}
          onChange={(ios) => set({ deviceUrls: { ...s.deviceUrls, ios } })}
        />
        <Field
          id="device-android"
          label="Android URL"
          inputMode="url"
          value={s.deviceUrls.android}
          onChange={(android) => set({ deviceUrls: { ...s.deviceUrls, android } })}
        />
        <Field
          id="device-desktop"
          label="Desktop URL"
          inputMode="url"
          value={s.deviceUrls.desktop}
          onChange={(desktop) => set({ deviceUrls: { ...s.deviceUrls, desktop } })}
        />
        <Notes
          id="device"
          error={errors.deviceUrls}
          hint="Each overrides the targets for that device."
        />
      </Section>

      <Section legend="Returning visitors">
        <Field
          id="returning-url"
          label="Returning-visitor URL"
          inputMode="url"
          value={s.returningUrl}
          onChange={(returningUrl) => set({ returningUrl })}
          error={errors.returningUrl}
          hint="Used when this visitor has clicked this link before."
        />
      </Section>

      <Section legend="Countries">
        <div className="grid gap-1">
          <Label htmlFor="country-mode">Countries</Label>
          <NativeSelect
            id="country-mode"
            value={s.countryMode}
            onChange={(e) => set({ countryMode: e.target.value as LinkFormState['countryMode'] })}
          >
            <option value="all">Allow every country</option>
            <option value="allow">Allow only these</option>
            <option value="block">Block these</option>
          </NativeSelect>
        </div>
        {s.countryMode !== 'all' && (
          <div className="grid gap-1">
            <Field
              id="country-list"
              label="Country codes"
              value={s.countryList}
              onChange={(countryList) => set({ countryList })}
              error={errors.countries}
              hint="Two-letter codes, separated by commas: DE, FR"
            />
            {named.length > 0 && (
              <p className="text-sm text-muted-foreground">{named.map(countryName).join(', ')}</p>
            )}
          </div>
        )}
        {s.countryMode === 'all' && errors.countries && (
          <p className="text-sm text-destructive">{errors.countries}</p>
        )}
      </Section>

      <Section legend="Limits">
        <Field
          id="click-cap"
          label="Click cap"
          inputMode="numeric"
          value={s.clickCap}
          onChange={(clickCap) => set({ clickCap })}
          error={errors.clickCap}
          hint="Visitors past this many counted clicks go to the backup URL. Flagged clicks and HEAD requests are never counted."
        />
        <Field
          id="expires"
          label="Expires"
          type="datetime-local"
          value={s.expiresAt}
          onChange={(expiresAt) => set({ expiresAt })}
          error={errors.expiresAt}
          hint={`Times in ${zone}.`}
        />
      </Section>

      <Section legend="Password">
        {mode === 'edit' && hasPassword ? (
          <div className="grid gap-2" role="radiogroup" aria-label="Password">
            {(
              [
                ['keep', 'Keep the password'],
                ['set', 'Change the password'],
                ['remove', 'Remove the password'],
              ] as const
            ).map(([value, label]) => (
              <div key={value} className="flex items-center gap-2">
                <input
                  id={`password-${value}`}
                  type="radio"
                  name="password-mode"
                  className="accent-primary"
                  checked={s.password.mode === value}
                  onChange={() => set({ password: { mode: value, value: '' } })}
                />
                <Label htmlFor={`password-${value}`}>{label}</Label>
              </div>
            ))}
          </div>
        ) : (
          passwordBox
        )}
        {s.password.mode === 'set' && (
          <Field
            id="password-value"
            label={mode === 'edit' && hasPassword ? 'New link password' : 'Link password'}
            type="password"
            autoComplete="new-password"
            value={s.password.value}
            onChange={(value) => set({ password: { mode: 'set', value } })}
            error={errors.password}
          />
        )}
        {s.password.mode !== 'set' && errors.password && (
          <p className="text-sm text-destructive">{errors.password}</p>
        )}
      </Section>

      <Section legend="Traffic">
        {NON_HUMAN_CLASSES.map((c) => {
          const current = settings?.traffic.actions[c]
          // Only once the settings have loaded: before then, an install that
          // has a safe URL would be told it has none.
          const noSafe =
            s.trafficActions[c] === 'safe' && settings !== null && settings.traffic.safeUrl === null
          return (
            <div key={c} className="grid gap-1">
              <Label htmlFor={`traffic-${c}`}>{PLURAL[c]}</Label>
              <NativeSelect
                id={`traffic-${c}`}
                value={s.trafficActions[c]}
                aria-describedby={noSafe ? `traffic-${c}-hint` : undefined}
                onChange={(e) =>
                  set({
                    trafficActions: {
                      ...s.trafficActions,
                      [c]: e.target.value as TrafficAction | 'inherit',
                    },
                  })
                }
              >
                <option value="inherit">
                  {current
                    ? `Use the install's setting (${lowerFirst(ACTION_LABELS[current])})`
                    : "Use the install's setting"}
                </option>
                {TRAFFIC_ACTIONS.map((a) => (
                  <option key={a} value={a}>
                    {ACTION_LABELS[a]}
                  </option>
                ))}
              </NativeSelect>
              <Notes
                id={`traffic-${c}`}
                hint={
                  noSafe
                    ? `This install has no safe URL, so ${PLURAL[c].toLowerCase()} are flagged instead. Set one in Settings.`
                    : undefined
                }
              />
            </div>
          )
        })}
        {errors.trafficActions && (
          <p className="text-sm text-destructive">{errors.trafficActions}</p>
        )}
      </Section>

      <Section legend="Also">
        <CheckField
          id="passthrough"
          label="Pass the visitor's query string on"
          checked={s.passthrough}
          onChange={(passthrough) => set({ passthrough })}
        />
        <CheckField
          id="enabled"
          label="Enabled"
          checked={s.enabled}
          onChange={(enabled) => set({ enabled })}
          hint="A disabled link answers as an unknown slug."
        />
      </Section>

      <div className="grid gap-2">
        <Button type="submit" className="justify-self-start" disabled={busy}>
          {mode === 'create' ? 'Create link' : 'Save changes'}
        </Button>
        {status && <output className="block text-sm text-muted-foreground">{status}</output>}
        {failure && <ErrorNote error={failure} />}
        {formError && (
          <p role="alert" className="text-sm text-destructive">
            {formError}
          </p>
        )}
      </div>
    </form>
  )
}
