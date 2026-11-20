'use client'

import { useEffect, useState } from 'react'

/**
 * How long one of the bank's QR codes lives. Swedbank closed a step 33 s
 * after it started it; the countdown is a nudge, the bank's answer decides.
 */
export const QR_LIFETIME_S = 30

/**
 * Seconds left on the QR the bank is showing, counted from the moment the
 * bank's step changed (`stepKey`: the step name, or any value that changes
 * when a new QR arrives). Null while nothing counts. Ticks once a second
 * only while `active`.
 */
export function useQrCountdown(stepKey: string | null, active: boolean): number | null {
  const [since, setSince] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())

  // A new step from the bank: note when it began.
  useEffect(() => {
    if (!stepKey || !active) {
      const reset = setTimeout(() => setSince(null), 0)
      return () => clearTimeout(reset)
    }
    const started = Date.now()
    // Deferred so the effect body itself sets no state (react-hooks/set-state-in-effect).
    const mark = setTimeout(() => {
      setSince(started)
      setNow(Date.now())
    }, 0)
    return () => clearTimeout(mark)
  }, [stepKey, active])

  const counting = active && since !== null
  useEffect(() => {
    if (!counting) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [counting])

  if (since === null || !active) return null
  return Math.max(0, QR_LIFETIME_S - Math.floor((now - since) / 1000))
}
