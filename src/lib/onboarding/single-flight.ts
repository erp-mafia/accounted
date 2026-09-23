/**
 * One run at a time. A call that arrives while a run is outstanding shares
 * its promise and marks the run stale, so exactly one fresh run follows it:
 * the caller that just changed the data never settles on a read that
 * started before the change, and triggers never stack up as parallel
 * requests.
 */
export function singleFlight<T>(run: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null
  let stale = false
  return () => {
    if (inFlight) {
      stale = true
      return inFlight
    }
    inFlight = (async () => {
      try {
        let result = await run()
        while (stale) {
          stale = false
          result = await run()
        }
        return result
      } finally {
        inFlight = null
        stale = false
      }
    })()
    return inFlight
  }
}
