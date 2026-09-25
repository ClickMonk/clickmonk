import { ApiError } from '@/api/errors'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'
import { type ReactElement, type ReactNode, cloneElement, useState } from 'react'
import { ErrorNote } from './ErrorNote'

/**
 * A destructive action, confirmed. The body says what happens, in the terms the
 * service defines it; the confirm button is named by the action, never "OK".
 * A failure keeps the dialog open and says why, rather than closing it on an
 * action that did not happen.
 */
export function Confirm(props: {
  title: string
  body: ReactNode
  action: string
  destructive?: boolean
  onConfirm: () => Promise<unknown>
  trigger: ReactElement<{ onClick?: () => void }>
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      await props.onConfirm()
      setOpen(false)
    } catch (err) {
      if (err instanceof ApiError) setError(err)
      else throw err
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      {cloneElement(props.trigger, { onClick: () => setOpen(true) })}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={props.title}
        description={props.body}
        alert
      >
        {error && <ErrorNote error={error} />}
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="outline" disabled={busy} onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant={props.destructive ? 'destructive' : 'default'}
            disabled={busy}
            onClick={confirm}
          >
            {props.action}
          </Button>
        </div>
      </Modal>
    </>
  )
}
