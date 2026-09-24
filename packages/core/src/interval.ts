/**
 * How long a loop may wait, against what a timer can actually hold.
 *
 * `setTimeout` keeps its delay in a signed 32-bit integer. Given more it does
 * not throw and does not clamp to the maximum: it prints
 * `TimeoutOverflowWarning` and **substitutes 1**. So an interval of
 * 2,147,483,648 ms — a little over the ceiling, and a little under twenty-five
 * days, which is what someone asking for a monthly pass types — turns a loop
 * that was meant to run once a month into one that runs about a hundred and
 * seventy times a second. Measured on the retention pass: 342 passes in two
 * seconds, each one a Postgres transaction taking the settings row's lock and a
 * `system.parts` query, with a process warning as the only signal.
 *
 * It is the same rule as every other bound in this codebase — a value is checked
 * against the range of the thing it is handed to, not only against its shape —
 * with the thing being a Node API rather than a store column, and the cost being
 * sustained load rather than a bad request answered as an outage.
 */
export const MAX_TIMER_MS = 2_147_483_647

/**
 * The interval, or a throw naming it.
 *
 * In the loop and not only in the configuration schema, because a caller reaching
 * a loop directly is how this was measured in the first place, and because a bound
 * that lives only in a schema is a bound the next caller does not have. The floor
 * here is one millisecond rather than the second an operator's configuration is
 * held to: this is the range a timer can hold, and the shortest interval an
 * install may ask for is a separate decision made where that configuration is
 * read.
 */
export function checkIntervalMs(name: string, ms: number): number {
  if (!Number.isInteger(ms) || ms < 1 || ms > MAX_TIMER_MS) {
    throw new Error(
      `${name}: must be a whole number of milliseconds from 1 to ${MAX_TIMER_MS}, not ${ms}`,
    )
  }
  return ms
}
