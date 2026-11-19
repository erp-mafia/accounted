'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  duplicateLookupQuery,
  type DuplicateLookupFields,
  type SupplierInvoiceDuplicateLookup,
} from '@/lib/supplier-invoices/duplicate-lookup'

const DEBOUNCE_MS = 400
/** The submit waits for the answer: never longer than this. */
const LOOKUP_TIMEOUT_MS = 5000

/** Advisory only: a lookup that fails answers nothing, and the create route's 409 still holds the number. */
async function fetchLookup(query: string): Promise<SupplierInvoiceDuplicateLookup | null> {
  try {
    const res = await fetch(`/api/supplier-invoices/exists?${query}`, { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) })
    if (!res.ok) return null
    const data = (await res.json())?.data
    return { number: (data?.exists && data.existing) || null, reference: data?.reference ?? null }
  } catch {
    // Offline, aborted at the timeout or a body that did not parse: the
    // warning is advisory, so registering goes on without it and the create
    // route's 409 still refuses a number that is taken.
    return null
  }
}

/**
 * The supplier-invoice editor's early duplicate warnings: the invoice that
 * already holds the number, and the payment reference on other invoices of
 * the supplier (lib/supplier-invoices/duplicate-lookup.ts).
 *
 * `found` follows the fields, debounced, whoever fills them: typing and the
 * reading's prefill both go through the form values this is called with. It
 * is null until the answer to the fields as they are now is in, so an answer
 * to a number the person has typed past never shows.
 *
 * `check` answers for the submitted values without the debounce, sharing the
 * request with it: the submit asks it, so registering never runs ahead of a
 * lookup still on its way.
 */
export function useSupplierInvoiceDuplicates(fields: DuplicateLookupFields) {
  const query = duplicateLookupQuery(fields)
  const [answer, setAnswer] = useState<{ query: string; found: SupplierInvoiceDuplicateLookup } | null>(null)
  const latestQuery = useRef(query)
  const asked = useRef<{ query: string; found: Promise<SupplierInvoiceDuplicateLookup | null> } | null>(null)

  const lookUp = useCallback(async (wanted: string | null) => {
    if (!wanted) return null
    if (asked.current?.query !== wanted) asked.current = { query: wanted, found: fetchLookup(wanted) }
    const request = asked.current
    const found = await request.found
    if (!found) {
      // Asked again next time.
      if (asked.current === request) asked.current = null
    } else if (latestQuery.current === wanted) {
      setAnswer({ query: wanted, found })
    }
    return found
  }, [])

  useEffect(() => {
    latestQuery.current = query
    if (!query) return
    const timer = setTimeout(() => void lookUp(query), DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query, lookUp])

  const check = useCallback((forFields: DuplicateLookupFields) => lookUp(duplicateLookupQuery(forFields)), [lookUp])

  return { found: answer?.query === query ? answer.found : null, check }
}
