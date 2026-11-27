import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { checkPeriodLock } from '@/lib/api/v1/check-period-lock'
import { fetchChartVatTreatments } from '@/lib/bookkeeping/chart-vat-treatments'
import { resolveSekAmountOrNull } from '@/lib/bookkeeping/currency-utils'
import { findFiscalPeriod } from '@/lib/bookkeeping/engine'
import { toEntryPreview } from '@/lib/bookkeeping/entry-preview'
import { BookkeepingDatabaseError, isBookkeepingError } from '@/lib/bookkeeping/errors'
import { linkToJournalEntry } from '@/lib/core/documents/document-service'
import type { LinkBasisColumns } from '@/lib/links/link-basis'
import { linkBasisColumns } from '@/lib/links/stamp'
import { roundOre, sumOre } from '@/lib/money'
import type { OperationContext, OperationOutcome, OperationWarning } from '@/lib/operations/types'
import { mappingVersion } from '@/lib/posting/mapping-version'
import { postingPort } from '@/lib/posting/port'
import type { BusinessEventDraft } from '@/lib/posting/types'
import type { CreateJournalEntryInput, JournalEntry } from '@/types'
import { buildSpendItemEntry, evaluateSpendExpense, spendItemDescription, spendItemNotes } from './evaluate'
import { loadSpendCompanyContext } from './master-data'
import { resolveSpendSettings } from './settings'
import { evaluationContextFor, loadBookableAccounts } from './sync'
import { SPEND_ITEM_SUMMARY_COLUMNS, normalizeItemSummary, type SpendConnectionRow, type SpendItemRow } from './types'

/**
 * Book one spend expense as its verifikat (source_type spend_item), with the
 * receipt files it arrived with linked as underlag.
 *
 * Race-free the same way as POS days (lib/pos-sales/book-day.ts): draft ->
 * conditional claim of the expense row -> commit. The claim also pins the
 * archived answer's hash, so an export that replaced the expense between the
 * read and the claim makes the booking lose instead of posting what the
 * person did not see; the loser's draft is cancelled before it gets a
 * voucher number. A DB index allows one live verifikat per expense on top.
 *
 * The lines are the server's, from the stored expense and the connection's
 * settings, never the caller's. An expense waiting for review books only
 * when the person says they looked (acknowledge_review); a private purchase
 * or cash withdrawal also needs the account the person chose (debit_account).
 */

export interface BookSpendItemInput {
  item_id: string
  /** raw_sha256 of the expense the person reviewed; the booking is refused if it changed since. */
  expected_raw_sha256?: string
  /** Book an expense flagged for review; a person read the reasons. */
  acknowledge_review?: boolean
  /** For a private purchase or a cash withdrawal: the account the debit side books on. */
  debit_account?: string
}

export interface BookSpendItemResult {
  journal_entry_id: string
  voucher_series: string | null
  voucher_number: number | null
  entry_date: string
  amount: number
  linked_documents: number
}

async function loadItem(
  ctx: OperationContext,
  itemId: string,
): Promise<{ item: SpendItemRow; connection: Pick<SpendConnectionRow, 'id' | 'provider' | 'provider_name' | 'settings' | 'status'> } | null> {
  const { data: item } = await ctx.supabase
    .from('spend_items')
    .select(`${SPEND_ITEM_SUMMARY_COLUMNS}, expense`)
    .eq('id', itemId)
    .eq('company_id', ctx.companyId)
    .maybeSingle()
  if (!item) return null
  const { data: connection } = await ctx.supabase
    .from('spend_connections')
    .select('id, provider, provider_name, settings, status')
    .eq('id', (item as { connection_id: string }).connection_id)
    .eq('company_id', ctx.companyId)
    .maybeSingle()
  if (!connection) return null
  return {
    item: normalizeItemSummary(item as unknown as SpendItemRow),
    connection: connection as unknown as Pick<SpendConnectionRow, 'id' | 'provider' | 'provider_name' | 'settings' | 'status'>,
  }
}

/** Link the expense's receipts to the committed verifikat. Never throws: a missing underlag surfaces on the worklist. */
async function linkReceipts(ctx: OperationContext, item: SpendItemRow, entryId: string): Promise<number> {
  let linked = 0
  const admin = createServiceClientNoCookies()
  for (const documentId of item.document_ids) {
    try {
      // The provider delivered the receipt with the expense: the pairing came over from its records.
      await linkToJournalEntry(admin, ctx.companyId, documentId, entryId, linkBasisColumns('import_carried_over'))
      linked += 1
    } catch (err) {
      ctx.log.error('failed to link a spend receipt', err as Error, { itemId: item.id, documentId, journalEntryId: entryId })
    }
  }
  return linked
}

/**
 * The business event of a booked spend expense (kind purchase.spend_expense),
 * for the posting port: recorded while POSTING_EVENTS is shadow or strict,
 * never built while it is off. Pure. The expense's own row is named by the
 * verifikat's source_id (no typed handle yet); the first receipt is the
 * underlag the person saw.
 */
export function spendItemBusinessEvent(item: SpendItemRow, deductibleVat: number, linkBasis: LinkBasisColumns): BusinessEventDraft {
  const vatSek = resolveSekAmountOrNull(Math.abs(deductibleVat), null, item.currency, null)
  return {
    kind: 'purchase.spend_expense',
    category: null,
    occurredOn: item.expense_date,
    currency: item.currency,
    amount: Math.abs(item.amount),
    amountSek: resolveSekAmountOrNull(Math.abs(item.amount), null, item.currency, null),
    taxAmounts: vatSek !== null && vatSek > 0 ? [{ tax: 'vat', treatment: null, amount_sek: vatSek }] : [],
    evidence: {
      direction: item.amount < 0 ? 'in' : 'out',
      ...(item.document_ids[0] ? { document_id: item.document_ids[0] } : {}),
      link_basis: linkBasis.link_basis,
      link_evidence: linkBasis.link_evidence ?? undefined,
    },
    pendingOperationId: linkBasis.link_evidence?.pending_operation_id ?? null,
    mappingVersion: mappingVersion('spendExpense'),
    jurisdiction: 'SE',
  }
}

export async function bookSpendItem(
  ctx: OperationContext,
  input: BookSpendItemInput,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<BookSpendItemResult>> {
  const { supabase, companyId, userId, log } = ctx
  const loaded = await loadItem(ctx, input.item_id)
  if (!loaded) return { ok: false, code: 'SPEND_ITEM_NOT_FOUND', details: { item_id: input.item_id } }
  const { item, connection } = loaded

  if (item.journal_entry_id) return { ok: false, code: 'SPEND_ITEM_ALREADY_BOOKED', details: { journal_entry_id: item.journal_entry_id } }
  if (item.status === 'rejected' || item.status === 'no_entry') {
    return { ok: false, code: 'SPEND_ITEM_NOT_BOOKABLE', details: { status: item.status, reasons: item.reasons } }
  }
  // Received means its receipts are stored and the provider was told.
  if (item.ack_outcome !== 'received') return { ok: false, code: 'SPEND_ITEM_NOT_RECEIVED', details: { item_id: item.id } }
  if (input.expected_raw_sha256 && input.expected_raw_sha256 !== item.raw_sha256) {
    return { ok: false, code: 'SPEND_ITEM_CHANGED', details: { raw_sha256: item.raw_sha256 } }
  }

  // Everything up to the preview reads what the member may read; only the
  // claim, the booked mark and the receipt links need the server.
  const settings = resolveSpendSettings(connection.settings)
  const company = await loadSpendCompanyContext(supabase, companyId)
  const isBookableAccount = await loadBookableAccounts(supabase, companyId)
  const evaluation = evaluateSpendExpense(
    item.expense,
    await evaluationContextFor(supabase, companyId, item.expense, { isBookableAccount, company, settings, providerName: connection.provider_name }),
  )
  if (evaluation.status === 'rejected') {
    // Something changed since it arrived (the period was locked, an account was turned off).
    const reason = evaluation.reasons[0]
    if (reason?.code === 'period_locked') return { ok: false, code: 'PERIOD_LOCKED', details: { entry_date: item.expense_date } }
    return { ok: false, code: 'SPEND_ITEM_NEEDS_REVIEW', details: { reasons: evaluation.reasons } }
  }
  if (evaluation.status === 'no_entry') return { ok: false, code: 'SPEND_ITEM_NOT_BOOKABLE', details: { status: 'no_entry' } }
  if (evaluation.status === 'review' && !input.acknowledge_review) {
    return { ok: false, code: 'SPEND_ITEM_NEEDS_REVIEW', details: { reasons: evaluation.reasons } }
  }
  if (input.debit_account && !isBookableAccount(input.debit_account)) {
    return { ok: false, code: 'SPEND_DEBIT_ACCOUNT_UNKNOWN', details: { account: input.debit_account } }
  }

  const plan = buildSpendItemEntry(item.expense, {
    settings,
    vatRegistered: company.vatRegistered,
    chart: await fetchChartVatTreatments(supabase, companyId),
    ...(input.debit_account ? { debitAccount: input.debit_account } : {}),
  })
  if (plan.problems.length > 0) {
    const code = plan.problems.some((p) => p.code === 'counter_account_needed') ? 'SPEND_DEBIT_ACCOUNT_REQUIRED' : 'SPEND_ITEM_NEEDS_REVIEW'
    return { ok: false, code, details: { reasons: plan.problems } }
  }

  const verdict = await checkPeriodLock(supabase, companyId, item.expense_date)
  if (verdict.locked) return { ok: false, code: 'PERIOD_LOCKED', details: { reason: verdict.reason, entry_date: item.expense_date } }
  const fiscalPeriodId = await findFiscalPeriod(supabase, companyId, item.expense_date)
  if (!fiscalPeriodId) return { ok: false, code: 'SPEND_ITEM_NO_FISCAL_PERIOD', details: { entry_date: item.expense_date } }

  const entryInput: CreateJournalEntryInput = {
    fiscal_period_id: fiscalPeriodId,
    entry_date: item.expense_date,
    description: spendItemDescription(item.expense, connection.provider_name),
    source_type: 'spend_item',
    source_id: item.id,
    notes: spendItemNotes(item.expense, connection.provider_name),
    lines: plan.lines,
  }

  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      preview: {
        item_id: item.id,
        expense_date: item.expense_date,
        provider_name: connection.provider_name,
        raw_sha256: item.raw_sha256,
        acknowledged_reasons: evaluation.status === 'review' ? evaluation.reasons : [],
        receipts: item.document_ids.length,
        journal_entry: toEntryPreview(entryInput),
      },
    }
  }

  const admin = createServiceClientNoCookies()
  let draft: JournalEntry
  try {
    // Posting port: the engine gets entryInput unchanged; while POSTING_EVENTS
    // is shadow or strict the purchase.spend_expense event is recorded first
    // and linked to the draft, before the claim below and before a voucher
    // number is drawn.
    draft = await postingPort.draftJournalEntry({
      supabase,
      companyId,
      userId,
      // Built only while the port is on: off, the call is the one it was.
      event: () => spendItemBusinessEvent(item, plan.deductibleVat, linkBasisColumns('user_created')),
      input: entryInput,
    })
  } catch (err) {
    // The live-voucher index: another booking of this expense holds a draft or a posted verifikat.
    if (err instanceof BookkeepingDatabaseError && err.pgCode === '23505') {
      return { ok: false, code: 'SPEND_ITEM_ALREADY_BOOKED', details: { item_id: item.id } }
    }
    if (isBookkeepingError(err)) return { ok: false, code: 'SPEND_ITEM_BOOKING_FAILED', error: err }
    log.error('spend item draft failed', err as Error, { itemId: item.id })
    return { ok: false, code: 'SPEND_ITEM_BOOKING_FAILED' }
  }

  const cancelDraft = async () => {
    const { error } = await supabase.from('journal_entries').update({ status: 'cancelled' }).eq('id', draft.id).eq('status', 'draft')
    if (error) log.error('spend item draft cleanup failed', error, { entryId: draft.id })
  }

  const { data: claimed, error: claimError } = await admin
    .from('spend_items')
    .update({ journal_entry_id: draft.id })
    .eq('id', item.id)
    .eq('company_id', companyId)
    .is('journal_entry_id', null)
    .eq('raw_sha256', item.raw_sha256)
    .select('id')
  if (claimError || !claimed || claimed.length === 0) {
    await cancelDraft()
    if (claimError) {
      log.error('spend item claim failed', claimError, { itemId: item.id })
      return { ok: false, code: 'SPEND_ITEM_BOOKING_FAILED' }
    }
    // Booked by someone else, or replaced by a newer export, since our read.
    const { data: now } = await admin.from('spend_items').select('journal_entry_id, raw_sha256').eq('id', item.id).maybeSingle()
    const current = now as { journal_entry_id: string | null; raw_sha256: string } | null
    if (current?.journal_entry_id) return { ok: false, code: 'SPEND_ITEM_ALREADY_BOOKED', details: { journal_entry_id: current.journal_entry_id } }
    return { ok: false, code: 'SPEND_ITEM_CHANGED', details: { raw_sha256: current?.raw_sha256 ?? null } }
  }

  let committed: JournalEntry | null
  try {
    committed = await postingPort.commitJournalEntry({ supabase, companyId, userId, entryId: draft.id })
  } catch (err) {
    // A commit whose answer was lost may still have posted: a posted verifikat
    // keeps its link (the freeze trigger refuses the unlink anyway).
    const { data: landed } = await admin
      .from('journal_entries')
      .select('id, status, voucher_series, voucher_number')
      .eq('id', draft.id)
      .maybeSingle()
    if ((landed as { status?: string } | null)?.status === 'posted') {
      log.warn('spend item commit answered an error but the verifikat is posted', { itemId: item.id, entryId: draft.id })
      committed = landed as JournalEntry
    } else {
      await admin.from('spend_items').update({ journal_entry_id: null }).eq('id', item.id).eq('journal_entry_id', draft.id)
      await cancelDraft()
      if (isBookkeepingError(err)) return { ok: false, code: 'SPEND_ITEM_BOOKING_FAILED', error: err }
      log.error('spend item commit failed', err as Error, { itemId: item.id, entryId: draft.id })
      return { ok: false, code: 'SPEND_ITEM_BOOKING_FAILED' }
    }
  }

  const entryId = committed?.id ?? draft.id
  const { error: markError } = await admin
    .from('spend_items')
    .update({ status: 'booked', booked_at: new Date().toISOString(), booked_by: userId })
    .eq('id', item.id)
    .eq('journal_entry_id', entryId)
  if (markError) log.error('spend item booked mark failed; the verifikat link stands', markError, { itemId: item.id, entryId })

  const linked = await linkReceipts(ctx, item, entryId)
  const warnings: OperationWarning[] = []
  if (linked < item.document_ids.length) {
    warnings.push({
      code: 'SPEND_ITEM_RECEIPT_NOT_LINKED',
      message_sv: 'Verifikatet bokfördes men kvittot kunde inte kopplas. Bifoga det från verifikatet.',
      message_en: 'The voucher was booked but the receipt could not be linked. Attach it from the voucher.',
    })
  }
  return {
    ok: true,
    created: true,
    data: {
      journal_entry_id: entryId,
      voucher_series: committed?.voucher_series ?? null,
      voucher_number: committed?.voucher_number ?? null,
      entry_date: item.expense_date,
      amount: item.amount,
      linked_documents: linked,
    },
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}

/** The most expenses one batch books. */
export const SPEND_BOOK_BATCH_MAX = 50

export interface BookSpendItemsResult {
  booked: Array<{ item_id: string } & BookSpendItemResult>
  failed: Array<{ item_id: string; code: string }>
}

/**
 * Book several ready expenses, each as its own verifikat (never a gemensam
 * verifikation: card purchases are separate affärshändelser with their own
 * receipts). Only expenses that need nobody's look book here; the rest are
 * reported back with their code. Each booking stands on its own: one that
 * fails leaves the others booked.
 */
export async function bookSpendItems(
  ctx: OperationContext,
  input: { item_ids: string[] },
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<BookSpendItemsResult>> {
  const ids = [...new Set(input.item_ids)].slice(0, SPEND_BOOK_BATCH_MAX)
  const { data, error } = await ctx.supabase
    .from('spend_items')
    .select('id, status, amount, journal_entry_id')
    .eq('company_id', ctx.companyId)
    .in('id', ids)
  // A failed read is not "none ready": the person would be told every expense waits for a look.
  if (error) {
    ctx.log.error('spend batch lookup failed', error, { count: ids.length })
    return { ok: false, code: 'SPEND_READ_FAILED' }
  }
  const rows = (data ?? []) as Array<{ id: string; status: string; amount: number | string; journal_entry_id: string | null }>
  const ready = rows.filter((row) => row.status === 'ready' && !row.journal_entry_id)
  const skipped = ids.filter((id) => !ready.some((row) => row.id === id))
  if (options.dryRun) {
    // The total is what the verifikat will post, reverse-charge lines
    // included, so an unattended ceiling prices the batch as it books.
    const previews: Array<{ item_id: string; total_debit: number }> = []
    for (const row of ready) {
      const preview = await bookSpendItem(ctx, { item_id: row.id }, { dryRun: true })
      if (preview.ok && preview.dryRun) {
        const entry = preview.preview.journal_entry as { total_debit?: number } | undefined
        previews.push({ item_id: row.id, total_debit: entry?.total_debit ?? 0 })
      }
    }
    const totalDebit = roundOre(sumOre(previews.map((p) => p.total_debit)))
    return {
      ok: true,
      dryRun: true,
      preview: { item_ids: previews.map((p) => p.item_id), skipped, total_debit: totalDebit, entries: previews },
    }
  }
  const result: BookSpendItemsResult = { booked: [], failed: skipped.map((id) => ({ item_id: id, code: 'SPEND_ITEM_NOT_READY' })) }
  for (const row of ready) {
    const outcome = await bookSpendItem(ctx, { item_id: row.id })
    if (outcome.ok && !outcome.dryRun) result.booked.push({ item_id: row.id, ...outcome.data })
    else if (!outcome.ok) result.failed.push({ item_id: row.id, code: outcome.code })
  }
  return { ok: true, created: result.booked.length > 0, data: result }
}
