import { describe, expect, it } from 'vitest'
import { buttonVariants } from './button'

describe('the outline button', () => {
  // --cm-border, the default border role, measures about 1.3:1 against the
  // page in the light theme — a plain line, not an edge. border-input maps
  // to --cm-border-interactive, the input border role, at about 4:1.
  it('draws its edge in the input border role, not the default border role', () => {
    expect(buttonVariants({ variant: 'outline' })).toContain('border-input')
  })

  it('leaves the other variants without an explicit border role', () => {
    for (const variant of ['default', 'destructive', 'secondary', 'ghost', 'link'] as const) {
      expect(buttonVariants({ variant })).not.toContain('border-input')
    }
  })
})
