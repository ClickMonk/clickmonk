import { Button } from '@/components/ui/button'
import { Copy } from 'lucide-react'
import { useState } from 'react'

/**
 * Copies a value — a TXT record, a new key — and says it did, to a screen
 * reader as well. `navigator.clipboard` can refuse or be absent (plain http
 * on a LAN address, a browser without permission), and that is said too,
 * rather than left as a click that did nothing and an unhandled rejection.
 */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle')
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-label={label}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value)
            setStatus('copied')
          } catch {
            setStatus('failed')
          }
        }}
      >
        <Copy className="size-4" aria-hidden="true" />
      </Button>
      <output className="text-xs text-muted-foreground">
        {status === 'copied' && 'Copied'}
        {status === 'failed' && 'Could not copy. Select the value and copy it.'}
      </output>
    </span>
  )
}
