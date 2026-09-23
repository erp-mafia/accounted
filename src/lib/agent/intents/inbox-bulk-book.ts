import { defineAgentIntent } from './types'
import { SONNET_MODEL, EFFORT_STANDARD } from '@/lib/agent/composer/client'

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
  // The bank transaction's own magnitude travels WITH its own currency, and the
  // SEK equivalent is a separate field that is null when the row is foreign and
  // no amount_sek/exchange_rate is stored. Never collapse the two: a foreign
  // amount labelled "SEK" reads to the agent as a SEK amount and it books on it.
  tx_amount: number | null
  tx_currency: string | null
  tx_amount_sek: number | null
  tx_description: string | null
}

interface CapturedInboxBulk {
  items: CapturedInboxItem[]
  bookable_count: number
}

// SEK magnitude of a bank transaction, or null when there genuinely is none.
// Foreign rows are normalised via their stored amount_sek/exchange_rate; a
// foreign row that carries NEITHER has no known SEK value, so we return null
// instead of falling back to rate 1 (that returned e.g. 500 for a 500 EUR row,
// which the sheet then printed as "500 SEK").
function txSek(tx: {
  amount: number | null
  currency: string | null
  amount_sek: number | null
  exchange_rate: number | null
}): number | null {
  if (tx.amount == null) return null
  const cur = String(tx.currency ?? 'SEK').toUpperCase()
  if (cur === 'SEK') return Math.abs(Number(tx.amount))
  if (tx.amount_sek != null) {
    const stored = Number(tx.amount_sek)
    return Number.isFinite(stored) ? Math.abs(stored) : null
  }
  const rate = tx.exchange_rate == null ? null : Number(tx.exchange_rate)
  if (rate == null || !Number.isFinite(rate) || rate <= 0) return null
  const sek = Number(tx.amount) * rate
  return Number.isFinite(sek) ? Math.abs(sek) : null
}

// Amount of the bank transaction in ITS OWN currency (absolute value, matching
// how txSek reports the SEK leg).
function txOwnAmount(tx: { amount: number | null }): number | null {
  if (tx.amount == null) return null
  const n = Number(tx.amount)
  return Number.isFinite(n) ? Math.abs(n) : null
}

// Renders the bank leg so the magnitude always carries its real unit: SEK rows
// print as before, foreign rows print their own amount plus the SEK equivalent
// when one exists, and say so explicitly when it does not.
function formatBankAmount(it: CapturedInboxItem): string | null {
  if (it.tx_amount == null) return null
  const cur = it.tx_currency ?? 'SEK'
  const own = `${it.tx_amount.toLocaleString('sv-SE')} ${cur}`
  if (cur === 'SEK') return own
  if (it.tx_amount_sek != null) return `${own} (${it.tx_amount_sek.toLocaleString('sv-SE')} SEK)`
  return `${own} (SEK-belopp saknas: ingen växelkurs lagrad på transaktionen)`
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
  thinking: { effort: EFFORT_STANDARD },

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
        tx_amount: tx ? txOwnAmount(tx) : null,
        tx_currency: tx ? String(tx.currency ?? 'SEK').toUpperCase() : null,
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
      const bank = formatBankAmount(it)
      if (bank) parts.push(`bank=${bank}`)
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
    lines.push('- Boka via banktransaktionen (Modell B): verktyget bokför varje underlag mot dess matchade banktransaktion. Bankraden ovan visar sitt eget belopp med sin egen valuta, och SEK-beloppet inom parentes när ett sådant finns lagrat. Står raden i SEK, eller har ett SEK-belopp inom parentes, behöver du inte räkna om valuta.')
    if (bookable.some((i) => i.tx_amount != null && (i.tx_currency ?? 'SEK') !== 'SEK' && i.tx_amount_sek == null)) {
      lines.push('- VÄXELKURS SAKNAS på minst en bankrad ovan (markerad "SEK-belopp saknas"). Det beloppet är i utländsk valuta, INTE i SEK: behandla det aldrig som ett SEK-belopp. Bulkbokför inte den raden på egen hand: säg till användaren att transaktionens växelkurs/SEK-belopp behöver fyllas i först, och bokför de övriga raderna som vanligt.')
    }
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
