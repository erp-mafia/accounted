import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { chunk } from '@/lib/utils'

/**
 * A followable link from a verifikation back to the händelse that it books or
 * settles: the bank transaction or skattekonto row the entry was created from
 * or matched against. The mirror of "Visa verifikat" on the transactions page.
 *
 * Deliberately NOT an underlag reference (see journal-entry-references.ts): a
 * bank line is the trace of the affärshändelse, not its supporting document,
 * so this list never feeds the "saknar underlag" verdict. It exists so the
 * verifieringskedja can be followed from the verifikat side too (BFNAR
 * 2013:2: the chain must be followable in both directions).
 */
export interface LinkedTransactionRef {
  kind: 'bank' | 'skattekonto'
  id: string
  /** ISO date of the händelse (transactions.date / transaktionsdatum). */
  date: string
  description: string
  /** Signed in the händelse's own convention: positive = money in. */
  amount: number
  /** null for skattekonto rows (always SEK). */
  currency: string | null
}

interface BankTransactionRow {
  id: string
  date: string
  description: string
  amount: number | string
  currency: string | null
}

interface SkattekontoRow {
  id: string
  transaktionsdatum: string
  transaktionstext: string
  belopp_skatteverket: number | string
}

const BANK_COLUMNS = 'id, date, description, amount, currency'

function toBankRef(row: BankTransactionRow): LinkedTransactionRef {
  return {
    kind: 'bank',
    id: row.id,
    date: row.date,
    description: row.description,
    amount: Number(row.amount),
    currency: row.currency ?? null,
  }
}

/**
 * Every bank transaction and skattekonto row anchored to `journalEntryId`,
 * newest first. Consults the same four bank-side anchors as
 * `is_transaction_booked()` (transactions.journal_entry_id, the
 * transaction_voucher_links junction, invoice_payments and
 * supplier_invoice_payments rows), plus skattekonto_transactions.journal_entry_id.
 *
 * Every query is company-scoped, so a foreign id resolves to an empty list.
 */
export async function getJournalEntryLinkedTransactions(
  supabase: SupabaseClient,
  companyId: string,
  journalEntryId: string,
): Promise<LinkedTransactionRef[]> {
  const bank = new Map<string, LinkedTransactionRef>()

  // 1. The 1:1 pointer (categorize, match-invoice, manual link).
  const direct = await fetchAllRows<BankTransactionRow>(({ from, to }) =>
    supabase.from('transactions').select(BANK_COLUMNS)
      .eq('company_id', companyId).eq('journal_entry_id', journalEntryId)
      .order('id', { ascending: true }).range(from, to),
  )
  for (const row of (direct ?? []) as BankTransactionRow[]) {
    bank.set(row.id, toBankRef(row))
  }

  // 2-4. Indirect anchors: the pointer stays NULL on these rows, the link
  // lives in a junction or payment row instead.
  const indirectIds = new Set<string>()

  const junction = await fetchAllRows<{ id: string; transaction_id: string }>(({ from, to }) =>
    supabase.from('transaction_voucher_links').select('id, transaction_id')
      .eq('company_id', companyId).eq('journal_entry_id', journalEntryId)
      .order('id', { ascending: true }).range(from, to),
  )
  for (const row of (junction ?? []) as { transaction_id: string }[]) {
    if (!bank.has(row.transaction_id)) indirectIds.add(row.transaction_id)
  }

  const invoicePayments = await fetchAllRows<{ id: string; transaction_id: string | null }>(({ from, to }) =>
    supabase.from('invoice_payments').select('id, transaction_id')
      .eq('journal_entry_id', journalEntryId).not('transaction_id', 'is', null)
      .order('id', { ascending: true }).range(from, to),
  )
  for (const row of (invoicePayments ?? []) as { transaction_id: string | null }[]) {
    if (row.transaction_id && !bank.has(row.transaction_id)) indirectIds.add(row.transaction_id)
  }

  const supplierPayments = await fetchAllRows<{ id: string; transaction_id: string | null }>(({ from, to }) =>
    supabase.from('supplier_invoice_payments').select('id, transaction_id')
      .eq('journal_entry_id', journalEntryId).not('transaction_id', 'is', null)
      .order('id', { ascending: true }).range(from, to),
  )
  for (const row of (supplierPayments ?? []) as { transaction_id: string | null }[]) {
    if (row.transaction_id && !bank.has(row.transaction_id)) indirectIds.add(row.transaction_id)
  }

  // 5. Resolve the indirect ids, company-scoped: a payment row is not itself
  // company-keyed, so the transaction lookup is where the tenant check lives.
  if (indirectIds.size > 0) {
    for (const ids of chunk(Array.from(indirectIds), 200)) {
      const rows = await fetchAllRows<BankTransactionRow>(({ from, to }) =>
        supabase.from('transactions').select(BANK_COLUMNS)
          .eq('company_id', companyId).in('id', ids)
          .order('id', { ascending: true }).range(from, to),
      )
      for (const row of (rows ?? []) as BankTransactionRow[]) {
        bank.set(row.id, toBankRef(row))
      }
    }
  }

  // 6. Skattekonto rows booked from the skattekonto sync or matched by hand.
  const skv = await fetchAllRows<SkattekontoRow>(({ from, to }) =>
    supabase.from('skattekonto_transactions')
      .select('id, transaktionsdatum, transaktionstext, belopp_skatteverket')
      .eq('company_id', companyId).eq('journal_entry_id', journalEntryId)
      .order('id', { ascending: true }).range(from, to),
  )
  const skattekonto: LinkedTransactionRef[] = ((skv ?? []) as SkattekontoRow[]).map((row) => ({
    kind: 'skattekonto',
    id: row.id,
    date: row.transaktionsdatum,
    description: row.transaktionstext,
    amount: Number(row.belopp_skatteverket),
    currency: null,
  }))

  return [...bank.values(), ...skattekonto].sort(
    (a, b) => b.date.localeCompare(a.date) || a.description.localeCompare(b.description, 'sv'),
  )
}
