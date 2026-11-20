/**
 * A storno + rättelse keeps a bank row's money on the bank row's own account.
 *
 * A bank row anchors the verifikat that books its money, and the bank says
 * which account the money moved on: the row's cash account and its ledger
 * account (bank_anchor_settlement_account, the definition the anchor guard
 * uses). correctEntry moves the row to the corrected verifikat, and
 * guard_cash_transaction_binding refuses that move when the corrected
 * verifikat no longer books the row's leg there.
 *
 * Two shapes end like that. A correction that takes the bank leg out, a
 * purchase rebooked as a supplier invoice (cost / 2440), releases the row to
 * Att bokföra, to be matched to the payment verifikat (crm#1433). A
 * correction that moves the leg to another bank account (1930 to 1931) is
 * refused here, before anything is written: the money is then booked on an
 * account the bank says it never moved on, and a released row would invite
 * booking it a second time. The inline rättelse refuses the same change
 * (correct_entry_lines_inline keeps the net of an anchored bank account),
 * and both paths read "bank account" from isBankLedgerAccount.
 *
 * Read-only. A row with no cash account, a row whose settlement account
 * cannot be resolved, or one whose original verifikat never booked its leg
 * (anchors from before the guard) is not judged: the release after the
 * correction still handles it.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CreateJournalEntryLineInput, JournalEntryLine } from '@/types'
import { CorrectionBankAccountChangedError } from '@/lib/bookkeeping/errors'

type LineAmounts = Pick<CreateJournalEntryLineInput, 'account_number'> & {
  debit_amount?: number | string | null
  credit_amount?: number | string | null
}

interface AnchoredRow {
  id: string
  amount: number
  currency: string | null
  cash_account_id: string | null
}

/**
 * A bank account for both rättelse paths (this one and the inline rättelse
 * preview, journal-entry-corrections.ts): the chart's kassa och bank class or
 * the ledger account of one of the company's cash accounts (a payment
 * provider's or the skattekonto's ledger outside that class).
 */
export function isBankLedgerAccount(account: string, cashLedgerAccounts: readonly string[]): boolean {
  return account.startsWith('19') || cashLedgerAccounts.includes(account)
}

/** The line books the row's direction on the account, as assert_bank_anchor_journal reads it. */
function booksLeg(lines: LineAmounts[], account: string, amount: number): boolean {
  return lines.some((l) => {
    if (l.account_number !== account) return false
    const debit = Number(l.debit_amount) || 0
    const credit = Number(l.credit_amount) || 0
    if (amount < 0) return credit > 0
    if (amount > 0) return debit > 0
    return credit > 0 || debit > 0
  })
}

async function loadAnchoredRows(
  supabase: SupabaseClient,
  companyId: string,
  entryId: string,
): Promise<AnchoredRow[]> {
  const [pointer, links] = await Promise.all([
    supabase
      .from('transactions')
      .select('id, amount, currency, cash_account_id')
      .eq('company_id', companyId)
      .eq('journal_entry_id', entryId),
    supabase
      .from('transaction_voucher_links')
      .select('transaction_id, allocated_amount')
      .eq('company_id', companyId)
      .eq('journal_entry_id', entryId)
      .eq('role', 'bank_line'),
  ])
  const rows = new Map<string, AnchoredRow>()
  for (const r of (pointer.data ?? []) as AnchoredRow[]) rows.set(r.id, { ...r, amount: Number(r.amount) })

  const linkRows = (links.data ?? []) as Array<{ transaction_id: string; allocated_amount: number | null }>
  const linkedIds = linkRows.map((l) => l.transaction_id).filter((id) => !rows.has(id))
  if (linkedIds.length > 0) {
    const { data } = await supabase
      .from('transactions')
      .select('id, amount, currency, cash_account_id')
      .eq('company_id', companyId)
      .in('id', linkedIds)
    for (const r of (data ?? []) as AnchoredRow[]) {
      // A 1:N slice books the row's share in the slice's direction.
      const slice = linkRows.find((l) => l.transaction_id === r.id)?.allocated_amount
      rows.set(r.id, { ...r, amount: slice != null ? Number(slice) : Number(r.amount) })
    }
  }
  return [...rows.values()]
}

/**
 * Refuse a correction that moves the bank leg of a bank row the original
 * anchors to another bank account (CorrectionBankAccountChangedError).
 */
export async function assertCorrectionKeepsBankAccount(
  supabase: SupabaseClient,
  companyId: string,
  originalEntryId: string,
  originalLines: Pick<JournalEntryLine, 'account_number' | 'debit_amount' | 'credit_amount'>[],
  correctedLines: CreateJournalEntryLineInput[],
): Promise<void> {
  const rows = await loadAnchoredRows(supabase, companyId, originalEntryId)
  if (rows.length === 0) return

  let cashLedgerAccounts: string[] | null = null
  for (const row of rows) {
    // A row with no cash account (a CSV import, say) names no account the
    // bank vouches for: its settlement account falls back to the only
    // enabled account or 1930, and a correction naming another account may
    // be the first word on where the money moved. Not judged.
    if (!row.cash_account_id) continue
    const { data: settlement, error } = await supabase.rpc('bank_anchor_settlement_account', {
      p_company_id: companyId,
      p_cash_account_id: row.cash_account_id,
      p_currency: row.currency,
    })
    if (error || typeof settlement !== 'string') continue
    if (!booksLeg(originalLines, settlement, row.amount)) continue
    if (booksLeg(correctedLines, settlement, row.amount)) continue

    if (cashLedgerAccounts === null) {
      const { data } = await supabase.from('cash_accounts').select('ledger_account').eq('company_id', companyId)
      cashLedgerAccounts = ((data ?? []) as Array<{ ledger_account: string | null }>)
        .map((r) => r.ledger_account)
        .filter((a): a is string => !!a)
    }
    const bankAccounts = cashLedgerAccounts
    const movedTo = [
      ...new Set(
        correctedLines
          .map((l) => l.account_number)
          .filter((acc) => acc !== settlement && isBankLedgerAccount(acc, bankAccounts))
          .filter((acc) => booksLeg(correctedLines, acc, row.amount)),
      ),
    ]
    if (movedTo.length === 0) continue

    throw new CorrectionBankAccountChangedError(
      settlement,
      movedTo,
      `Verifikationen är kopplad till en banktransaktion på konto ${settlement}, och banken visar att pengarna rörde sig där. ` +
        `Rättelsen flyttar beloppet till ${movedTo.join(', ')}. Behåll beloppet på ${settlement}. ` +
        'Hör banktransaktionen inte till verifikationen (till exempel en dubblett), makulera verifikationen i stället, så kommer transaktionen tillbaka till Att bokföra.',
    )
  }
}
