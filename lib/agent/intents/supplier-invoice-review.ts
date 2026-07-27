import { defineAgentIntent } from './types'
import { OPUS_MODEL, EFFORT_DEEP } from '@/lib/agent/composer/client'
import { renderAgentGroundRules } from './shared-rules'

// supplier_invoice.review: "Fråga din assistent" from a supplier invoice
// detail page. Helps the user verify a supplier invoice before attestering
// it: BAS account, VAT treatment (reverse charge byggtjänster?), anomaly
// detection vs. prior invoices from the same supplier, and missing-field
// checks against ML 17 kap 24§.
//
// Declarative atom mode: loads VAT + invoice compliance + accounting
// compliance upfront, plus the company's vertical + modifier atoms. AP
// flows benefit most from these: invoices from EU suppliers trigger
// reverse charge logic, bygg suppliers trigger omvänd skattskyldighet.
//
// Default model: Opus (per plan §8 V1 #5: heavy intent). The reasoning
// chain is non-trivial:
//   1. Read inbox-extracted fields (supplier, total, VAT, line items)
//   2. Compare to supplier history: anomalies?
//   3. Detect reverse charge cases (EU, bygg)
//   4. Verify ML 17 kap 24§ mandatory fields are present
//   5. Propose BAS account + VAT code
//
// Plan ref: dev_docs/specialized-agent-plan.md §8 (V1 intent #5).

interface SupplierInvoiceReviewArgs {
  supplier_invoice_id: string
}

interface CapturedSupplierInvoiceReview {
  invoice: {
    id: string
    arrival_number: number | null
    supplier_invoice_number: string | null
    invoice_date: string | null
    due_date: string | null
    status: string | null
    currency: string | null
    subtotal: number | null
    vat_amount: number | null
    total: number | null
    // The invoice's magnitudes travel WITH their own currency, and the SEK
    // legs are separate fields that stay null when no rate was ever resolved.
    // Never collapse the two: a EUR amount printed without a unit reads to the
    // agent as kronor, and it attests the booking on that number.
    vat_amount_sek: number | null
    total_sek: number | null
    exchange_rate: number | null
    vat_treatment: string | null
    reverse_charge: boolean | null
    payment_reference: string | null
    is_credit_note: boolean | null
    document_id: string | null
  } | null
  supplier: {
    id: string
    name: string | null
    org_number: string | null
    vat_number: string | null
    country: string | null
  } | null
  items: {
    description: string | null
    quantity: number | null
    unit_price: number | null
    line_total: number | null
    vat_rate: number | null
    account_number: string | null
  }[]
  recent_invoices_from_supplier: {
    invoice_number: string | null
    invoice_date: string | null
    total: number | null
    currency: string | null
    // Anomaly detection compares these against each other. Without a common
    // unit that comparison is meaningless, so the SEK leg travels along.
    total_sek: number | null
    exchange_rate: number | null
    status: string | null
  }[]
  // Linked inbox / document extraction so the agent doesn't re-ask for what
  // the AI has already extracted.
  inbox_extraction: Record<string, unknown> | null
  document_extraction: Record<string, unknown> | null
}

// ISO code as stored, uppercased, or null when nothing usable is there. A blank
// or absent code is NOT silently promoted to SEK: an amount whose unit we do
// not know must be rendered as unknown, never as kronor.
function normalizeCurrency(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const code = value.trim().toUpperCase()
  return code.length === 0 ? null : code
}

// "1 200 EUR", or "1 200 (valuta okänd)" when no currency code is attached.
function formatMoney(amount: number | null | undefined, currency: string | null | undefined): string {
  if (amount == null || !Number.isFinite(Number(amount))) return '?'
  const code = normalizeCurrency(currency)
  const value = Number(amount).toLocaleString('sv-SE')
  return code ? `${value} ${code}` : `${value} (valuta okänd)`
}

// SEK magnitude of an amount, or null when there genuinely is none. Mirrors
// resolveSekAmount()'s priority (stored *_sek column, then exchange_rate) but
// deliberately drops its legacy "assume SEK" fallback: for a reader the honest
// answer is "no known SEK value", not the face value relabelled as kronor.
function sekEquivalent(
  amount: number | null | undefined,
  amountSek: number | null | undefined,
  currency: string | null | undefined,
  exchangeRate: number | null | undefined,
): number | null {
  if (amount == null || !Number.isFinite(Number(amount))) return null
  if (normalizeCurrency(currency) === 'SEK') return Number(amount)
  if (amountSek != null && Number.isFinite(Number(amountSek))) return Number(amountSek)
  const rate = exchangeRate == null ? null : Number(exchangeRate)
  if (rate != null && Number.isFinite(rate) && rate > 0) {
    return Math.round(Number(amount) * rate * 100) / 100
  }
  return null
}

// "1 200 EUR (13 800 SEK)" when a rate exists, plain "1 200 SEK" for a domestic
// amount, and the bare foreign amount when no SEK value is known.
function formatMoneyWithSek(
  amount: number | null | undefined,
  amountSek: number | null | undefined,
  currency: string | null | undefined,
  exchangeRate: number | null | undefined,
): string {
  const own = formatMoney(amount, currency)
  if (amount == null) return own
  if (normalizeCurrency(currency) === 'SEK') return own
  const sek = sekEquivalent(amount, amountSek, currency, exchangeRate)
  return sek == null ? own : `${own} (${sek.toLocaleString('sv-SE')} SEK)`
}

export const supplierInvoiceReview = defineAgentIntent<
  SupplierInvoiceReviewArgs,
  CapturedSupplierInvoiceReview
>({
  id: 'supplier_invoice.review',
  buttonLabel: 'Granska med assistent',
  sheetTitle: 'Granska leverantörsfaktura',

  atoms: {
    mode: 'declarative',
    horizontal: ['swedish-vat', 'swedish-invoice-compliance', 'swedish-accounting-compliance'],
    includeCompanyVertical: true,
    includeCompanyModifiers: true,
  },

  tools: [
    'gnubok_get_supplier_ledger',
    'gnubok_query_journal',
    'gnubok_get_document_content',
    'gnubok_approve_supplier_invoice',
    'gnubok_credit_supplier_invoice',
    'gnubok_load_skill',
    'gnubok_search_tools',
    'gnubok_remember_fact',
    'gnubok_forget_fact',
  ],

  // Opus per plan §8: anomaly detection + multi-source synthesis benefits
  // from deeper reasoning than Sonnet's strength on selection tasks.
  model: OPUS_MODEL,

  // Reason about underlag, VAT treatment and anomalies in the thinking channel
  // so the visible reply is a single conclusion after the booking is staged:
  // not a pre-tool analysis echoed again post-tool. Matches the always-on
  // prompt's promise that reasoning happens in the (separately shown) tankekanal.
  thinking: { effort: EFFORT_DEEP },

  capture: async ({ supplier_invoice_id }, { supabase, companyId }) => {
    const { data: invoice } = await supabase
      .from('supplier_invoices')
      .select(
        'id, supplier_id, arrival_number, supplier_invoice_number, invoice_date, due_date, status, currency, exchange_rate, subtotal, vat_amount, vat_amount_sek, total, total_sek, vat_treatment, reverse_charge, payment_reference, is_credit_note, document_id',
      )
      .eq('id', supplier_invoice_id)
      .eq('company_id', companyId)
      .maybeSingle()

    if (!invoice) {
      return {
        invoice: null,
        supplier: null,
        items: [],
        recent_invoices_from_supplier: [],
        inbox_extraction: null,
        document_extraction: null,
      }
    }

    const supplierId = (invoice as { supplier_id: string }).supplier_id
    const documentId = (invoice as { document_id: string | null }).document_id

    const [
      { data: supplier },
      { data: items },
      { data: recent },
      { data: inboxRow },
      { data: docRow },
    ] = await Promise.all([
      supplierId
        ? supabase
            .from('suppliers')
            .select('id, name, org_number, vat_number, country')
            .eq('id', supplierId)
            .eq('company_id', companyId)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      supabase
        .from('supplier_invoice_items')
        .select('description, quantity, unit_price, line_total, vat_rate, account_number')
        .eq('supplier_invoice_id', supplier_invoice_id),
      supplierId
        ? supabase
            .from('supplier_invoices')
            .select('supplier_invoice_number, invoice_date, total, total_sek, currency, exchange_rate, status')
            .eq('supplier_id', supplierId)
            .eq('company_id', companyId)
            .neq('id', supplier_invoice_id)
            .order('invoice_date', { ascending: false })
            .limit(5)
        : Promise.resolve({ data: [] }),
      documentId
        ? supabase
            .from('invoice_inbox_items')
            .select('extracted_data')
            .eq('document_id', documentId)
            .eq('company_id', companyId)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      documentId
        ? supabase
            .from('document_attachments')
            .select('extracted_data')
            .eq('id', documentId)
            .eq('company_id', companyId)
            .maybeSingle()
        : Promise.resolve({ data: null }),
    ])

    return {
      invoice: {
        id: (invoice as { id: string }).id,
        arrival_number: ((invoice as { arrival_number?: number }).arrival_number) ?? null,
        supplier_invoice_number:
          ((invoice as { supplier_invoice_number?: string | null }).supplier_invoice_number) ?? null,
        invoice_date: ((invoice as { invoice_date?: string | null }).invoice_date) ?? null,
        due_date: ((invoice as { due_date?: string | null }).due_date) ?? null,
        status: ((invoice as { status?: string | null }).status) ?? null,
        currency: ((invoice as { currency?: string | null }).currency) ?? null,
        subtotal: ((invoice as { subtotal?: number | null }).subtotal) ?? null,
        vat_amount: ((invoice as { vat_amount?: number | null }).vat_amount) ?? null,
        total: ((invoice as { total?: number | null }).total) ?? null,
        vat_amount_sek: ((invoice as { vat_amount_sek?: number | null }).vat_amount_sek) ?? null,
        total_sek: ((invoice as { total_sek?: number | null }).total_sek) ?? null,
        exchange_rate: ((invoice as { exchange_rate?: number | null }).exchange_rate) ?? null,
        vat_treatment: ((invoice as { vat_treatment?: string | null }).vat_treatment) ?? null,
        reverse_charge: ((invoice as { reverse_charge?: boolean | null }).reverse_charge) ?? null,
        payment_reference:
          ((invoice as { payment_reference?: string | null }).payment_reference) ?? null,
        is_credit_note: ((invoice as { is_credit_note?: boolean | null }).is_credit_note) ?? null,
        document_id: documentId,
      },
      supplier: supplier
        ? {
            id: (supplier as { id: string }).id,
            name: ((supplier as { name?: string | null }).name) ?? null,
            org_number: ((supplier as { org_number?: string | null }).org_number) ?? null,
            vat_number: ((supplier as { vat_number?: string | null }).vat_number) ?? null,
            country: ((supplier as { country?: string | null }).country) ?? null,
          }
        : null,
      items: ((items ?? []) as {
        description: string | null
        quantity: number | null
        unit_price: number | null
        line_total: number | null
        vat_rate: number | null
        account_number: string | null
      }[]).map((i) => ({
        description: i.description,
        quantity: i.quantity,
        unit_price: i.unit_price,
        line_total: i.line_total,
        vat_rate: i.vat_rate,
        account_number: i.account_number,
      })),
      recent_invoices_from_supplier: ((recent ?? []) as {
        supplier_invoice_number: string | null
        invoice_date: string | null
        total: number | null
        total_sek: number | null
        currency: string | null
        exchange_rate: number | null
        status: string | null
      }[]).map((r) => ({
        invoice_number: r.supplier_invoice_number,
        invoice_date: r.invoice_date,
        total: r.total,
        total_sek: r.total_sek ?? null,
        currency: r.currency,
        exchange_rate: r.exchange_rate ?? null,
        status: r.status,
      })),
      inbox_extraction: (inboxRow as { extracted_data?: Record<string, unknown> | null } | null)?.extracted_data ?? null,
      document_extraction: (docRow as { extracted_data?: Record<string, unknown> | null } | null)?.extracted_data ?? null,
    }
  },

  promptTemplate: ({ captured, profileSummary }) => {
    if (!captured.invoice) {
      return [
        'Användaren öppnade hjälpfönstret från en leverantörsfaktura, men fakturan kunde inte hittas.',
        'Be om mer information och försök hjälpa på generell nivå.',
      ].join(' ')
    }

    const inv = captured.invoice
    const lines: string[] = []
    if (profileSummary) lines.push(`Företagets profil: ${profileSummary}`, '')

    lines.push(renderAgentGroundRules())
    lines.push('')
    lines.push('Granska denna leverantörsfaktura innan attestering:')
    lines.push(`- Ankomst #${inv.arrival_number ?? '?'} / Fakturanummer ${inv.supplier_invoice_number ?? '?'}`)
    if (captured.supplier) {
      const s = captured.supplier
      const supplierLine: string[] = []
      if (s.name) supplierLine.push(`Leverantör: ${s.name}`)
      if (s.country && s.country !== 'SE') supplierLine.push(`(${s.country})`)
      if (s.org_number) supplierLine.push(`org.nr ${s.org_number}`)
      if (s.vat_number) supplierLine.push(`VAT ${s.vat_number}`)
      lines.push(`- ${supplierLine.join(' ')}`)
    }
    lines.push(`- Status: ${inv.status ?? '?'} | Datum: ${inv.invoice_date ?? '?'} | Förfaller: ${inv.due_date ?? '?'}`)
    const invCurrency = normalizeCurrency(inv.currency)
    lines.push(
      `- Belopp: ${formatMoney(inv.total, inv.currency)} (moms ${formatMoney(inv.vat_amount, inv.currency)})`,
    )
    // A foreign invoice is booked in SEK, so the SEK leg is the number that
    // actually lands in the verifikat. Print it next to the face value when it
    // exists, and say plainly that it is missing when it does not: the one
    // thing this block must never do is let a EUR figure pass for kronor.
    if (invCurrency !== 'SEK' && inv.total != null) {
      const totalSek = sekEquivalent(inv.total, inv.total_sek, inv.currency, inv.exchange_rate)
      const vatSek = sekEquivalent(inv.vat_amount, inv.vat_amount_sek, inv.currency, inv.exchange_rate)
      if (totalSek != null) {
        lines.push(
          `- I SEK (bokföringen sker i SEK): ${totalSek.toLocaleString('sv-SE')} SEK (moms ${vatSek != null ? `${vatSek.toLocaleString('sv-SE')} SEK` : '?'})${inv.exchange_rate != null ? `, växelkurs ${inv.exchange_rate}` : ''}`,
        )
      } else {
        lines.push(
          `- SEK-BELOPP SAKNAS: ingen växelkurs är lagrad på fakturan. ${formatMoney(inv.total, inv.currency)} är INTE ${inv.total.toLocaleString('sv-SE')} SEK. Attestera inte på det nominella beloppet: växelkursen måste fyllas i först.`,
        )
      }
    }
    lines.push(
      `- Momskod: ${inv.vat_treatment ?? '?'}${inv.reverse_charge ? ' (omvänd skattskyldighet flaggad)' : ''}`,
    )
    if (inv.payment_reference) lines.push(`- OCR / referens: ${inv.payment_reference}`)
    if (inv.is_credit_note) lines.push('- DETTA ÄR EN KREDITFAKTURA')
    lines.push('')

    if (captured.items.length > 0) {
      lines.push('Rader:')
      for (const it of captured.items.slice(0, 20)) {
        // Line amounts are stored in the invoice's currency, so they carry the
        // invoice's currency code: never a bare number that reads as kronor.
        const total = formatMoney(it.line_total, inv.currency)
        const vat = it.vat_rate != null ? `${it.vat_rate}%` : '?'
        const acc = it.account_number ? ` → ${it.account_number}` : ' → (ingen kontering)'
        lines.push(`  • ${it.description ?? '(beskrivning saknas)'}: ${total} (${vat})${acc}`)
      }
      lines.push('')
    }

    if (captured.recent_invoices_from_supplier.length > 0) {
      lines.push('Tidigare fakturor från samma leverantör (för anomalikontroll):')
      for (const r of captured.recent_invoices_from_supplier) {
        const amt = formatMoneyWithSek(r.total, r.total_sek, r.currency, r.exchange_rate)
        lines.push(`  • ${r.invoice_number ?? '?'} (${r.invoice_date ?? '?'}, ${r.status ?? '?'}): ${amt}`)
      }
      lines.push('')
    }

    const ex = captured.inbox_extraction ?? captured.document_extraction
    if (ex) {
      const supplier = (ex.supplier as { name?: string | null; orgNumber?: string | null; vatNumber?: string | null } | undefined) ?? null
      const exInvoice = (ex.invoice as { currency?: string | null } | undefined) ?? null
      const totals = (ex.totals as { total?: number | null; vatAmount?: number | null } | undefined) ?? null
      const breakdown = (ex.vatBreakdown as { rate: number; base: number; amount: number }[] | undefined) ?? []
      const exCurrency = normalizeCurrency(exInvoice?.currency)
      const hasExtractedAmounts =
        totals?.total != null || totals?.vatAmount != null || breakdown.length > 0
      // An extracted amount is a KNOWN FACT only when we know its unit AND that
      // unit is the one the invoice is registered in. Anything else is half a
      // fact, and half a fact under a "fråga INTE om dessa" header reads as
      // confirmation of the registered amount: that is exactly how a 1 200 EUR
      // invoice gets attested as 1 200 SEK. Those values move to their own
      // block below, where the agent is told to settle them first.
      const amountsConfirmRegistered =
        hasExtractedAmounts && exCurrency != null && invCurrency != null && exCurrency === invCurrency

      const renderAmountLines = (): string[] => {
        const out: string[] = []
        if (totals?.total != null) out.push(`- Total (PDF): ${formatMoney(totals.total, exCurrency)}`)
        if (totals?.vatAmount != null) out.push(`- Moms (PDF): ${formatMoney(totals.vatAmount, exCurrency)}`)
        if (breakdown.length > 0) {
          out.push(
            `- Momsuppdelning: ${breakdown.map((b) => `${b.rate}%: ${formatMoney(b.amount, exCurrency)}`).join('; ')}`,
          )
        }
        return out
      }

      const known: string[] = []
      if (supplier?.name) known.push(`- Leverantör (PDF): ${supplier.name}`)
      if (supplier?.orgNumber) known.push(`- Org.nr (PDF): ${supplier.orgNumber}`)
      if (supplier?.vatNumber) known.push(`- VAT-nr (PDF): ${supplier.vatNumber}`)
      if (amountsConfirmRegistered) known.push(...renderAmountLines())
      if (known.length > 0) {
        lines.push('KÄNDA FAKTA från AI-extraktion av underlaget: fråga INTE om dessa:')
        lines.push(...known)
        lines.push('')
      }

      if (hasExtractedAmounts && !amountsConfirmRegistered) {
        lines.push(
          'EJ BEKRÄFTADE BELOPP från AI-extraktionen: dessa är INTE kända fakta och bekräftar INTE det registrerade beloppet ovan:',
        )
        lines.push(...renderAmountLines())
        if (exCurrency == null) {
          lines.push(
            `- Extraktionen anger ingen valuta. Fakturan är registrerad i ${invCurrency ?? 'okänd valuta'}: ett belopp utan valuta kan varken bekräfta eller motsäga det registrerade beloppet. Behandla det ALDRIG som kronor.`,
          )
        } else {
          lines.push(
            `- ⚠ VALUTAKONFLIKT: fakturan är registrerad i ${invCurrency ?? 'okänd valuta'} men underlaget anger ${exCurrency}. Attestera inte förrän det är utrett vilken valuta som gäller: ett av beloppen är fel registrerat.`,
          )
        }
        lines.push(
          `- Fastställ valuta och belopp INNAN du attesterar: läs underlaget med gnubok_get_document_content(document_id=${inv.document_id ?? '…'}), eller fråga användaren.`,
        )
        lines.push('')
      }
    } else if (inv.document_id) {
      lines.push('Underlag är bifogat men inte AI-extraherat. Använd gnubok_get_document_content för att läsa PDF/bilden om du behöver fler signaler.')
      lines.push('')
    } else {
      lines.push('Inget underlag bifogat. Be användaren ladda upp fakturan om något är otydligt.')
      lines.push('')
    }

    lines.push('Arbetssätt: granska, peka på risker, föreslå.')
    lines.push('1. Kontrollera momsbehandling: passar den med leverantörens land + VAT-status?')
    lines.push('   - SE-leverantör: 25/12/6 % beroende på vara/tjänst.')
    lines.push('   - EU näringsidkare: omvänd skattskyldighet (2614/2645).')
    lines.push('   - Bygg i Sverige: omvänd skattskyldighet enligt ML 1 kap 2 § 1 st 4b.')
    lines.push('   - Tredje land: import-moms via Tullverket eller deklareras via momsdeklaration ruta 60-62.')
    lines.push('2. Valuta: bokföringen sker i SEK. Är fakturan i utländsk valuta är det SEK-beloppet ovan som bokförs, aldrig det nominella beloppet i främmande valuta. Saknas SEK-beloppet (ingen växelkurs lagrad): attestera inte, be användaren fylla i växelkursen först. Ett belopp utan angiven valuta är inte ett SEK-belopp: reda ut valutan innan du räknar på det.')
    lines.push('3. Avvikelse mot tidigare fakturor från samma leverantör? Beloppen i ungefär samma härad? Jämför i SEK när valutorna skiljer sig åt: en jämförelse mellan olika valutor säger ingenting.')
    lines.push('4. Saknas obligatoriska fält (ML 17 kap 24§): fakturanummer, datum, org.nr, moms-belopp, VAT-id vid reverse charge?')
    lines.push('5. Föreslå rätt BAS-konto för varje rad (eller för hela fakturan om bara en summarad finns). Följ leverantörens historik: gnubok_query_journal({ text: "<leverantörens namn>", source_type: "supplier_invoice", limit: 5 }): när du väljer konto.')
    lines.push('6. Om du är säker, staga attestering via gnubok_approve_supplier_invoice. Annars: peka på vad som ska klargöras innan attestering.')
    lines.push('')
    lines.push('Svara på svenska, var direkt och konkret. Ditt första svar är det första användaren ser.')
    return lines.join('\n')
  },
})
