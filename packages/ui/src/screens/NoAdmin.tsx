import { ThemeToggle } from '@/app/ThemeToggle'

/** The install has no account. Nothing in a browser can create one; the server can. */
export function NoAdmin() {
  return (
    <main className="mx-auto grid min-h-dvh w-full max-w-xl content-center gap-4 px-4">
      <div className="flex items-center justify-between">
        <h1 className="font-serif text-2xl font-semibold text-foreground">
          ClickMonk has no admin account yet
        </h1>
        <ThemeToggle />
      </div>
      <p className="text-sm text-muted-foreground">
        Create it on the server, with the password on standard input so that it never appears in
        your shell history:
      </p>
      <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-sm text-foreground">
        {`printf '%s' 'your-admin-password' | docker compose exec -T worker \\\n  node packages/cli/dist/index.js admin create you@example.com`}
      </pre>
      <p className="text-sm text-muted-foreground">Then reload this page.</p>
    </main>
  )
}
