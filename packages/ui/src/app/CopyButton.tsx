import { Button } from '@/components/ui/button'
import { Copy } from 'lucide-react'
import { useState } from 'react'

/** Copies a value — a TXT record, a new key — and says it did, to a screen reader as well. */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-label={label}
        onClick={async () => {
          await navigator.clipboard.writeText(value)
          setCopied(true)
        }}
      >
        <Copy className="size-4" aria-hidden="true" />
      </Button>
      <output className="text-xs text-muted-foreground">{copied ? 'Copied' : ''}</output>
    </span>
  )
}
