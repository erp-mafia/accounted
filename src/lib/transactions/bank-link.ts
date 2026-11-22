/**
 * The one "link a bank row to a posted verifikat" core.
 *
 * Two doors link a bank transaction to a verifikat that already exists:
 * manualLink (lib/reconciliation/bank-reconciliation.ts: the reconciliation
 * page, the account-keyed reconciliation, confirmed suggestions, the auto-link
 * after an invoice is linked to its voucher) and linkTransactionToJournalEntry
 * (lib/transactions/link-journal-entry.ts: the duplicate-payment dialog, v1,
 * the MCP tool and its approval). Both validate the pair with prepareBankLink
 * and write the pointer with writeBankLink, so a pair one door refuses the
 * other refuses too. What differs stays with the door: manualLink stamps the
 * reconciliation method and emits transaction.reconciled; the other settles
 * an invoice on the same voucher and has a dry run.
 */
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveSettlementAccount } from '@/lib/bookkeeping/settlement-account'
import {
  describeCashAccountSiblings,
  shouldRepointToSibling,
  type CashAccountSiblings,
} from '@/lib/cash-accounts/service'
import { hasBankLineJunctionRow, isBookedFromRow } from '@/lib/transactions/is-booked'
import {
  bankLegConsumedMessage,
  bankLegDirectionMessage,
  booksDirection,
  bankLegRoom,
  fitsBankLeg,
  holdersOnAccount,
  readBankLegHolders,
} from '@/lib/transactions/voucher-bank-leg'
import type { LedgerLineAmount } from '@/lib/bookkeeping/ledger-line-amount'
import { createLogger } from '@/lib/logger'
import { linkBasisColumnsFor, type LinkBasisInput } from '@/lib/links/stamp'

const log = createLogger('transactions/bank-link')

/**
 * Why a bank link was refused. Stable, so a caller branches on the code and
 * never on the Swedish sentence: the account-keyed surface
 * (lib/reconciliation/actions.ts) maps it to its pair skip codes, and
 * linkTransactionToJournalEntry maps it to its structured error codes.
 * Before the codes, every refusal read as "the amounts do not close", which
 * sent an agent with a mistyped verifikat id off to book a residual.
 */
export type BankLinkRefusalCode =
  | 'TRANSACTION_NOT_FOUND'
  /** Bound to a cash account on another ledger account than the one reconciled. */
  | 'TRANSACTION_OTHER_ACCOUNT'
  | 'TRANSACTION_IGNORED'
  | 'TRANSACTION_ALREADY_LINKED'
  /** The row's bank account is in another currency than the row. */
  | 'CURRENCY_MISMATCH'
  | 'ENTRY_NOT_FOUND'
  /** A draft or a cancelled draft: not in the ledger. */
  | 'ENTRY_NOT_POSTED'
  | 'ENTRY_REVERSED'
  /** An opening balance or a storno: isBankMovementEntry. */
  | 'ENTRY_NOT_BANK_MOVEMENT'
  /** The verifikat does not settle the row on the account: no line there, or the amounts differ. */
  | 'NOT_SETTLED'
  /** A 1:N request that is not a split: a verifikat twice, fewer than two, more than 50. */
  | 'INVALID_SPLIT'
  /** Someone else linked the row between the read and the write. */
  | 'LINK_RACE'
  /**
   * The database's bank-anchor guard refused the write (PT409 BANK_ANCHOR_*,
   * 20260921183218, 20261006121001, 20261006121004): a verifikat does not
   * book the row, or its 1:N slice, on the bank ledger in that direction,
   * slices against the row's direction do not add up to it, or the row's
   * bank account binding does not allow the link. Retrying the same request
   * cannot succeed.
   */
  | 'BANK_ANCHOR_REFUSED'
  /**
   * A 1:N slice asks a verifikat for more than other bank rows' slices leave
   * of it on the account (or nothing is left at all).
   */
  | 'OVER_ALLOCATED'
  /**
   * The verifikat's bank leg on the account is already taken, in the row's
   * direction, by other rows (pointers and bank_line slices): the row does
   * not fit in what is left (lib/transactions/voucher-bank-leg.ts, GitHub
   * #3507). N:1 rows that together stay within the leg still link.
   */
  | 'VOUCHER_BANK_LEG_CONSUMED'
  | 'WRITE_FAILED'

/**
 * Is `journalEntryId` a LIVE link, i.e. does it reference a posted verifikat?
 *
 * A transaction can carry a non-null `journal_entry_id` that no longer points
 * at a live booking: reversing (storno) or correcting an entry marks the
 * original `reversed`, and while both flows try to detach or re-point the
 * transaction (engine.ts `reverseEntry`, storno-service `relinkTransactions-
 * ToEntry`), those re-links are best-effort and rows reversed before #726
 * (2026-06-15) were never touched at all. Such a transaction reads as "utan
 * koppling" in the UI: the transactions page enriches only `status='posted'`
 * links, so a reversed pointer renders as no link, yet the raw column is still
 * set.
 *
 * The "already linked" guards on the re-booking paths must mirror that same
 * posted-only predicate. If they treat any non-null pointer as linked, a
 * transaction the UI shows as free can never be re-linked or re-categorized
 * (issue #988). Returns true ONLY when the pointer references a posted entry;
 * null / missing / reversed / cancelled / draft all count as no live link, so
 * the caller may overwrite the stale pointer. Fails closed (returns true) on a
 * read error so a transient lookup blip can never detach a genuinely live link.
 */
export async function hasLiveJournalEntryLink(
  supabase: SupabaseClient,
  companyId: string,
  journalEntryId: string | null | undefined,
): Promise<boolean> {
  if (!journalEntryId) return false
  const { data, error } = await supabase
    .from('journal_entries')
    .select('status')
    .eq('id', journalEntryId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) return true
  return data?.status === 'posted'
}

export interface BankLinkEntry {
  id: string
  status: string
  voucher_series: string | null
  voucher_number: number | null
  entry_date: string
  /** Where the verifikat came from: 'bank_transaction' + this row's id when it was booked from the row. */
  source_type?: string | null
  source_id?: string | null
}

export type PreparedBankLink =
  | {
      ok: true
      /** The transaction row as read with the caller's columns. */
      tx: Record<string, unknown>
      entry: BankLinkEntry
      /** The ledger account the link settles on. */
      accountNumber: string
      /** Set when the voucher's bank leg sits on a sibling ledger the row moves to. */
      repointCashAccountId: string | null
      /** The pointer the write locks on: null, or a stale reversed-entry id. */
      previousJournalEntryId: string | null
    }
  | {
      ok: false
      code: BankLinkRefusalCode
      error: string
      /** The live link that blocks this one (TRANSACTION_ALREADY_LINKED). */
      existingJournalEntryId?: string
      /** The verifikat's status (ENTRY_NOT_POSTED, ENTRY_REVERSED). */
      entryStatus?: string
      /** VOUCHER_BANK_LEG_CONSUMED: what the verifikat books in the row's direction, what other rows hold, what is left. */
      bankLeg?: { booked: number | null; held: number; remaining: number | null }
    }

function refusal(
  code: BankLinkRefusalCode,
  error: string,
  extra: {
    existingJournalEntryId?: string
    entryStatus?: string
    bankLeg?: { booked: number | null; held: number; remaining: number | null }
  } = {},
): Extract<PreparedBankLink, { ok: false }> {
  return { ok: false, code, error, ...extra }
}

const ALREADY_LINKED = 'Transaktionen är redan kopplad till en verifikation.'

/**
 * Can this verifikat be a bank row's movement? An opening balance predates
 * the feed (a link to one is a permanent phantom difference) and a storno
 * cancels a verifikat, so neither is a match candidate, and neither may be
 * named by id. The database refuses the same pair at the write
 * (block_transaction_link_to_opening_balance), where the answer was only "try
 * again". A verifikat labelled opening_balance off a fiscal year's first day
 * (marked as IB before 20261006121003) is listed among the verifikat without
 * a bank row since 20261122160000, so the bridge can name it, but it stays
 * refused here and at the write.
 */
export function isBankMovementEntry(entry: { source_type?: string | null }): boolean {
  return entry.source_type !== 'opening_balance' && entry.source_type !== 'storno'
}

/**
 * Every check a bank link needs, on reads only.
 *
 * `accountNumber` is the ledger account the link settles on: the account
 * being reconciled, or null for the row's own bank account (its cash
 * account's ledger, or for a row without one the company's account in the
 * row's currency, resolveSettlementAccount). `txColumns` is the caller's
 * column list on transactions; it must include amount, journal_entry_id,
 * is_ignored, cash_account_id and currency. `bankLegOverrun` is a signed
 * amount the row may take beyond the verifikat's bank leg because the same
 * act books it (the residual of bookResidualAndLink); never a default.
 */
export async function prepareBankLink(
  supabase: SupabaseClient,
  companyId: string,
  params: {
    transactionId: string
    journalEntryId: string
    accountNumber: string | null
    txColumns: string
    bankLegOverrun?: number
  },
): Promise<PreparedBankLink> {
  const { transactionId, journalEntryId } = params

  // The junction rows ride along on the same read: a row split over several
  // verifikat (linkTransactionToVouchers) or bulk-booked into a
  // samlingsverifikat carries journal_entry_id = NULL, and the pointer alone
  // would let it be linked a second time. Only 'bank_line' rows count: they
  // are the slices that explain the row's bank amount. A residual booking's
  // row (role 'other') is supplementary and must not strand the row after a
  // storno of its main verifikat nulls the pointer.
  const { data: txRow, error: txError } = await supabase
    .from('transactions')
    .select(`${params.txColumns}, transaction_voucher_links(journal_entry_id, role)`)
    .eq('id', transactionId)
    .eq('company_id', companyId)
    .single()

  if (txError || !txRow) {
    return refusal('TRANSACTION_NOT_FOUND', 'Transaktionen kunde inte hittas.')
  }
  const { transaction_voucher_links: junctionRows, ...tx } = txRow as unknown as Record<string, unknown> & {
    transaction_voucher_links?: Array<{ journal_entry_id: string; role?: string | null }> | null
  }
  if (hasBankLineJunctionRow(junctionRows)) {
    const bankLine = junctionRows!.find((row) => (row.role ?? 'bank_line') === 'bank_line')!
    return refusal('TRANSACTION_ALREADY_LINKED', ALREADY_LINKED, {
      existingJournalEntryId: bankLine.journal_entry_id,
    })
  }
  // An ignored row can never carry a link (CHECK transactions_is_ignored_no_
  // journal_entry): refused by name here, where the UPDATE used to fail on
  // the constraint with a "Försök igen" that no retry can satisfy.
  if (tx.is_ignored === true) {
    return refusal('TRANSACTION_IGNORED', 'Transaktionen är ignorerad. Återställ den innan du kopplar.')
  }

  // Only a LIVE (posted) pointer blocks re-linking. A transaction still pointing
  // at a 'reversed' entry (storno/correction left the link behind) reads as
  // "utan koppling" in the UI, so it must be re-linkable to another verifikat
  // (issue #988). The stale pointer is overwritten by the locked UPDATE.
  if (
    typeof tx.journal_entry_id === 'string' &&
    (await hasLiveJournalEntryLink(supabase, companyId, tx.journal_entry_id))
  ) {
    return refusal('TRANSACTION_ALREADY_LINKED', ALREADY_LINKED, { existingJournalEntryId: tx.journal_entry_id })
  }

  const { data: entry, error: entryError } = await supabase
    .from('journal_entries')
    .select('id, status, voucher_series, voucher_number, entry_date, source_type, source_id')
    .eq('id', journalEntryId)
    .eq('company_id', companyId)
    .single()

  if (entryError || !entry) {
    return refusal('ENTRY_NOT_FOUND', 'Verifikationen kunde inte hittas.')
  }
  if (entry.status === 'reversed') {
    return refusal('ENTRY_REVERSED', 'Verifikationen är makulerad och kan inte kopplas.', {
      entryStatus: entry.status as string,
    })
  }
  if (entry.status !== 'posted') {
    return refusal('ENTRY_NOT_POSTED', 'Verifikationen är inte bokförd ännu.', { entryStatus: entry.status as string })
  }
  if (!isBankMovementEntry(entry)) {
    return refusal('ENTRY_NOT_BANK_MOVEMENT', 'Verifikationen är en ingående balans eller en storno och kan inte kopplas.')
  }

  const cashAccountId = typeof tx.cash_account_id === 'string' ? tx.cash_account_id : null
  let accountNumber = params.accountNumber
  if (accountNumber === null) {
    // The row's own bank account. The link anchors the row on that ledger
    // (bank_anchor_settlement_account), which refuses an account in another
    // currency than the row: asked here, the refusal is a code on a dry run
    // and an approval alike instead of a database error at the write
    // (feedback seq 753539).
    try {
      accountNumber = await resolveSettlementAccount(
        supabase,
        companyId,
        cashAccountId,
        log,
        (tx.currency as string | null) ?? 'SEK',
      )
    } catch (err) {
      if ((err as { code?: string }).code !== 'BANK_BOOKING_CURRENCY_MISMATCH') throw err
      return refusal('CURRENCY_MISMATCH', (err as Error).message)
    }
  } else if (cashAccountId) {
    // Defense-in-depth: the transaction must belong to the account being
    // reconciled. A transaction bound to 1930 must not be linked against a
    // 1931 voucher even if the caller passes accountNumber=1931. Legacy rows
    // with no cash_account_id fall through (the UI list already gates them
    // by currency).
    const { data: txCa } = await supabase
      .from('cash_accounts')
      .select('ledger_account')
      .eq('id', cashAccountId)
      .eq('company_id', companyId)
      .maybeSingle()
    if (txCa?.ledger_account && txCa.ledger_account !== accountNumber) {
      return refusal('TRANSACTION_OTHER_ACCOUNT', `Transaktionen hör till ${txCa.ledger_account}, inte ${accountNumber}`)
    }
  }

  // Sibling ledgers of the SAME physical account (rows sharing the IBAN, in
  // the same currency) are additionally accepted for the voucher-line check
  // below: a transaction stranded on an orphaned reconnect row (e.g. 1931)
  // must be linkable to the verifikat booked on the live ledger of that same
  // account (e.g. 1940), issue #1643 problem 1. Unrelated accounts, and the
  // other currency pockets of a multi-currency account (same IBAN, other
  // currency), stay rejected.
  let allowedLineAccounts: string[] = [accountNumber]
  let siblingInfo: CashAccountSiblings | null = null
  if (cashAccountId) {
    siblingInfo = await describeCashAccountSiblings(supabase, companyId, cashAccountId)
    if (siblingInfo && siblingInfo.siblings.length > 0) {
      allowedLineAccounts = [...new Set([accountNumber, ...siblingInfo.siblings.map((row) => row.ledger_account)])]
    }
  }

  // The verifikat must have a line on the settlement account (or a sibling
  // ledger of the same physical account, see above). The old "any 19xx line"
  // check let a 1930 transaction link to a voucher that only touched 1931: a
  // cross-account link that silently hides a real imbalance.
  // currency + amount_in_currency: the room check below measures the line in
  // the row's own currency (ledgerLineAmountIn).
  const { data: lines } = await supabase
    .from('journal_entry_lines')
    .select('debit_amount, credit_amount, account_number, currency, amount_in_currency')
    .eq('journal_entry_id', journalEntryId)
    .in('account_number', allowedLineAccounts)

  if (!lines || lines.length === 0) {
    return refusal('NOT_SETTLED', `Verifikationen saknar rad på ${allowedLineAccounts.join(' eller ')}`)
  }

  // When the voucher's bank leg sits on a SIBLING ledger only, the row moves
  // to that sibling in the same write that links it: siblings are the same
  // physical account in the same currency, and the voucher is the source of
  // truth for where the money was booked. A cross-account link would leave
  // the money on one ledger while the voucher settles on the other, and the
  // account-keyed reconciliation would count it as an imbalance on BOTH
  // accounts. Same gate as PATCH /api/transactions/[id]/cash-account: the row
  // is unbooked by construction (the locked UPDATE asserts that). This covers
  // the stranded row linking to the live ledger, two live twins of one
  // connection, and two demoted rows after a full disconnect. The decision is
  // about the DESTINATION: the row moves when the sibling is live, or when
  // its own holder is definitively gone (demoted to manual or revoked) and no
  // other sibling is live either. A row whose connection is merely
  // expired/error/pending is still the syncing account (re-auth renews it in
  // place), so a voucher booked ONLY on a dead sibling is REFUSED: the voucher
  // is what is wrong, moving the row would strand it on the orphan the moment
  // consent is renewed, and writing the link anyway would be the
  // cross-account link the line check above exists to refuse. The same rule
  // keeps a live row from being parked on a row no connection can sync again.
  // A voucher touching several sibling ledgers (an old "transfer" between two
  // rows of one physical account) is judged on the best of them, never on
  // whichever line the query happened to return first: a live sibling wins,
  // else the first sibling the row may move to.
  const typedLines = lines as Array<LedgerLineAmount & { account_number: string }>
  let repointCashAccountId: string | null = null
  // The ledger the row settles on once linked: its own, or the sibling it moves to.
  let settlingLedger = accountNumber
  if (!typedLines.some((line) => line.account_number === accountNumber)) {
    const siblingLedgers = [...new Set(typedLines.map((line) => line.account_number))]
    const candidates = siblingLedgers
      .map((ledger) => siblingInfo?.siblings.find((row) => row.ledger_account === ledger) ?? null)
      .filter((row): row is NonNullable<typeof row> => row !== null)
      .filter((row) => siblingInfo !== null && shouldRepointToSibling(siblingInfo, row))
    const destination = candidates.find((row) => row.live) ?? candidates[0] ?? null
    if (!destination) {
      log.warn('refused a link to a voucher booked only on a dead sibling ledger', {
        companyId,
        transactionId,
        accountNumber,
        siblingLedgers,
      })
      return refusal(
        'NOT_SETTLED',
        `Verifikationen är bokförd på ${siblingLedgers.join(' och ')}, som inte är transaktionens konto (${accountNumber}). Rätta verifikationen eller flytta transaktionen först.`,
      )
    }
    repointCashAccountId = destination.id
    settlingLedger = destination.ledger_account
  }

  // N:1 is allowed: several bank transactions may settle ONE verifikat (a
  // salary run paid out in several transfers, a supplier invoice paid in
  // instalments), but only within what the verifikat books on the account.
  // A row that does not fit in what other rows leave of the bank leg is a
  // separate affärshändelse, not another part of this one: linking it showed
  // it as booked while its sale and moms were never booked, and the only
  // trace was an unexplained difference on the status card (GitHub #3507).
  // The first row in a direction links whatever its size, as before (a lone
  // öresavrundning difference stays on the status card). The room is the
  // shared rule of every linking door (lib/transactions/voucher-bank-leg.ts).
  // A given transaction still can't be double-linked: the pointer and
  // junction guards above block that.
  const held = await readBankLegHolders(supabase, companyId, [journalEntryId], [transactionId])
  if (!held.ok) {
    return refusal('WRITE_FAILED', 'Kunde inte läsa verifikationens befintliga kopplingar. Försök igen.')
  }
  const currency = (tx.currency as string | null) || 'SEK'
  const holders = held.holders.get(journalEntryId) ?? []
  // A row with no cash account (legacy) settles on the ledger resolved above;
  // the rows bound to that ledger's cash account hold it as well.
  let settlingCashAccountId = repointCashAccountId ?? cashAccountId
  if (settlingCashAccountId === null && holders.some((holder) => holder.cashAccountId !== null)) {
    const { data: ledgerAccount } = await supabase
      .from('cash_accounts')
      .select('id')
      .eq('company_id', companyId)
      .eq('ledger_account', settlingLedger)
      .maybeSingle()
    settlingCashAccountId = (ledgerAccount as { id?: string } | null)?.id ?? null
  }
  const room = bankLegRoom(
    typedLines.filter((line) => line.account_number === settlingLedger),
    holdersOnAccount(holders, { cashAccountId: settlingCashAccountId, currency }),
    currency,
  )
  const amount = Number(tx.amount)
  const voucherLabel = entry.voucher_number != null ? formatVoucher(entry) : journalEntryId
  // The bank-anchor guard's question, asked before the write so the refusal
  // names the verifikat and the way through, and so a dry run of this door
  // says what the write would (crm#1583).
  if (!booksDirection(room, amount)) {
    return refusal(
      'BANK_ANCHOR_REFUSED',
      bankLegDirectionMessage({ voucherLabel, accountNumber: settlingLedger, amount }),
    )
  }
  const verdict = fitsBankLeg(room, amount, params.bankLegOverrun ?? 0)
  if (!verdict.fits) {
    log.warn('refused a link to a verifikat whose bank leg other rows already hold', {
      companyId,
      transactionId,
      journalEntryId,
      settlingLedger,
      remaining: verdict.remaining,
    })
    return refusal(
      'VOUCHER_BANK_LEG_CONSUMED',
      bankLegConsumedMessage({ voucherLabel, accountNumber: settlingLedger, amount, verdict }),
      { bankLeg: { booked: verdict.booked, held: verdict.held, remaining: verdict.remaining } },
    )
  }

  return {
    ok: true,
    tx,
    entry: entry as unknown as BankLinkEntry,
    accountNumber,
    repointCashAccountId,
    previousJournalEntryId: typeof tx.journal_entry_id === 'string' ? tx.journal_entry_id : null,
  }
}

/** The reconciliation_method writeBankLink records for a row on this verifikat. */
export function bankLinkMethod(entry: BankLinkEntry, transactionId: string): 'manual' | null {
  return isBookedFromRow(entry, transactionId) ? null : 'manual'
}

export type BankLinkWrite =
  | { ok: true }
  /** Someone else changed the pointer between the read and the write. */
  | { ok: false; race: true }
  | { ok: false; race: false; error: { code?: string | null; message: string } }

/**
 * Write the pointer prepareBankLink validated. The write re-checks that
 * pointer inside the write itself (the read is advisory): null for a free
 * row, or the exact stale 'reversed'-entry id being detached. Locking on the
 * known value lets the stale-pointer overwrite through while a concurrent
 * re-link becomes a no-op (0 rows, `race`). `fields` are the door's own
 * columns (the invoice pointer and cleared hints); `linkBasis` is why the
 * door links the pair (src/lib/links/link-basis.ts).
 *
 * A row written here points at a verifikat that existed before the link, so
 * it is a reconciliation link: reconciliation_method 'manual', the marker
 * koppla-bort (isUnlinkableBankLink) and the match routes read to tell a link
 * from a booking made from the row. The duplicate dialog's door once left it
 * NULL, and its links then read as bookings that could not be unlinked (PH 194).
 * The one exception is a row put back on the verifikat booked from it (its
 * source is this row): that restores the booking, which records no method.
 */
export async function writeBankLink(
  supabase: SupabaseClient,
  companyId: string,
  params: {
    transactionId: string
    journalEntryId: string
    prepared: Extract<PreparedBankLink, { ok: true }>
    fields?: Record<string, unknown>
    /** Why the row is linked to this verifikat (transactions.link_basis); the door's own basis. */
    linkBasis: LinkBasisInput
  },
): Promise<BankLinkWrite> {
  const { transactionId, journalEntryId, prepared } = params
  const linkUpdate = supabase
    .from('transactions')
    .update({
      journal_entry_id: journalEntryId,
      is_business: true,
      reconciliation_method: bankLinkMethod(prepared.entry, transactionId),
      ...(params.fields ?? {}),
      ...linkBasisColumnsFor(params.linkBasis),
      ...(prepared.repointCashAccountId ? { cash_account_id: prepared.repointCashAccountId } : {}),
    })
    .eq('id', transactionId)
    .eq('company_id', companyId)
  const { data: updatedRows, error: updateError } = await (prepared.previousJournalEntryId === null
    ? linkUpdate.is('journal_entry_id', null)
    : linkUpdate.eq('journal_entry_id', prepared.previousJournalEntryId)
  ).select('id')

  if (updateError) {
    return { ok: false, race: false, error: { code: updateError.code, message: updateError.message } }
  }
  if (!updatedRows || updatedRows.length === 0) {
    return { ok: false, race: true }
  }
  return { ok: true }
}
