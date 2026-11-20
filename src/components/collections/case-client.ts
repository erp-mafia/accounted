'use client'

import { useCallback, useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import type { CollectionCaseView } from '@/lib/collections/case'
import type { CaseActionBody } from '@/lib/collections/case-card'
import type { OpenCaseBody } from '@/lib/collections/handover-dialog'
import type { CaseEscalationCheckView, CollectionReadinessView } from '@/lib/collections/invoice-collection'
import type { CollectionsStartState } from '@/lib/collections/flags'
import type { WithdrawFeeInfo } from '@/lib/collections/stages'
import { reloadUntilReported } from '@/lib/collections/case-reload'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { capitalizeFirst, providerWords, type Locale } from './collections-client'

/**
 * Browser side of an invoice's collection case: what GET
 * /api/invoices/[id]/collection answers, the provider's name in a sentence,
 * and the two writes (hand over, act on the case).
 */

export interface InvoiceCollectionAvailability {
  start: CollectionsStartState
  enabled: boolean
  capability: boolean
  sandbox: boolean
  obligations: boolean
  displayName: string | null
  /** The provider's square mark (lib/collections/provider-mark.ts); null shows the initials chip. */
  markUrl: string | null
  portalUrl: string | null
  feeSummarySv: string | null
  withdrawFreeDays: number | null
  connection: {
    state: string
    ladderMode: 'off' | 'staged' | null
    ladderDaysAfterDue: number | null
    /** The company's configured first step (the overdue banner's button label). */
    defaultStartStep: 'reminder' | 'collection' | null
  } | null
}

export interface InvoiceCollectionData {
  availability: InvoiceCollectionAvailability
  case: CollectionCaseView | null
  /** An open case: whether withdrawing it may cost a fee now. */
  withdrawFee: WithdrawFeeInfo | null
  readiness: CollectionReadinessView | null
  escalation: CaseEscalationCheckView | null
}

/** t() for the collections namespace with the provider's words filled in. */
export function useCaseWords(name: string | null | undefined) {
  const t = useTranslations('collections')
  const locale = (useLocale() === 'en' ? 'en' : 'sv') as Locale
  const words = providerWords(name, locale)
  const tp = useCallback(
    (key: string, values: Record<string, string | number> = {}) => capitalizeFirst(t(key, { ...words, ...values })),
    [t, words],
  )
  return { t, tp, locale, words }
}

/** GET the invoice's collection data; null when it cannot be read (collections is supplementary on the page). */
async function fetchInvoiceCollection(invoiceId: string): Promise<InvoiceCollectionData | null> {
  try {
    const res = await fetch(`/api/invoices/${encodeURIComponent(invoiceId)}/collection`, { cache: 'no-store' })
    if (!res.ok) return null
    return ((await res.json()) as { data: InvoiceCollectionData }).data
  } catch {
    return null
  }
}

/**
 * The invoice's collection data, loaded when `enabled` (a customer invoice
 * of our own). Opening the page refreshes an open case from the provider
 * (the route throttles it to once a minute).
 */
export function useInvoiceCollection(invoiceId: string, enabled: boolean) {
  const [data, setData] = useState<InvoiceCollectionData | null>(null)
  const reload = useCallback(async () => {
    if (!enabled) return
    const next = await fetchInvoiceCollection(invoiceId)
    if (next) setData(next)
  }, [enabled, invoiceId])
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    void fetchInvoiceCollection(invoiceId).then((next) => {
      if (!cancelled && next) setData(next)
    })
    return () => {
      cancelled = true
    }
  }, [enabled, invoiceId])
  // A write answers with the case only: read the rest again (the withdraw fee window, the chips).
  const setCase = useCallback(
    (next: CollectionCaseView) => {
      setData((current) => (current ? { ...current, case: next } : current))
      void reload()
    },
    [reload],
  )
  // A payment or credit note was booked: read again until its report to the
  // provider has gone out, so the card's amounts follow without a page reload.
  const reloadAfterPayment = useCallback(async () => {
    if (!enabled) return
    await reloadUntilReported(() => fetchInvoiceCollection(invoiceId), setData)
  }, [enabled, invoiceId])
  return { data, reload, setCase, reloadAfterPayment }
}

/** GET with ?readiness=1: the checks a dialog shows when it opens. Throws when it cannot be read. */
async function fetchDialogChecks(invoiceId: string): Promise<InvoiceCollectionData> {
  const res = await fetch(`/api/invoices/${encodeURIComponent(invoiceId)}/collection?readiness=1`, { cache: 'no-store' })
  if (!res.ok) throw new Error(String(res.status))
  return ((await res.json()) as { data: InvoiceCollectionData }).data
}

/** The handover dialog's readiness: the checklist, the claim and the bank check. */
export async function fetchCollectionReadiness(invoiceId: string): Promise<CollectionReadinessView | null> {
  return (await fetchDialogChecks(invoiceId)).readiness
}

/**
 * The click-time check before an escalation of an open case (approve the
 * next step, "it is not paid"): null when it could not be read, the commit
 * checks anyway.
 */
export async function fetchCaseEscalation(invoiceId: string): Promise<CaseEscalationCheckView | null> {
  try {
    return (await fetchDialogChecks(invoiceId)).escalation
  } catch {
    return null
  }
}

export type CaseWriteResult<T> = { ok: true; data: T } | { ok: false; message: string; code: string | null }

async function post<T>(path: string, body: unknown, locale: Locale): Promise<CaseWriteResult<T>> {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
    if (res.ok) return { ok: true, data: (json?.data ?? null) as T }
    const error = json?.error as { code?: string } | string | undefined
    return {
      ok: false,
      message: getErrorMessage(json, { statusCode: res.status, locale }),
      code: typeof error === 'object' && error?.code ? error.code : null,
    }
  } catch (error) {
    return { ok: false, message: getErrorMessage(error, { locale }), code: null }
  }
}

export function postOpenCase(invoiceId: string, body: OpenCaseBody, locale: Locale) {
  return post<{ case: CollectionCaseView; registered: boolean }>(
    `/api/invoices/${encodeURIComponent(invoiceId)}/collection`,
    body,
    locale,
  )
}

export function postCaseAction(invoiceId: string, body: CaseActionBody, locale: Locale) {
  return post<{ case: CollectionCaseView }>(`/api/invoices/${encodeURIComponent(invoiceId)}/collection/actions`, body, locale)
}

/** A bank row the sweep found pays something else, not this invoice. */
export function postPossiblePaymentDismiss(invoiceId: string, hitId: string, locale: Locale) {
  return post<{ case: CollectionCaseView }>(
    `/api/invoices/${encodeURIComponent(invoiceId)}/collection/possible-payments`,
    { hit_id: hitId, action: 'dismiss' },
    locale,
  )
}

/** Try a failed payment report again, or mark a failed or partly ignored one as handled. */
export function postForwardAction(invoiceId: string, forwardId: string, action: 'retry' | 'resolve', locale: Locale) {
  return post<{ case: CollectionCaseView }>(
    `/api/invoices/${encodeURIComponent(invoiceId)}/collection/forwards`,
    { forward_id: forwardId, action },
    locale,
  )
}
