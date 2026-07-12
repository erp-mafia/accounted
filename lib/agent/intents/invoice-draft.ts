import { defineAgentIntent } from './types'
import { SONNET_MODEL, THINKING_BUDGET_STANDARD } from '@/lib/agent/composer/client'
import { renderAgentGroundRules } from './shared-rules'

// invoice.draft: "Fråga om denna faktura" from the invoice form.
//
// Declarative atom mode: loads VAT + invoice compliance + e-invoicing
// upfront, plus the company's vertical + modifier atoms. The agent helps
// with VAT treatment (25/12/6 % or reverse charge), payment terms,
// kreditfaktura mechanics, OCR/Bankgiro on the invoice, and EU-customer
// edge cases.
//
// The user does the actual drafting in the form; this intent advises.
// gnubok_create_invoice / send_invoice are NOT in the tool list because
// the form already submits to those endpoints: the agent shouldn't race
// the form.
//
// Plan ref: dev_docs/specialized-agent-plan.md §8 (V1 intent #2).

interface InvoiceDraftArgs {
  // null when the user opened the agent before picking a customer.
  customer_id?: string | null
  // Set when editing an existing draft (route /invoices/[id]). null for new.
  invoice_id?: string | null
}

interface CapturedInvoiceDraft {
  customer: {
    id: string
    name: string | null
    customer_type: string | null
    country: string | null
    vat_number: string | null
    vat_number_validated: boolean | null
    org_number: string | null
  } | null
  recent_invoices: {
    invoice_number: string | null
    invoice_date: string | null
    status: string | null
    total: number | null
    currency: string | null
  }[]
  invoice: {
    id: string
    invoice_number: string | null
    status: string | null
    total: number | null
    currency: string | null
  } | null
  // Compact subset of company_settings relevant to invoice drafting.
  company_invoice_context: {
    moms_period: string | null
    vat_registered: boolean | null
    accounting_method: string | null
    invoice_default_days: number | null
  } | null
}

export const invoiceDraft = defineAgentIntent<InvoiceDraftArgs, CapturedInvoiceDraft>({
  id: 'invoice.draft',
  buttonLabel: 'Fråga om denna faktura',
  sheetTitle: 'Hjälp med faktura',

  atoms: {
    mode: 'declarative',
    horizontal: ['swedish-vat', 'swedish-invoice-compliance', 'swedish-e-invoicing'],
    includeCompanyVertical: true,
    includeCompanyModifiers: true,
  },

  tools: [
    'gnubok_list_customers',
    'gnubok_create_customer',
    'gnubok_load_skill',
    'gnubok_search_tools',
    'gnubok_remember_fact',
    'gnubok_forget_fact',
  ],

  model: SONNET_MODEL,

  // Draft the invoice lines + VAT in the thinking channel, so the visible reply
  // is one short confirmation after staging rather than a play-by-play that
  // repeats once before the tool call and once after it.
  thinking: { budgetTokens: THINKING_BUDGET_STANDARD },

  capture: async ({ customer_id, invoice_id }, { supabase, companyId }) => {
    // Resolve the effective customer_id. When the FAB lands here from
    // /invoices/[id] it only knows invoice_id: read customer_id off the
    // invoice row so the customer section of the prompt isn't empty.
    type InvoiceRow = {
      id: string
      invoice_number?: string | null
      status?: string | null
      total?: number | null
      currency?: string | null
      customer_id?: string | null
    }
    let invoice: InvoiceRow | null = null
    if (invoice_id) {
      const { data } = await supabase
        .from('invoices')
        .select('id, invoice_number, status, total, currency, customer_id')
        .eq('id', invoice_id)
        .eq('company_id', companyId)
        .maybeSingle()
      invoice = (data as InvoiceRow | null) ?? null
    }
    const effectiveCustomerId = customer_id ?? invoice?.customer_id ?? null

    const [{ data: customer }, { data: recent }, { data: settings }] = await Promise.all([
      effectiveCustomerId
        ? supabase
            .from('customers')
            .select('id, name, customer_type, country, vat_number, vat_number_validated, org_number')
            .eq('id', effectiveCustomerId)
            .eq('company_id', companyId)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      effectiveCustomerId
        ? supabase
            .from('invoices')
            .select('invoice_number, invoice_date, status, total, currency')
            .eq('customer_id', effectiveCustomerId)
            .eq('company_id', companyId)
            .order('invoice_date', { ascending: false })
            .limit(5)
        : Promise.resolve({ data: [] }),
      supabase
        .from('company_settings')
        .select('moms_period, vat_registered, accounting_method, invoice_default_days')
        .eq('company_id', companyId)
        .maybeSingle(),
    ])

    return {
      customer: customer
        ? {
            id: (customer as { id: string }).id,
            name: ((customer as { name?: string | null }).name) ?? null,
            customer_type: ((customer as { customer_type?: string | null }).customer_type) ?? null,
            country: ((customer as { country?: string | null }).country) ?? null,
            vat_number: ((customer as { vat_number?: string | null }).vat_number) ?? null,
            vat_number_validated:
              ((customer as { vat_number_validated?: boolean | null }).vat_number_validated) ?? null,
            org_number: ((customer as { org_number?: string | null }).org_number) ?? null,
          }
        : null,
      recent_invoices: ((recent ?? []) as {
        invoice_number: string | null
        invoice_date: string | null
        status: string | null
        total: number | null
        currency: string | null
      }[]).map((r) => ({
        invoice_number: r.invoice_number,
        invoice_date: r.invoice_date,
        status: r.status,
        total: r.total,
        currency: r.currency,
      })),
      invoice: invoice
        ? {
            id: (invoice as { id: string }).id,
            invoice_number: ((invoice as { invoice_number?: string | null }).invoice_number) ?? null,
            status: ((invoice as { status?: string | null }).status) ?? null,
            total: ((invoice as { total?: number | null }).total) ?? null,
            currency: ((invoice as { currency?: string | null }).currency) ?? null,
          }
        : null,
      company_invoice_context: settings
        ? {
            moms_period: (settings as { moms_period?: string | null }).moms_period ?? null,
            vat_registered: (settings as { vat_registered?: boolean | null }).vat_registered ?? null,
            accounting_method:
              (settings as { accounting_method?: string | null }).accounting_method ?? null,
            invoice_default_days:
              (settings as { invoice_default_days?: number | null }).invoice_default_days ?? null,
          }
        : null,
    }
  },

  promptTemplate: ({ captured, profileSummary }) => {
    const lines: string[] = []
    if (profileSummary) lines.push(`Företagets profil: ${profileSummary}`, '')

    lines.push('Användaren håller på att skriva en faktura. Hjälp dem komma rätt.')
    lines.push('')
    lines.push(renderAgentGroundRules())
    lines.push('')

    if (captured.customer) {
      const c = captured.customer
      lines.push('KUND (vald):')
      lines.push(`- Namn: ${c.name ?? '(saknas)'}`)
      lines.push(`- Typ: ${c.customer_type ?? '(saknas)'}`)
      lines.push(`- Land: ${c.country ?? 'SE'}`)
      if (c.vat_number) {
        lines.push(
          `- VAT-nummer: ${c.vat_number}${c.vat_number_validated ? ' (validerat via VIES)' : ' (ej validerat)'}`,
        )
      }
      if (c.org_number) lines.push(`- Org.nr: ${c.org_number}`)
      lines.push('')

      if (captured.recent_invoices.length > 0) {
        lines.push('Senaste fakturor till denna kund:')
        for (const r of captured.recent_invoices) {
          const amt = r.total != null ? `${r.total.toLocaleString('sv-SE')} ${r.currency ?? 'SEK'}` : '?'
          lines.push(`  • ${r.invoice_number ?? '?'} (${r.invoice_date ?? '?'}, ${r.status ?? '?'}): ${amt}`)
        }
        lines.push('')
      }
    } else {
      lines.push('Ingen kund vald ännu. Be användaren välja eller skapa en kund först om de behöver hjälp med momsbehandling: momskod beror på kundens land och typ.')
      lines.push('')
    }

    if (captured.company_invoice_context) {
      const s = captured.company_invoice_context
      const known: string[] = []
      if (s.moms_period) known.push(`Momsperiod: ${s.moms_period}`)
      if (s.vat_registered != null) known.push(`Momsregistrerad: ${s.vat_registered ? 'ja' : 'nej'}`)
      if (s.accounting_method) known.push(`Bokföringsmetod: ${s.accounting_method}`)
      if (s.invoice_default_days != null) known.push(`Standardbetalningsvillkor: ${s.invoice_default_days} dagar`)
      if (known.length > 0) {
        lines.push('KÄNDA FAKTA (fråga inte om dessa):')
        for (const k of known) lines.push(`- ${k}`)
        lines.push('')
      }
    }

    lines.push('Arbetssätt: hämta information via verktygsanrop FÖRST (tyst: statusraderna visar att du söker, och ditt resonemang sker i tankekanalen), föreslå sedan. Skriv din förklaring EN gång efteråt, inte i flera block runt anropen.')
    lines.push('- Hjälp användaren välja rätt momsbehandling baserat på kundens land + typ + VAT-validering:')
    lines.push('  · SE-kund: 25/12/6 % beroende på vara/tjänst.')
    lines.push('  · EU näringsidkare med validerat VAT-nr: omvänd skattskyldighet (reverse charge) på tjänster.')
    lines.push('  · EU privatperson: SE-moms (eller OSS-tröskel om varor).')
    lines.push('  · Utanför EU: export, 0 %.')
    lines.push('- Föreslå betalningsvillkor, OCR/Bankgiro-uppgifter, eventuell ROT/RUT, EU-text på fakturan vid reverse charge.')
    lines.push('- Du SKAPAR INTE fakturan. Användaren gör det själv i formuläret. Du rådger.')
    lines.push('- Om kunden saknar VAT-nummer men är EU-näringsidkare, säg till: VIES-validering krävs för reverse charge.')
    lines.push('')
    lines.push('Svara på svenska och var direkt: ditt första svar är det första användaren ser.')
    return lines.join('\n')
  },
})
