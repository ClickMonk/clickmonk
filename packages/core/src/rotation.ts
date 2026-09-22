import type { Target } from './link.js'

/** Weighted choice. `random` is in [0, 1). Weights need not sum to 100. */
export function pickTarget(targets: readonly Target[], random: number): Target {
  if (targets.length === 0) throw new Error('pickTarget: no targets')
  const total = targets.reduce((s, t) => s + t.weight, 0)
  let point = random * total
  for (const t of targets) {
    if (point < t.weight) return t
    point -= t.weight
  }
  return targets[targets.length - 1] as Target
}
