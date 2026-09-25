import { useClient } from '@/api/context'
import { ApiError } from '@/api/errors'
import type { NonHumanClass, Settings as SettingsData, SettingsInput } from '@/api/types'
import { ACTION_LABELS, NON_HUMAN_CLASSES, TRAFFIC_ACTIONS } from '@/api/vocabulary'
import { ErrorNote } from '@/app/ErrorNote'
import { PageHeader } from '@/app/PageHeader'
import { useLoad } from '@/app/useLoad'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Modal } from '@/components/ui/modal'
import { NativeSelect } from '@/components/ui/native-select'
import { type FormEvent, useState } from 'react'
import {
  type SettingsFormState,
  deletesData,
  settingsFormOf,
  settingsInputOf,
  settingsProblems,
} from './settingsForm'

const PLURAL: Record<NonHumanClass, string> = {
  bot: 'Bots',
  abuser: 'Abusers',
  anonymous: 'Anonymous visitors',
  datacenter: 'Datacenter visitors',
}

/** The button that names the action, from the sentence `deletesData` wrote. */
function confirmAction(sentence: string): string {
  const clicks = sentence.includes('Clicks older than')
  const addresses = sentence.includes('Addresses older than')
  if (clicks && addresses) return 'Delete older data and save'
  if (clicks) return 'Delete older clicks and save'
  return 'Blank older addresses and save'
}

/**
 * The install's settings: the action for each non-human class and the safe
 * URL and abuser threshold that go with it, and how long clicks and their
 * addresses are kept. The two halves are saved together, as the service
 * replaces them.
 */
export function Settings() {
  const client = useClient()
  const load = useLoad(() => client.settings(), [])
  return (
    <div className="grid gap-6">
      <PageHeader title="Settings" />
      {load.state === 'error' && load.error && <ErrorNote error={load.error} />}
      {load.state !== 'error' && load.data && (
        <div
          aria-busy={load.state === 'loading'}
          className={load.state === 'loading' ? 'grid gap-6 opacity-50' : 'grid gap-6'}
        >
          <SettingsBody settings={load.data} />
        </div>
      )}
    </div>
  )
}

function SettingsBody({ settings }: { settings: SettingsData }) {
  const client = useClient()
  const [current, setCurrent] = useState(settings)
  const [form, setForm] = useState<SettingsFormState>(() => settingsFormOf(settings))
  const [problems, setProblems] = useState<Record<string, string>>({})
  const [status, setStatus] = useState<string | null>(null)
  const [failure, setFailure] = useState<ApiError | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<{ sentence: string; input: SettingsInput } | null>(null)
  // A failure that is not an `ApiError` is a defect, not a refusal to show,
  // and is rethrown to React the way `Confirm` does.
  const [thrown, setThrown] = useState<unknown>(null)
  if (thrown !== null) throw thrown

  const set = (patch: Partial<SettingsFormState>) => {
    setStatus(null)
    setForm((f) => ({ ...f, ...patch }))
  }

  const doSave = async (input: SettingsInput) => {
    setBusy(true)
    setFailure(null)
    try {
      const result = await client.putSettings(input)
      setCurrent(result)
      setForm(settingsFormOf(result))
      setStatus('Saved.')
      setConfirm(null)
    } catch (err) {
      if (err instanceof ApiError) setFailure(err)
      else setThrown(err)
    } finally {
      setBusy(false)
    }
  }

  const save = (e: FormEvent) => {
    e.preventDefault()
    setStatus(null)
    setFailure(null)
    const probs = settingsProblems(form)
    setProblems(probs)
    if (Object.keys(probs).length > 0) return
    const input = settingsInputOf(form)
    const sentence = deletesData(current.retention, input.retention)
    if (sentence) setConfirm({ sentence, input })
    else void doSave(input)
  }

  const unreadable = current.problem !== null

  return (
    <form className="grid gap-6" onSubmit={save} noValidate>
      <fieldset className="grid gap-4 rounded-md border border-border p-4">
        <legend className="px-1 text-sm font-semibold text-foreground">Traffic</legend>
        {NON_HUMAN_CLASSES.map((c) => (
          <div key={c} className="grid gap-1">
            <Label htmlFor={`traffic-${c}`}>{PLURAL[c]}</Label>
            <NativeSelect
              id={`traffic-${c}`}
              value={form.actions[c]}
              onChange={(e) =>
                set({
                  actions: {
                    ...form.actions,
                    [c]: e.target.value as SettingsFormState['actions'][NonHumanClass],
                  },
                })
              }
            >
              {TRAFFIC_ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {ACTION_LABELS[a]}
                </option>
              ))}
            </NativeSelect>
          </div>
        ))}
        <p className="text-sm text-muted-foreground">
          Humans are always counted and sent on. A class's action can be overridden per link.
        </p>
        <div className="grid gap-1">
          <Label htmlFor="safe-url">Safe URL</Label>
          <Input
            id="safe-url"
            value={form.safeUrl}
            aria-invalid={problems.safeUrl ? true : undefined}
            aria-describedby={problems.safeUrl ? 'safe-url-error' : undefined}
            onChange={(e) => set({ safeUrl: e.target.value })}
          />
          {problems.safeUrl && (
            <p id="safe-url-error" className="text-sm text-destructive">
              {problems.safeUrl}
            </p>
          )}
        </div>
        <div className="grid gap-1">
          <Label htmlFor="abuser-threshold">Abuser threshold</Label>
          <Input
            id="abuser-threshold"
            type="text"
            inputMode="numeric"
            value={form.abuserThreshold}
            aria-invalid={problems.abuserThreshold ? true : undefined}
            aria-describedby={
              problems.abuserThreshold ? 'abuser-threshold-error' : 'abuser-threshold-hint'
            }
            onChange={(e) => set({ abuserThreshold: e.target.value })}
          />
          {problems.abuserThreshold ? (
            <p id="abuser-threshold-error" className="text-sm text-destructive">
              {problems.abuserThreshold}
            </p>
          ) : (
            <p id="abuser-threshold-hint" className="text-xs text-muted-foreground">
              Requests a minute from one address, counting an IPv6 /64 as one, before it is classed
              as an abuser.
            </p>
          )}
        </div>
      </fieldset>

      <fieldset className="grid gap-4 rounded-md border border-border p-4">
        <legend className="px-1 text-sm font-semibold text-foreground">Retention</legend>
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1">
            <Label htmlFor="raw-days">Keep clicks for (days)</Label>
            <Input
              id="raw-days"
              type="text"
              inputMode="numeric"
              value={form.raw.days}
              disabled={form.raw.forever}
              aria-invalid={problems.raw ? true : undefined}
              aria-describedby={problems.raw ? 'raw-days-error' : undefined}
              onChange={(e) => set({ raw: { ...form.raw, days: e.target.value } })}
            />
          </div>
          <div className="flex items-center gap-2 pb-2">
            <Checkbox
              id="raw-forever"
              checked={form.raw.forever}
              onCheckedChange={(v) => set({ raw: { ...form.raw, forever: v === true } })}
            />
            <Label htmlFor="raw-forever">Keep clicks for ever</Label>
          </div>
        </div>
        {problems.raw && (
          <p id="raw-days-error" className="text-sm text-destructive">
            {problems.raw}
          </p>
        )}
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1">
            <Label htmlFor="ip-days">Keep addresses for (days)</Label>
            <Input
              id="ip-days"
              type="text"
              inputMode="numeric"
              value={form.ip.days}
              disabled={form.ip.forever}
              aria-invalid={problems.ip ? true : undefined}
              aria-describedby={problems.ip ? 'ip-days-error' : undefined}
              onChange={(e) => set({ ip: { ...form.ip, days: e.target.value } })}
            />
          </div>
          <div className="flex items-center gap-2 pb-2">
            <Checkbox
              id="ip-forever"
              checked={form.ip.forever}
              onCheckedChange={(v) => set({ ip: { ...form.ip, forever: v === true } })}
            />
            <Label htmlFor="ip-forever">Keep addresses for ever</Label>
          </div>
        </div>
        {problems.ip && (
          <p id="ip-days-error" className="text-sm text-destructive">
            {problems.ip}
          </p>
        )}
        <p className="text-sm text-muted-foreground">
          A period is a floor: clicks are dropped a month at a time, so 90 days keeps 90 to 121.
        </p>
        {current.note && <p className="text-sm text-muted-foreground">{current.note}</p>}
        {unreadable && (
          <p className="text-sm text-muted-foreground">
            The stored retention settings could not be read, so nothing is being deleted until
            retention is saved again. Choose both periods and save.
          </p>
        )}
      </fieldset>

      <div className="grid gap-2">
        <Button type="submit" className="justify-self-start" disabled={busy}>
          Save settings
        </Button>
        {status && <output className="block text-sm text-muted-foreground">{status}</output>}
        {confirm === null && failure && <ErrorNote error={failure} />}
      </div>

      <Modal
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title="Delete older data?"
        description={confirm?.sentence}
        alert
      >
        {confirm !== null && failure && <ErrorNote error={failure} />}
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="outline" disabled={busy} onClick={() => setConfirm(null)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={busy}
            onClick={() => confirm && void doSave(confirm.input)}
          >
            {confirm ? confirmAction(confirm.sentence) : ''}
          </Button>
        </div>
      </Modal>
    </form>
  )
}
