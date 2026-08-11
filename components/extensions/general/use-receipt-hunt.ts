'use client'

/**
 * Running the receipt hunt from a button.
 *
 * The loop was written for the settings panel and lived there. It belongs to
 * neither surface: the Underlag page is where a person notices that receipts
 * are missing, and asking them to walk to Settings to press the button that
 * fixes it is the kind of seam that makes a feature look broken. Both call this
 * now, so there is one definition of what a run does and when it stops.
 *
 * Why a client loop rather than one long request: a single pass is bounded by
 * the serverless ceiling, and each receipt costs a download plus a model read,
 * which is far too slow to clear a backlog inside one invocation. A queue
 * drained by cron would be the other option, but the finest schedule this app
 * runs is hourly, so pressing the button would mean waiting an hour.
 *
 * It stops when a pass finds nothing new. That is the honest signal that the
 * mailboxes hold nothing more for the purchases still open, and it is why the
 * cap below is a backstop rather than a budget.
 */
import { useCallback, useRef, useState } from 'react'

export interface HuntResult {
  searched: number
  fetched: number
  proposed: number
  remaining: number
  failed?: boolean
  /** Connections that refused the search. See the stop condition below. */
  searchFailures?: number
}

export interface HuntProgress {
  passes: number
  fetched: number
  proposed: number
}

/**
 * Each pass fetches a few receipts, so this is far more than any real backlog
 * needs. It exists so a pass that keeps reporting work it never completes
 * cannot run forever.
 */
export const MAX_PASSES = 25

export function useReceiptHunt(onPass?: () => void) {
  const [hunting, setHunting] = useState(false)
  const [progress, setProgress] = useState<HuntProgress | null>(null)
  const [result, setResult] = useState<HuntResult | null>(null)
  const stopped = useRef(false)

  const stop = useCallback(() => {
    stopped.current = true
  }, [])

  const hunt = useCallback(async () => {
    setHunting(true)
    setResult(null)
    stopped.current = false

    let passes = 0
    let fetched = 0
    let proposed = 0

    try {
      while (!stopped.current && passes < MAX_PASSES) {
        const response = await fetch('/api/receipt-hunt/run', { method: 'POST' })
        if (!response.ok) {
          setResult({ searched: 0, fetched, proposed, remaining: 0, failed: true })
          return
        }

        const body = (await response.json()) as { data: HuntResult }
        passes++
        fetched += body.data.fetched
        proposed += body.data.proposed
        setProgress({ passes, fetched, proposed })
        // Let the caller refresh whatever the pass just changed, so a long run
        // fills the list as it goes instead of all at once at the end.
        onPass?.()

        // Nothing new this pass: the mailboxes have no more for what is open.
        //
        // Unless a mailbox refused to be read, in which case zero fetched says
        // nothing about what is in there. Stopping on it, and reporting it as
        // "hittade inget", would tell the user their receipts do not exist
        // because Gmail was busy. Treat it as a failure and let them retry.
        if ((body.data.searchFailures ?? 0) > 0) {
          setResult({ ...body.data, fetched, proposed, failed: true })
          return
        }
        if (body.data.fetched === 0) {
          setResult({ ...body.data, fetched, proposed })
          return
        }
      }

      setResult({ searched: 0, fetched, proposed, remaining: 0 })
    } catch {
      setResult({ searched: 0, fetched, proposed, remaining: 0, failed: true })
    } finally {
      setHunting(false)
      setProgress(null)
    }
  }, [onPass])

  return { hunt, stop, hunting, progress, result, setResult }
}
