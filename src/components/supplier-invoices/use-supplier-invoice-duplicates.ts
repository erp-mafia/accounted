'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { duplicateLookupQuery, type DuplicateLookupFields } from '@/lib/supplier-invoices/duplicate-lookup-query'
import type { SupplierInvoiceDuplicateLookup } from '@/lib/supplier-invoices/duplicate-lookup'

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
 * is null until the answer to the supplier, number and reference as they are
 * now is in, so an answer to a number the person has typed past never shows.
 * A changed date or amount only decides whether an invoice is the same
 * document again: the answer before it names the same invoices and stays
 * until the new one is in, so typing an amount does not blink the lines away.
 *
 * `check` answers for the submitted values without the debounce, sharing the
 * request with it: the submit asks it, so registering never runs ahead of a
 * lookup still on its way.
 */
export function useSupplierInvoiceDuplicates(fields: DuplicateLookupFields) {
  const query = duplicateLookupQuery(fields)
  const subject = subjectOf(fields)
  const [answer, setAnswer] = useState<{ subject: string; found: SupplierInvoiceDuplicateLookup } | null>(null)
  const latestQuery = useRef(query)
  const asked = useRef<{ query: string; found: Promise<SupplierInvoiceDuplicateLookup | null> } | null>(null)

  const lookUp = useCallback(async (wanted: string | null, wantedSubject: string | null) => {
    if (!wanted || !wantedSubject) return null
    if (asked.current?.query !== wanted) asked.current = { query: wanted, found: fetchLookup(wanted) }
    const request = asked.current
    const found = await request.found
    if (!found) {
      // Asked again next time. An answer kept for another date or amount
      // does not stand for these: no warning, as for any failed lookup.
      if (asked.current === request) asked.current = null
      if (latestQuery.current === wanted) setAnswer(null)
    } else if (latestQuery.current === wanted) {
      setAnswer({ subject: wantedSubject, found })
    }
    return found
  }, [])

  useEffect(() => {
    latestQuery.current = query
    if (!query) return
    const timer = setTimeout(() => void lookUp(query, subject), DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query, subject, lookUp])

  const check = useCallback(
    (forFields: DuplicateLookupFields) => lookUp(duplicateLookupQuery(forFields), subjectOf(forFields)),
    [lookUp],
  )

  return { found: answer && answer.subject === subject ? answer.found : null, check }
}

/** Which invoices an answer names: the query without the date and the amount. */
function subjectOf(fields: DuplicateLookupFields): string | null {
  return duplicateLookupQuery({ ...fields, total: null })
}
