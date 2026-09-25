import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
import { useState } from 'react'
import { PRESETS, PRESET_LABELS, type PresetId, parseChoice } from './range'
import { useWindow } from './useWindow'

/**
 * The time range every report on a screen shares. A preset applies at once; a
 * custom range applies on "Apply", after the two dates have been checked here
 * the way the address parser checks them, so a range the parser would refuse
 * is never written to the address.
 */
export function WindowPicker() {
  const { choice, setChoice, problem } = useWindow()
  const custom = 'from' in choice
  const [editing, setEditing] = useState(custom)
  const [from, setFrom] = useState(custom ? choice.from : '')
  const [to, setTo] = useState(custom ? choice.to : '')
  const [error, setError] = useState<string | null>(null)

  const apply = () => {
    if (from === '' || to === '') return setError('Choose both dates.')
    if (to < from) return setError('The end date is before the start date.')
    const checked = parseChoice(new URLSearchParams({ from, to }))
    if (checked.problem !== null) return setError('A custom range is at most 366 days.')
    setError(null)
    setChoice({ from, to })
  }

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="grid gap-1">
        <Label htmlFor="window-range">Time range</Label>
        <NativeSelect
          id="window-range"
          value={editing ? 'custom' : 'preset' in choice ? choice.preset : 'custom'}
          onChange={(e) => {
            const v = e.target.value
            if (v === 'custom') return setEditing(true)
            setEditing(false)
            setChoice({ preset: v as PresetId })
          }}
        >
          {PRESETS.map((p) => (
            <option key={p} value={p}>
              {PRESET_LABELS[p]}
            </option>
          ))}
          <option value="custom">Custom…</option>
        </NativeSelect>
      </div>
      {editing && (
        <>
          <div className="grid gap-1">
            <Label htmlFor="window-from">From</Label>
            <Input
              id="window-from"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="window-to">To</Label>
            <Input id="window-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <Button type="button" variant="secondary" onClick={apply}>
            Apply
          </Button>
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {problem && <output className="block text-sm text-muted-foreground">{problem}</output>}
    </div>
  )
}
