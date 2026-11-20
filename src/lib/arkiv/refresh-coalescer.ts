/**
 * One archive reload per batch of uploads (J17, 2026-11-08). Every upload
 * that lands in Arkiv asks the folder tree to reload, and a reload is the
 * folder summary plus the first page of every open folder: ten files dropped
 * at once used to fire about fifty GET /api/arkiv/documents requests within
 * two seconds. The requests are coalesced instead: the reload runs `wait` ms
 * after the last landing, and never later than `maxWait` ms after the first
 * one of the burst, so one slow file cannot hold back the rest.
 */
export interface RefreshCoalescer {
  trigger: () => void
  cancel: () => void
}

export function createRefreshCoalescer(
  run: () => void,
  { wait, maxWait }: { wait: number; maxWait: number },
): RefreshCoalescer {
  let timer: ReturnType<typeof setTimeout> | null = null
  let firstAt: number | null = null

  const fire = () => {
    timer = null
    firstAt = null
    run()
  }

  return {
    trigger() {
      const now = Date.now()
      if (firstAt === null) firstAt = now
      if (timer !== null) clearTimeout(timer)
      const delay = Math.max(0, Math.min(wait, firstAt + maxWait - now))
      timer = setTimeout(fire, delay)
    },
    cancel() {
      if (timer !== null) clearTimeout(timer)
      timer = null
      firstAt = null
    },
  }
}
