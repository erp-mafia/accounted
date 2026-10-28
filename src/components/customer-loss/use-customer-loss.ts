'use client'

import { useCallback, useEffect, useState } from 'react'
import type { CustomerLossView } from '@/lib/customer-loss/view'
import { postDocumentForm } from '@/lib/documents/direct-upload'

/** GET the invoice's kundförlust view; null when it cannot be read (supplementary on the page). */
async function fetchCustomerLossView(invoiceId: string): Promise<CustomerLossView | null> {
  try {
    const res = await fetch(`/api/invoices/${encodeURIComponent(invoiceId)}/customer-loss`, { cache: 'no-store' })
    if (!res.ok) return null
    return ((await res.json()) as { data: CustomerLossView }).data
  } catch {
    return null
  }
}

/**
 * The invoice's kundförlust view, loaded when `enabled` (an issued customer
 * invoice of our own). `refresh` re-reads it after a decision or a payment.
 */
export function useCustomerLoss(invoiceId: string, enabled: boolean) {
  const [view, setView] = useState<CustomerLossView | null>(null)
  const refresh = useCallback(async () => {
    if (!enabled) return
    setView(await fetchCustomerLossView(invoiceId))
  }, [invoiceId, enabled])
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    void fetchCustomerLossView(invoiceId).then((next) => {
      if (!cancelled) setView(next)
    })
    return () => {
      cancelled = true
    }
  }, [enabled, invoiceId])
  return { view, refresh }
}

export interface CustomerLossPostBody {
  kind: 'doubtful' | 'confirmed' | 'recovered'
  reason: string
  entry_date?: string
  evidence_document_id?: string | null
  amount?: number
  payment_account?: string
}

/** POST a decision; answers the API's Swedish message on a refusal. */
export async function postCustomerLoss(
  invoiceId: string,
  body: CustomerLossPostBody,
): Promise<{ ok: true } | { ok: false; message: string | null }> {
  try {
    const res = await fetch(`/api/invoices/${encodeURIComponent(invoiceId)}/customer-loss`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (res.ok) return { ok: true }
    const json = (await res.json().catch(() => null)) as { error?: { message?: string } } | null
    return { ok: false, message: json?.error?.message ?? null }
  } catch {
    return { ok: false, message: null }
  }
}

/** Upload the evidence document; answers its id. */
export async function uploadEvidence(file: File): Promise<string | null> {
  const formData = new FormData()
  formData.append('upload_source', 'file_upload')
  try {
    const res = await postDocumentForm('/api/documents', formData, file)
    const json = (await res.json().catch(() => null)) as { data?: { id?: string } } | null
    return res.ok && json?.data?.id ? json.data.id : null
  } catch {
    return null
  }
}
