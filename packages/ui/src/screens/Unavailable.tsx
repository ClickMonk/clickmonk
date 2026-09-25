import type { ApiError } from '@/api/errors'
import { ErrorNote } from '@/app/ErrorNote'
import { ThemeToggle } from '@/app/ThemeToggle'
import { Button } from '@/components/ui/button'

export function Unavailable({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  return (
    <main className="mx-auto grid min-h-dvh w-full max-w-md content-center gap-4 px-4">
      <div className="flex items-center justify-between">
        <h1 className="font-serif text-2xl font-semibold text-foreground">
          ClickMonk is not responding
        </h1>
        <ThemeToggle />
      </div>
      <ErrorNote error={error} />
      <Button type="button" onClick={onRetry} className="justify-self-start">
        Try again
      </Button>
    </main>
  )
}
