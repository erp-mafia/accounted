/**
 * After a payment or a credit note on an invoice with a collection case, the
 * page reads the case again: the payment is reported to the provider right
 * after the request that booked it, so the first read may still show the
 * amounts from before it. While the read says a report is on its way, read
 * again a few times. Pure and client-safe; the clock is injected for tests.
 */

export const CASE_RELOAD_TRIES = 5
export const CASE_RELOAD_DELAY_MS = 1_500

export async function reloadUntilReported<T extends { case: { forwardsInFlight: boolean } | null }>(
  read: () => Promise<T | null>,
  apply: (next: T) => void,
  options: { tries?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const tries = options.tries ?? CASE_RELOAD_TRIES
  const delayMs = options.delayMs ?? CASE_RELOAD_DELAY_MS
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  for (let attempt = 0; attempt < tries; attempt++) {
    if (attempt > 0) await sleep(delayMs)
    const next = await read()
    if (next) apply(next)
    if (!next?.case?.forwardsInFlight) return
  }
}
