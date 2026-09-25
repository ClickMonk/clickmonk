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
  // An error that is not an `ApiError` is a defect, not a refusal to show. It
  // is rethrown to React the way `useLoad` does: an async event handler's own
  // returned promise is never awaited by anything, so throwing straight from
  // `catch` here would only be an unhandled rejection, never seen.
  const [thrown, setThrown] = useState<unknown>(null)
  if (thrown !== null) throw thrown
  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      await props.onConfirm()
      setOpen(false)
    } catch (err) {
      if (err instanceof ApiError) setError(err)
      else setThrown(err)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      {cloneElement(props.trigger, {
        onClick: () => {
          setError(null)
          setOpen(true)
        },
      })}
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
