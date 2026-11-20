/**
 * Browser calls for changed supplier bank details (lib/payments/payee-alerts.ts):
 * the invoice's view, a person's decision, and the list markers.
 */
import type { InvoicePayeeView } from '@/lib/payments/payee-alerts'
import { PaymentsClientError } from './payments-client'

export type { InvoicePayeeView }

export interface PayeeAlertMarker {
  supplier_invoice_id: string
  alert: 'changed' | 'new_supplier_account'
  hold: 'payee_unconfirmed' | 'payee_rejected' | null
}

async function send<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    ...init,
    headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...(init?.headers ?? {}) },
  })
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  if (!res.ok) throw new PaymentsClientError(body, res.status)
  return (body as { data: T }).data
}

export function fetchInvoicePayee(supplierInvoiceId: string): Promise<InvoicePayeeView> {
  return send<InvoicePayeeView>(`/api/supplier-invoices/${supplierInvoiceId}/payee`)
}

export function decideInvoicePayee(
  supplierInvoiceId: string,
  input: { decision: 'confirmed' | 'rejected'; updateSupplierCard?: boolean; note?: string },
): Promise<{ decision: 'confirmed' | 'rejected'; supplier_card_updated: boolean }> {
  return send(`/api/supplier-invoices/${supplierInvoiceId}/payee`, {
    method: 'POST',
    body: JSON.stringify({
      decision: input.decision,
      ...(input.updateSupplierCard !== undefined ? { update_supplier_card: input.updateSupplierCard } : {}),
      ...(input.note?.trim() ? { note: input.note.trim() } : {}),
    }),
  })
}

/** Invoices whose payment the stated bank details hold back, by invoice id. */
export async function fetchPayeeAlertMarkers(): Promise<Map<string, PayeeAlertMarker>> {
  const rows = await send<PayeeAlertMarker[]>('/api/supplier-invoices/payee-alerts')
  return new Map(rows.filter((row) => row.hold !== null).map((row) => [row.supplier_invoice_id, row]))
}
