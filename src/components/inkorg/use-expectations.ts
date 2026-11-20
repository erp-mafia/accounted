'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { Expectation, ExpectationsResponse, PurchaseOnTheWay } from '@/lib/inkorg/expectations'

const EXPECTATIONS_URL = '/api/inkorg/expectations'

export interface InkorgExpectations {
  /** Väntas senare, soonest first; null until read, and when the read failed (the fold is left out then). */
  expectations: Expectation[] | null
  /** The purchases whose document is on its way, by transaction id; empty until read. */
  onTheWay: ReadonlyMap<string, PurchaseOnTheWay>
}

async function readExpectations(): Promise<ExpectationsResponse | null> {
  try {
    const res = await fetch(EXPECTATIONS_URL)
    if (!res.ok) return null
    const json = (await res.json()) as { data?: ExpectationsResponse }
    return json.data ?? null
  } catch {
    return null
  }
}

/**
 * What the company's regular suppliers will send (GET /api/inkorg/expectations),
 * read once the purchases are in, and again when a purchase the last read did
 * not know turns up (a bank sync, another tab): only a new purchase can be on
 * its way, and one that got its underlag simply leaves the list. A failed read
 * leaves every purchase under Behöver dig and the fold out. A new `revision`
 * reads them again whatever the purchases are: a portal the company added
 * changes which suppliers have one.
 */
export function useExpectations(enabled: boolean, purchaseIds: readonly string[], revision = 0): InkorgExpectations {
  const [data, setData] = useState<ExpectationsResponse | null>(null)
  const known = useRef<Set<string> | null>(null)
  const readAt = useRef(revision)
  const inFlight = useRef(false)
  // Bumped when a read lands, so a purchase that turned up while it ran is looked at too.
  const [landed, setLanded] = useState(0)

  useEffect(() => {
    if (!enabled || inFlight.current) return
    const seen = known.current
    if (seen && readAt.current === revision && purchaseIds.every((id) => seen.has(id))) return
    inFlight.current = true
    const asked = new Set(purchaseIds)
    const askedAt = revision
    void readExpectations().then((next) => {
      inFlight.current = false
      known.current = asked
      readAt.current = askedAt
      // A failed re-read keeps what is on screen.
      if (next) setData(next)
      setLanded((n) => n + 1)
    })
  }, [enabled, purchaseIds, landed, revision])

  const onTheWay = useMemo(
    () => new Map((data?.on_the_way ?? []).map((p) => [p.transaction_id, p] as const)),
    [data],
  )
  return { expectations: data?.expectations ?? null, onTheWay }
}
