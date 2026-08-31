import type { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { privateNoStore } from '@/lib/api/private-no-store'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import {
  generatePeppolBisBillingInvoice,
  type PeppolInvoiceResult,
} from '@/lib/invoices/peppol-bis-billing'
import type { CompanySettings, Customer, Invoice, InvoiceItem } from '@/types'

export type GeneratedPeppolInvoice = Extract<PeppolInvoiceResult, { ok: true }>

export type PeppolInvoiceRecord = Invoice & { customer?: Customer | null; items?: InvoiceItem[] | null }

type RouteLog = Parameters<typeof errorResponseFromCode>[1]

export type LoadPeppolRecordsResult =
  | { ok: true; invoice: PeppolInvoiceRecord; company: CompanySettings }
  | { ok: false; response: NextResponse }

export type LoadPeppolDocumentResult =
  | { ok: true; document: GeneratedPeppolInvoice; invoice: PeppolInvoiceRecord; company: CompanySettings }
  | { ok: false; response: NextResponse }

/**
 * Fetch the invoice (with customer and lines) and the company settings the
 * Peppol generator needs, with the same explicit `company_id` isolation as the
 * other invoice routes. Shared by the export, stage and send routes.
 */
export async function loadPeppolRecords(args: {
  supabase: SupabaseClient
  companyId: string
  invoiceId: string
  log: RouteLog
  requestId: string
}): Promise<LoadPeppolRecordsResult> {
  const { data: invoice, error: invoiceError } = await args.supabase
    .from('invoices')
    .select(`
      *,
      customer:customers(*),
      items:invoice_items(*)
    `)
    .eq('id', args.invoiceId)
    .eq('company_id', args.companyId)
    .single()

  if (invoiceError || !invoice) {
    return {
      ok: false,
      response: privateNoStore(errorResponseFromCode(
        'INVOICE_NOT_FOUND',
        args.log,
        { requestId: args.requestId },
      )),
    }
  }

  const { data: company, error: companyError } = await args.supabase
    .from('company_settings')
    .select('*')
    .eq('company_id', args.companyId)
    .single()

  if (companyError || !company) {
    return {
      ok: false,
      response: privateNoStore(errorResponseFromCode(
        'INVOICE_SEND_COMPANY_SETTINGS_MISSING',
        args.log,
        { requestId: args.requestId },
      )),
    }
  }

  return {
    ok: true,
    invoice: invoice as PeppolInvoiceRecord,
    company: company as CompanySettings,
  }
}

/**
 * Run the BIS Billing 3 generator on already-loaded records and turn a failed
 * preflight into the structured, field-addressable VALIDATION_ERROR envelope.
 */
export function generatePeppolDocumentOrResponse(args: {
  invoice: PeppolInvoiceRecord
  company: CompanySettings
  log: RouteLog
  requestId: string
}): { ok: true; document: GeneratedPeppolInvoice } | { ok: false; response: NextResponse } {
  if (!args.invoice.customer) {
    return {
      ok: false,
      response: privateNoStore(errorResponseFromCode('VALIDATION_ERROR', args.log, {
        requestId: args.requestId,
        messageSv: 'Fakturan saknar en kund som kan användas för Peppol-export.',
        messageEn: 'The invoice has no customer available for Peppol export.',
        details: { field: 'invoice.customer' },
      })),
    }
  }

  const document = generatePeppolBisBillingInvoice({
    invoice: args.invoice,
    customer: args.invoice.customer,
    items: args.invoice.items ?? [],
    company: args.company,
  })
  if (!document.ok) {
    const first = document.issues[0]
    return {
      ok: false,
      response: privateNoStore(errorResponseFromCode('VALIDATION_ERROR', args.log, {
        requestId: args.requestId,
        messageSv: first?.messageSv,
        messageEn: first?.messageEn,
        details: {
          issues: document.issues.map((item) => ({
            code: item.code,
            field: item.field,
            message_sv: item.messageSv,
            message_en: item.messageEn,
          })),
        },
      })),
    }
  }

  return { ok: true, document }
}

export async function loadPeppolDocument(args: {
  supabase: SupabaseClient
  companyId: string
  invoiceId: string
  log: RouteLog
  requestId: string
}): Promise<LoadPeppolDocumentResult> {
  const records = await loadPeppolRecords(args)
  if (!records.ok) return records
  const generated = generatePeppolDocumentOrResponse({
    invoice: records.invoice,
    company: records.company,
    log: args.log,
    requestId: args.requestId,
  })
  if (!generated.ok) return generated
  return { ok: true, document: generated.document, invoice: records.invoice, company: records.company }
}
