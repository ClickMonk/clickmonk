import { cn } from '@/lib/utils'
import { type ReactNode, useEffect, useId, useRef } from 'react'

/**
 * A modal on the browser's own <dialog>, opened with showModal(): focus moves
 * into it, the page behind it is inert, and Escape closes it — all without a
 * line of script of ours and without a style element, which is why this is not
 * the component library's dialog (that one injects a <style> tag the content
 * security policy refuses).
 *
 * Controlled: `open` decides, and every way the browser closes it (Escape, a
 * form with method="dialog") is reported through `onClose` so the owner's
 * state follows.
 */
export function Modal(props: {
  open: boolean
  onClose: () => void
  title: string
  description?: ReactNode
  alert?: boolean
  children?: ReactNode
  className?: string
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  const onClose = useRef(props.onClose)
  onClose.current = props.onClose
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (props.open && !d.open) d.showModal()
    if (!props.open && d.open) d.close()
  }, [props.open])
  // The browser's own `close` event, listened for directly: it fires for
  // Escape and for a `method="dialog"` form as well as for `close()`, and
  // listening on the element does not depend on how React maps a dialog's
  // events.
  useEffect(() => {
    const d = ref.current
    if (!d) return
    const closed = () => onClose.current()
    d.addEventListener('close', closed)
    return () => d.removeEventListener('close', closed)
  }, [])
  return (
    <dialog
      ref={ref}
      role={props.alert ? 'alertdialog' : undefined}
      aria-labelledby={titleId}
      aria-describedby={props.description ? descriptionId : undefined}
      className={cn(
        'w-[min(32rem,calc(100vw-2rem))] rounded-lg border border-border bg-card p-6 text-card-foreground',
        'backdrop:bg-background/80',
        props.className,
      )}
    >
      {/* Nothing inside while closed: a closed <dialog> keeps its contents in
          the page, where a label query finds them and a one-time secret would
          sit until the next render. */}
      {props.open && (
        <>
          <h2 id={titleId} className="font-serif text-lg font-semibold">
            {props.title}
          </h2>
          {props.description && (
            <div id={descriptionId} className="mt-2 text-sm text-muted-foreground">
              {props.description}
            </div>
          )}
          <div className="mt-4">{props.children}</div>
        </>
      )}
    </dialog>
  )
}
