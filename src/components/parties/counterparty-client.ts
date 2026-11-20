'use client'

import type { CounterpartyBalance } from '@/lib/invoices/counterparty-setoff/open-items'

/** The counterparty's open items as the dossier reads them, with whether Kvitta is switched on. */
export type CounterpartyOpenItems = CounterpartyBalance & { setoff_enabled: boolean }

/** GET the party's open items; null when it has none to show (no party, or a failed read). */
export async function fetchCounterpartyOpenItems(partyId: string): Promise<CounterpartyOpenItems | null> {
  try {
    const res = await fetch(`/api/parties/${encodeURIComponent(partyId)}/open-items`, { cache: 'no-store' })
    if (!res.ok) return null
    return ((await res.json()) as { data: CounterpartyOpenItems }).data
  } catch {
    return null
  }
}

export interface SetoffRequest {
  invoice_id: string
  supplier_invoice_id: string
  amount?: number
  setoff_date?: string
  note?: string
}

/** What the dry run answers: lib/invoices/counterparty-setoff/book.ts setoffPreview. */
export interface SetoffPreview {
  amount: number
  setoff_date: string
  invoice: { number: string | null; remaining_after: number; status_after: 'paid' | 'partially_paid' }
  supplier_invoice: {
    number: string | null
    arrival_number: number | null
    remaining_after: number
    status_after: 'paid' | 'partially_paid'
  }
  net: { direction: 'we_pay' | 'they_pay' | 'settled'; amount: number }
  lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }>
}

export type SetoffAnswer<T> = { ok: true; data: T } | { ok: false; message: string | null }

/** POST a set-off (or its dry run); answers the API's Swedish message on a refusal. */
export async function postSetoff<T>(partyId: string, body: SetoffRequest & { dry_run?: boolean }): Promise<SetoffAnswer<T>> {
  try {
    const res = await fetch(`/api/parties/${encodeURIComponent(partyId)}/setoffs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = (await res.json().catch(() => null)) as { data?: T; error?: { message?: string } } | null
    if (res.ok && json?.data) return { ok: true, data: json.data }
    return { ok: false, message: json?.error?.message ?? null }
  } catch {
    return { ok: false, message: null }
  }
}
