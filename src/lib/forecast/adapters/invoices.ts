/**
 * Open customer and supplier invoices, read from the reskontra reports the
 * ledger pages show (generateARLedger, generateSupplierLedger), so the
 * forecast and the reskontra never disagree on what is open.
 *
 * Customer invoices count on their due date (v1: no payment-delay model).
 * A supplier invoice counts on its due date for the part no payment order
 * covers: an invoice inside a payment order counts at the order's date
 * (./payment-orders.ts), never twice. Past their due date, both are listed
 * apart instead of being projected on a day nobody knows.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { daysBetweenIso } from '@/lib/dates/iso'
import { roundOre } from '@/lib/money'
import { generateARLedger, type ARLedgerReport } from '@/lib/reports/ar-ledger'
import { generateSupplierLedger, type SupplierLedgerReport } from '@/lib/reports/supplier-ledger'
import type { CashFlow, ForecastCaveat, ForecastWindow, OverduePayable, OverdueReceivable } from '../types'

export interface ReceivablesResult {
  flows: CashFlow[]
  overdue: OverdueReceivable[]
  caveats: ForecastCaveat[]
}

export function receivableFlows(report: ARLedgerReport, window: ForecastWindow): ReceivablesResult {
  const flows: CashFlow[] = []
  const overdue: OverdueReceivable[] = []
  let unconverted = 0
  for (const entry of report.entries) {
    for (const inv of entry.invoices) {
      if (inv.outstanding_sek === null) {
        unconverted += 1
        continue
      }
      const amount = roundOre(inv.outstanding_sek)
      // A credit note owed back to a customer is settled against another invoice or refunded: not projected.
      if (amount <= 0) continue
      if (inv.due_date < window.today) {
        overdue.push({
          invoice_id: inv.invoice_id,
          invoice_number: inv.invoice_number,
          customer_name: entry.customer_name,
          due_date: inv.due_date,
          days_overdue: daysBetweenIso(inv.due_date, window.today),
          amount,
        })
        continue
      }
      if (inv.due_date > window.end) continue
      flows.push({
        date: inv.due_date,
        direction: 'in',
        amount,
        kind: 'known',
        source: 'customer_invoice',
        estimate: false,
        counterparty: entry.customer_name,
        reference: inv.invoice_number,
        ref: { type: 'invoice', id: inv.invoice_id },
        confidence: null,
      })
    }
  }
  const caveats: ForecastCaveat[] = []
  if (unconverted > 0) {
    caveats.push({
      code: 'RECEIVABLES_WITHOUT_RATE',
      message_sv: `${unconverted} kundfaktura i utländsk valuta saknar kurs och ingår inte i prognosen.`,
      message_en: `${unconverted} foreign-currency customer invoice(s) have no exchange rate and are not in the forecast.`,
    })
  }
  return { flows, overdue: overdue.sort((a, b) => a.due_date.localeCompare(b.due_date)), caveats }
}

export interface PayablesResult {
  flows: CashFlow[]
  overdue: OverduePayable[]
  caveats: ForecastCaveat[]
}

/**
 * `covered`: per supplier invoice, what payment orders already pay (their own
 * flows carry it). Only the rest is projected, on the due date.
 */
export function payableFlows(
  report: SupplierLedgerReport,
  covered: ReadonlyMap<string, number>,
  window: ForecastWindow,
): PayablesResult {
  const flows: CashFlow[] = []
  const overdue: OverduePayable[] = []
  for (const entry of report.entries) {
    for (const inv of entry.invoices ?? []) {
      const amount = roundOre(inv.outstanding_sek - (covered.get(inv.supplier_invoice_id) ?? 0))
      if (amount <= 0) continue
      if (inv.due_date < window.today) {
        overdue.push({
          supplier_invoice_id: inv.supplier_invoice_id,
          supplier_invoice_number: inv.supplier_invoice_number,
          supplier_name: entry.supplier_name,
          due_date: inv.due_date,
          days_overdue: daysBetweenIso(inv.due_date, window.today),
          amount,
        })
        continue
      }
      if (inv.due_date > window.end) continue
      flows.push({
        date: inv.due_date,
        direction: 'out',
        amount,
        kind: 'known',
        source: 'supplier_invoice',
        estimate: false,
        counterparty: entry.supplier_name,
        reference: inv.supplier_invoice_number,
        ref: { type: 'supplier_invoice', id: inv.supplier_invoice_id },
        confidence: null,
      })
    }
  }
  const caveats: ForecastCaveat[] = []
  if (report.unconverted_fx_count > 0) {
    caveats.push({
      code: 'PAYABLES_WITHOUT_RATE',
      message_sv: `${report.unconverted_fx_count} leverantörsfaktura i utländsk valuta saknar kurs och ingår inte i prognosen.`,
      message_en: `${report.unconverted_fx_count} foreign-currency supplier invoice(s) have no exchange rate and are not in the forecast.`,
    })
  }
  return { flows, overdue: overdue.sort((a, b) => a.due_date.localeCompare(b.due_date)), caveats }
}

export function loadReceivablesReport(supabase: SupabaseClient, companyId: string): Promise<ARLedgerReport> {
  return generateARLedger(supabase, companyId, undefined, { strict: true })
}

export function loadPayablesReport(supabase: SupabaseClient, companyId: string): Promise<SupplierLedgerReport> {
  return generateSupplierLedger(supabase, companyId, undefined, { strict: true, includeInvoices: true })
}
