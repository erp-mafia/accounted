'use client'

import { useEffect, useState } from 'react'
import { fetchOpenPaymentsBankDetails, type OpenPaymentsBankDetails } from './open-payments-client'

// One read per bank per page load: the person may pick, go back and pick
// again, and the server answers from its own 24 h cache anyway.
const cache = new Map<string, Promise<OpenPaymentsBankDetails | null>>()

function load(bic: string): Promise<OpenPaymentsBankDetails | null> {
  const existing = cache.get(bic)
  if (existing) return existing
  const promise = fetchOpenPaymentsBankDetails(bic).catch((): null => {
    // Without the details the flow goes on with what the list said; the next pick asks again.
    cache.delete(bic)
    return null
  })
  cache.set(bic, promise)
  return promise
}

/**
 * The details of the bank the person picked (how it signs, its sparbanker),
 * or null while they load or when they could not be read.
 */
export function useOpenPaymentsBankDetails(bic: string | null): OpenPaymentsBankDetails | null {
  const [state, setState] = useState<{ bic: string; details: OpenPaymentsBankDetails | null } | null>(null)
  useEffect(() => {
    if (!bic) return
    let cancelled = false
    load(bic).then((details) => {
      if (!cancelled) setState({ bic, details })
    })
    return () => {
      cancelled = true
    }
  }, [bic])
  return bic && state?.bic === bic ? state.details : null
}
