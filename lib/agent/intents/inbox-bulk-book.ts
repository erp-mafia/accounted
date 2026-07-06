import { defineAgentIntent } from './types'
import { SONNET_MODEL, THINKING_BUDGET_STANDARD } from '@/lib/agent/composer/client'

// inbox.bulk-book: "Fråga assistenten" on a multi-selection in the Underlag
// view (Dokumentinkorgen). Unlike transaction.categorization (which keys off the
// single previewed item), this intent receives the user's CHECKBOX selection
// (selectedIds) so Lena acts on exactly what the user marked: not whatever
// happens to be open in the preview pane.
//
// Booking model (Modell B): each selected item is booked against its matched
// bank transaction with one shared category + VAT treatment via
// gnubok_bulk_book_inbox_items (which stages one approval). The agent groups the
// selection by vendor/kind and books each homogeneous group, detecting
// reverse-charge for foreign services.

interface InboxBulkBookArgs {
  item_ids: string[]
}

interface CapturedInboxItem {
  item_id: string
  // bookable = matched to a tx and not yet booked; not_matched = needs a bank
  // match first; already_booked = resolved (skip).
  status: 'bookable' | 'not_matched' | 'already_booked'
  merchant_name: string | null
  invoice_date: string | null
  total: number | null
  vat_amount: number | null
  currency: string | null
  tx_date: string | null
  tx_amount_sek: number | null
  tx_description: string | null
}

interface CapturedInboxBulk {
  items: CapturedInboxItem[]
  bookable_count: number
}

// SEK magnitude of a (usually-SEK) bank transaction. Foreign rows are
// normalised via their stored amount_sek/exchange_rate.
function txSek(tx: {
  amount: number | null
  currency: string | null
  amount_sek: number | null
  exchange_rate: number | null
}): number | null {
  if (tx.amount == null) return null
  const cur = String(tx.currency ?? 'SEK').toUpperCase()
  if (cur === 'SEK') return Math.abs(Number(tx.amount))
  const sek = tx.amount_sek ?? Number(tx.amount) * Number(tx.exchange_rate ?? 1)
  return Number.isFinite(sek) ? Math.abs(Number(sek)) : null
}

export const inboxBulkBook = defineAgentIntent<InboxBulkBookArgs, CapturedInboxBulk>({
  id: 'inbox.bulk-book',
  buttonLabel: 'Fråga assistenten',
  sheetTitle: 'Bulkbokför underlag',

  atoms: {
    mode: 'declarative',
    horizontal: ['swedish-vat', 'swedish-accounting-compliance', 'swedish-invoice-compliance'],
    includeCompanyVertical: true,
    includeCompanyModifiers: true,
  },

  tools: [
    'gnubok_bulk_book_inbox_items',
    'gnubok_categorize_transaction',
    'gnubok_query_journal',
    'gnubok_get_document_content',
    'gnubok_list_inbox_items',
    'gnubok_load_skill',
    'gnubok_search_tools',
    'gnubok_remember_fact',
    'gnubok_forget_fact',
  ],

  model: SONNET_MODEL,

  // Reason before proposing: group the selection and work out category + VAT
  // treatment in the thinking channel, so the visible reply is one short
  // motivation, not a play-by-play.
  thinking: { budgetTokens: THINKING_BUDGET_STANDARD },

  capture: async ({ item_ids }, { supabase, companyId }) => {
    const ids = Array.isArray(item_ids) ? item_ids.filter((x): x is string => typeof x === 'string') : []
    if (ids.length === 0) return { items: [], bookable_count: 0 }

    const { data: rows } = await supabase
      .from('invoice_inbox_items')
      .select('id, matched_transaction_id, created_journal_entry_id, created_supplier_invoice_id, extracted_data')
      .eq('company_id', companyId)
      .in('id', ids)

    const txIds = Array.from(
      new Set((rows ?? []).map((r) => r.matched_transaction_id).filter(Boolean) as string[]),
    )
    interface TxRow {
      id: string
      date: string | null
      amount: number | null
      currency: string | null
      amount_sek: number | null
      exchange_rate: number | null
      description: string | null
    }
    const txById = new Map<string, TxRow>()
    if (txIds.length > 0) {
      const { data: txs } = await supabase
        .from('transactions')
        .select('id, date, amount, currency, amount_sek, exchange_rate, description')
        .eq('company_id', companyId)
        .in('id', txIds)
      for (const t of ((txs ?? []) as TxRow[])) txById.set(t.id, t)
    }

    const items: CapturedInboxItem[] = (rows ?? []).map((r) => {
      const ex = (r.extracted_data ?? {}) as {
        supplier?: { name?: string | null }
        invoice?: { invoiceDate?: string | null; currency?: string | null }
        totals?: { total?: number | null; vatAmount?: number | null }
      }
      const tx = r.matched_transaction_id ? txById.get(r.matched_transaction_id as string) ?? null : null
      const status: CapturedInboxItem['status'] =
        r.created_journal_entry_id || r.created_supplier_invoice_id
          ? 'already_booked'
          : r.matched_transaction_id
            ? 'bookable'
            : 'not_matched'
      return {
        item_id: r.id as string,
        status,
        merchant_name: ex.supplier?.name ?? null,
        invoice_date: ex.invoice?.invoiceDate ?? null,
        total: ex.totals?.total ?? null,
        vat_amount: ex.totals?.vatAmount ?? null,
        currency: ex.invoice?.currency ?? null,
        tx_date: tx?.date ?? null,
        tx_amount_sek: tx ? txSek(tx) : null,
        tx_description: tx?.description ?? null,
      }
    })

    return { items, bookable_count: items.filter((i) => i.status === 'bookable').length }
  },

  promptTemplate: ({ captured, profileSummary }) => {
    const lines: string[] = []
    if (profileSummary) lines.push(`Företagets profil: ${profileSummary}`, '')

    if (captured.items.length === 0) {
      return [
        'Användaren öppnade hjälpfönstret från en markering i Dokumentinkorgen, men inga underlag kunde läsas.',
        'Be användaren markera underlagen igen och försök på nytt.',
      ].join(' ')
    }

    const bookable = captured.items.filter((i) => i.status === 'bookable')
    const notMatched = captured.items.filter((i) => i.status === 'not_matched')
    const alreadyBooked = captured.items.filter((i) => i.status === 'already_booked')

    lines.push(`Användaren har markerat ${captured.items.length} underlag i Dokumentinkorgen och vill bulkbokföra dem.`)
    lines.push('')
    lines.push(
      `MARKERADE UNDERLAG (${bookable.length} bokförbara, ${notMatched.length} saknar matchad transaktion, ${alreadyBooked.length} redan bokförda):`,
    )
    for (const it of bookable) {
      const parts: string[] = [`item_id=${it.item_id}`]
      if (it.merchant_name) parts.push(`leverantör=${it.merchant_name}`)
      if (it.total != null) parts.push(`belopp=${it.total.toLocaleString('sv-SE')} ${it.currency ?? 'SEK'}`)
      if (it.vat_amount != null) parts.push(`moms=${it.vat_amount.toLocaleString('sv-SE')} ${it.currency ?? 'SEK'}`)
      if (it.tx_amount_sek != null) parts.push(`bank=${it.tx_amount_sek.toLocaleString('sv-SE')} SEK`)
      if (it.tx_date) parts.push(`datum=${it.tx_date}`)
      lines.push(`  • ${parts.join(', ')}`)
    }
    if (notMatched.length > 0) {
      lines.push('')
      lines.push('EJ MATCHADE (kan inte bulkbokföras förrän de matchats mot en banktransaktion):')
      for (const it of notMatched) {
        const label = it.merchant_name ?? it.tx_description ?? it.item_id
        lines.push(`  • ${label}${it.total != null ? ` (${it.total.toLocaleString('sv-SE')} ${it.currency ?? 'SEK'})` : ''}`)
      }
    }
    lines.push('')
    lines.push('Arbetssätt:')
    lines.push('- Boka via banktransaktionen (Modell B): verktyget bokför varje underlag mot dess matchade banktransaktion, som redan bär SEK-beloppet. Du behöver inte räkna om valuta.')
    lines.push('- GRUPPERA de bokförbara underlagen efter leverantör/typ. Samma slags kostnad → samma kategori + momsbehandling. För varje homogen grupp anropar du gnubok_bulk_book_inbox_items med gruppens item_ids, en kategori (enum) och vat_treatment.')
    lines.push('- MOMS: en utländsk tjänst (t.ex. USD/EUR-prenumeration som Cursor/Anysphere där säljaren INTE debiterat svensk moms) är omvänd skattskyldighet → vat_treatment="reverse_charge". En svensk faktura med debiterad moms → standard_25 (eller den sats kvittot visar). Gissa aldrig: utgå från valuta + om underlaget visar moms.')
    lines.push('- KOLLA HUR MOTPARTEN BOKFÖRTS FÖRUT med gnubok_query_journal({ text: "<leverantör>", limit: 5 }) innan du väljer kategori. Följ ett tydligt tidigare mönster om inte underlaget motsäger det.')
    lines.push('- HOPPA ÖVER ej matchade underlag: be användaren matcha dem mot en banktransaktion först ("Matcha mot transaktion" i Dokumentinkorgen), så kan de bulkbokföras i nästa runda. Bokför ALDRIG ett underlag utan matchad transaktion via det här flödet.')
    lines.push('- Förklara kort på svenska VARFÖR du valde kategori + momsbehandling: använd kategori-namn (t.ex. "Programvara/IT-tjänster"), aldrig ett BAS-kontonummer. Godkännandekortet visar antal, konto och moms; upprepa inte de siffrorna och säg inte att operationen är "stagead".')
    lines.push('')
    lines.push('Svara på svenska och var direkt.')
    return lines.join('\n')
  },
})
