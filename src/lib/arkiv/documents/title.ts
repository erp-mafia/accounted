import type { Payload } from '@/lib/documents/extract/fields'
import { ISO_DATE_RE } from '@/lib/invariants'

/**
 * What a document is called and when it is from, read off its record. A
 * photo is "IMG_7485.jpg" to the file system and "Faktura Rollup-Kungen
 * 215066768" to a person; the archive shows the second and keeps the first.
 * Titles are Swedish like agreement titles and deadlines: they are the
 * company's own words for its documents, not interface chrome.
 */
const settled = (payload: Payload, ...names: string[]): string | null => {
  for (const name of names) {
    const v = payload[name]?.normalized ?? payload[name]?.value
    if (v != null && String(v).trim()) return String(v).trim()
  }
  return null
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

const AGREEMENT_NOUN: Record<string, [noun: string, party: string]> = {
  'agreement.rental': ['Hyresavtal', 'landlord_name'],
  'agreement.lease': ['Leasingavtal', 'lessor_name'],
  'agreement.loan': ['Låneavtal', 'lender_name'],
  'agreement.subscription': ['Abonnemang', 'provider_name'],
  'agreement.insurance': ['Försäkring', 'insurer_name'],
  'agreement.employment': ['Anställningsavtal', 'employee_name'],
  'agreement.shareholder': ['Aktieägaravtal', 'company_name'],
  'agreement.investment': ['Investering', 'investor_name'],
  'agreement.customer': ['Kundavtal', 'customer_name'],
  'agreement.other': ['Avtal', 'counterparty_name'],
}

export function fileStem(fileName: string): string {
  return fileName.replace(/\.[a-z0-9]{2,5}$/i, '')
}

export function documentTitle(input: { docType: string | null; fileName: string; payload: Payload | null; agreementTitle?: string | null }): string {
  const p = input.payload ?? {}
  const fallback = fileStem(input.fileName)
  if (input.agreementTitle) return input.agreementTitle
  switch (input.docType) {
    case 'receipt': {
      const who = settled(p, 'merchant_name')
      return who ? `Kvitto ${who}` : fallback
    }
    case 'supplier_invoice': {
      const who = settled(p, 'supplier_name')
      return who ? ['Faktura', who, settled(p, 'invoice_number')].filter(Boolean).join(' ') : fallback
    }
    case 'credit_note': {
      const who = settled(p, 'supplier_name')
      return who ? `Kreditfaktura ${who}` : fallback
    }
    case 'customer_invoice': {
      const who = settled(p, 'customer_name')
      return who ? ['Kundfaktura', settled(p, 'invoice_number'), who].filter(Boolean).join(' ') : fallback
    }
    case 'bank_statement': {
      const bank = settled(p, 'bank_name')
      const period = settled(p, 'period_end')
      return bank || period ? ['Kontoutdrag', bank, period].filter(Boolean).join(' ') : fallback
    }
    case 'tax_account_statement': {
      const period = settled(p, 'period_end')
      return period ? `Skattekontoutdrag ${period}` : 'Skattekontoutdrag'
    }
    case 'registration.bolagsverket': {
      const who = settled(p, 'company_name')
      return who ? `Registreringsbevis ${who}` : 'Registreringsbevis'
    }
    case 'filing.bolagsverket': {
      const what = settled(p, 'filing_type')
      if (!what) return 'Anmälan till Bolagsverket'
      const short = cap(what.split(/[.;:(]/)[0].trim())
      return /bolagsverket/i.test(short) ? short : `${short} till Bolagsverket`
    }
    case 'decision.skatteverket': {
      const what = settled(p, 'decision_type')
      return what ? `${cap(what)} från Skatteverket` : 'Beslut från Skatteverket'
    }
    case 'minutes.board':
      return ['Styrelseprotokoll', settled(p, 'meeting_date')].filter(Boolean).join(' ')
    case 'minutes.agm':
      return [settled(p, 'meeting_kind') === 'extra' ? 'Extra bolagsstämma' : 'Bolagsstämma', settled(p, 'meeting_date')].filter(Boolean).join(' ')
    case 'share_subscription_list':
      return ['Teckningslista', settled(p, 'decision_date')].filter(Boolean).join(' ')
    case 'annual_report': {
      const end = settled(p, 'fiscal_year_end')
      return end ? `Årsredovisning ${end.slice(0, 4)}` : 'Årsredovisning'
    }
    default: {
      const agreement = input.docType ? AGREEMENT_NOUN[input.docType] : undefined
      if (agreement) {
        const who = settled(p, agreement[1])
        return who ? `${agreement[0]} ${who}` : agreement[0]
      }
      return fallback
    }
  }
}

/** Document types whose amount the Underlag reader reads as the document's amount. */
const MONEY_TYPES = new Set(['receipt', 'supplier_invoice', 'credit_note', 'customer_invoice'])

/**
 * The Underlag reader's fields (extracted_data on the row: the inbox reads
 * every company's receipts and supplier invoices) in the payload shape the
 * title and the date read, so a shelf company's receipt is "Kvitto
 * Systembolaget, 2 388,80 kr" and not "IMG_7483". The counterparty and the
 * date carry over to any type; the amount only to a receipt or an invoice
 * (or a document not typed yet): on minutes or a subscription list the
 * reader's "total" is a prominent figure, not what the document is worth
 * (Arcim, prod 2026-09-23: "Bolagsstämma 20,83 kr").
 */
export function underlagPayload(extracted: Record<string, unknown> | null | undefined, docType: string | null): Payload {
  if (!extracted || typeof extracted !== 'object') return {}
  const money = docType == null || MONEY_TYPES.has(docType)
  const field = (v: string | number): Payload[string] => ({ value: v, normalized: v, page: null, quote: null, confidence: 1 }) as Payload[string]
  const supplier = (extracted.supplier as { name?: string | null } | undefined)?.name ?? null
  const invoice = (extracted.invoice as { invoiceNumber?: string | null; invoiceDate?: string | null; currency?: string | null } | undefined) ?? {}
  const total = (extracted.totals as { total?: number | null } | undefined)?.total ?? null
  const p: Payload = {}
  if (supplier && supplier.trim()) {
    p.merchant_name = field(supplier.trim())
    p.supplier_name = field(supplier.trim())
  }
  if (money && invoice.invoiceNumber) p.invoice_number = field(invoice.invoiceNumber)
  if (invoice.invoiceDate) {
    p.receipt_date = field(invoice.invoiceDate)
    p.invoice_date = field(invoice.invoiceDate)
  }
  if (money && typeof total === 'number') p.total_amount = field(total)
  if (money && invoice.currency) p.currency = field(invoice.currency)
  return p
}

/** The date printed on the document: when it was issued, signed, decided or held; null when the record has none. */
export function documentDate(docType: string | null, payload: Payload | null): string | null {
  const p = payload ?? {}
  const byType: Record<string, string[]> = {
    receipt: ['receipt_date'],
    supplier_invoice: ['invoice_date'],
    credit_note: ['credit_date'],
    customer_invoice: ['invoice_date'],
    bank_statement: ['period_end'],
    tax_account_statement: ['period_end'],
    'registration.bolagsverket': ['issued_on', 'registration_date'],
    'filing.bolagsverket': ['filed_on'],
    'decision.skatteverket': ['decision_date'],
    'minutes.board': ['meeting_date'],
    'minutes.agm': ['meeting_date'],
    share_subscription_list: ['decision_date'],
    annual_report: ['signed_on', 'fiscal_year_end'],
  }
  const names = byType[docType ?? ''] ?? ['signed_on', 'starts_on', 'effective_on', 'document_date', 'disbursed_on']
  const v = settled(p, ...names)
  return v && ISO_DATE_RE.test(v) ? v : null
}
