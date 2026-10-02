'use client'

/**
 * Running the receipt hunt from a button.
 *
 * Two surfaces press it: the Gmail door in Underlag, where a person notices
 * that receipts are missing, and Kopplingar > Gmail, right after connecting.
 * Both call this, so there is one definition of what a run does and when it
 * stops (receipt-hunt-run.ts).
 *
 * Stopping takes effect after the pass in flight: the server keeps working on
 * a pass once it has started, so aborting the request would only hide what it
 * still files. Leaving the page stops further passes the same way, so a run
 * never keeps going on a page nobody can see.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { notifySessionExpired } from '@/lib/auth/session-timeout-shared'
import { runReceiptHunt, type HuntOutcome, type HuntProgress } from './receipt-hunt-run'

export type { HuntOutcome, HuntProgress } from './receipt-hunt-run'

export interface ReceiptHunt {
  hunt: () => Promise<void>
  stop: () => void
  hunting: boolean
  /** Stop was pressed; the pass in flight is still finishing. */
  stopping: boolean
  /** Null until the first pass of a run has landed. */
  progress: HuntProgress | null
  result: HuntOutcome | null
}

export function useReceiptHunt(onPass?: () => void): ReceiptHunt {
  const [hunting, setHunting] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [progress, setProgress] = useState<HuntProgress | null>(null)
  const [result, setResult] = useState<HuntOutcome | null>(null)
  const stopped = useRef(false)
  const running = useRef(false)
  // The caller's refresh changes identity every render; reading it through a
  // ref keeps `hunt` stable without running a stale one.
  const onPassRef = useRef(onPass)
  useEffect(() => {
    onPassRef.current = onPass
  })

  useEffect(
    () => () => {
      stopped.current = true
    },
    [],
  )

  const stop = useCallback(() => {
    if (!running.current) return
    stopped.current = true
    setStopping(true)
  }, [])

  const hunt = useCallback(async () => {
    if (running.current) return
    running.current = true
    stopped.current = false
    setHunting(true)
    setStopping(false)
    setProgress(null)
    setResult(null)
    try {
      const outcome = await runReceiptHunt({
        request: async () => {
          const response = await fetch('/api/receipt-hunt/run', { method: 'POST' })
          notifySessionExpired(response)
          return response
        },
        shouldStop: () => stopped.current,
        onPass: (next) => {
          setProgress(next)
          // Refresh whatever the pass changed, so a long run fills the list
          // as it goes instead of all at once at the end.
          onPassRef.current?.()
        },
      })
      setResult(outcome)
    } finally {
      running.current = false
      setHunting(false)
      setStopping(false)
      setProgress(null)
    }
  }, [])

  return { hunt, stop, hunting, stopping, progress, result }
}
