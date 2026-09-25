import type { ReactNode } from 'react'

/** A screen's title — its only `<h1>` — with an optional line under it and actions beside it. */
export function PageHeader({
  title,
  description,
  actions,
}: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="grid gap-1">
        <h1 className="font-serif text-2xl font-semibold text-foreground">{title}</h1>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </header>
  )
}
