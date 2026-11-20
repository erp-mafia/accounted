/**
 * Move one supplier-invoice line to another account, the way a category
 * chip works on a transaction. One implementation behind the dashboard route
 * (PATCH /api/supplier-invoices/[id]/items/[itemId]) and the v1 operation
 * and MCP tool (lib/operations/supplier-invoice-actions.ts):
 *
 *   - only while the invoice is unsettled (registered, approved, overdue);
 *     a settled invoice's lines are history;
 *   - an unbooked invoice (no registration verifikat) only changes the item
 *     row;
 *   - a posted registration verifikat is corrected INSIDE the same verifikat
 *     through the sanctioned inline rättelse RPC (correct_entry_lines_inline,
 *     via strikeJournalEntryLines), which refuses anything outside an open,
 *     unlocked period and logs who and when (BFL 5 kap 5 §). Past a lock the
 *     refusal stands: storno is then the only lawful correction;
 *   - the item row is updated first and reverted when the correction is
 *     refused, so a refused correction leaves both sides untouched;
 *   - the moved cost keeps its kostnadsställe/projekt: the registration
 *     verifikat aggregates lines per (account, dimensions bag), so the plan
 *     only touches the lines carrying this item's bag, and every line it
 *     adds carries the bag of the lines it strikes;
 *   - the correction moves the kronor the registration booked for the line:
 *     a foreign-currency line goes through the registration's own conversion
 *     at the invoice's stored rate, and without that rate the move is
 *     refused (SI_ITEM_ACCOUNT_FX_RATE_UNKNOWN), never booked at a guess.
 *
 * A dry run reads, plans the correction and replays the RPC's rules as
 * reads (the rättelse preview); it writes nothing, not even the BAS
 * account backfill.
 */
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { roundOre } from '@/lib/money'
import { backfillStandardBASAccounts } from '@/lib/bookkeeping/account-backfill'
import {
  coerceDimensionsBag,
  dimensionsBagKey,
  mergeDimensionBags,
  normalizeLineDimensions,
  type LineDimensions,
} from '@/lib/bookkeeping/dimension-resolver'
import { strikeJournalEntryLines } from '@/lib/core/bookkeeping/journal-entry-corrections'
import {
  SupplierInvoiceFxRateMissingError,
  toSekOrThrow,
} from '@/lib/bookkeeping/supplier-invoice-entries'
import { isUnsettledSupplierInvoiceStatus } from '@/lib/supplier-invoices/lifecycle'

type Failure = Extract<OperationOutcome<never>, { ok: false }>

interface InvoiceRow {
  id: string
  status: string
  registration_journal_entry_id: string | null
  default_dimensions?: Record<string, string> | null
  currency?: string | null
  exchange_rate?: number | string | null
}

interface ItemRow {
  id: string
  account_number: string
  line_total: number | string
  description: string
  dimensions?: Record<string, string> | null
}

interface LineRow {
  id: string
  account_number: string
  debit_amount: number | string
  credit_amount: number | string
  line_description: string | null
  dimensions?: Record<string, string> | null
}

export interface PlannedLine {
  account_number: string
  debit_amount: number
  credit_amount: number
  line_description: string | null
  /** The bag of the struck line(s) this line replaces; absent when they carried none. */
  dimensions?: LineDimensions
}

/** A line's bag in canonical form, so two bags compare by content. */
function bagOf(line: LineRow): LineDimensions {
  return normalizeLineDimensions({ dimensions: line.dimensions ?? null })
}

/** True when `bag` carries every key of `subset` with the same code. */
function containsBag(bag: LineDimensions, subset: LineDimensions): boolean {
  return Object.entries(subset).every(([dimNo, code]) => bag[dimNo] === code)
}

/**
 * The bag the registration verifikat booked an item's cost with: the item's
 * own bag over the invoice's default_dimensions, merged exactly as
 * createSupplierInvoiceRegistrationEntry merges them.
 */
export function bookedItemDimensions(
  invoiceDefault: Record<string, string> | null | undefined,
  itemDimensions: Record<string, string> | null | undefined,
): LineDimensions {
  return mergeDimensionBags(coerceDimensionsBag(invoiceDefault), itemDimensions) ?? {}
}

/**
 * Plan the inline correction that moves one item's cost from its old account
 * to the new one. The registration verifikat carries the cost either as one
 * line per item or as one line per (account, dimensions bag); both shapes are
 * handled: an exact line is replaced one-for-one, an aggregate line is split
 * so the old account keeps the rest. Returns null when the entry holds
 * nothing that matches the item, which means it was corrected by hand
 * already, or when it cannot tell which lines are the item's.
 *
 * `itemDimensions` is the bag the item was booked with (bookedItemDimensions).
 * Only lines on the old account carrying it are touched, tried in order: the
 * same bag; a bag that contains it (an account dimension rule added keys at
 * booking); then any bag, which covers a line retagged after posting. The
 * first tier that holds lines decides, and only when those lines share one
 * bag: two bags on the old account with no way to tell which one is the
 * item's is refused rather than merged. The added lines carry the bag of the
 * lines they replace; lines with other bags stay as they are.
 */
export function planAccountMove(
  lines: LineRow[],
  oldAccount: string,
  newAccount: string,
  itemAmount: number,
  description: string,
  itemDimensions: LineDimensions = {},
): { strike: string[]; add: PlannedLine[] } | null {
  const amount = roundOre(Math.abs(itemAmount))
  if (amount === 0) return null
  const debitSide = itemAmount > 0
  const onOld = lines.filter((l) => l.account_number === oldAccount)
  const lineFor = (account: string, signed: number, text: string | null, bag: LineDimensions): PlannedLine => ({
    account_number: account,
    debit_amount: signed > 0 ? roundOre(signed) : 0,
    credit_amount: signed < 0 ? roundOre(-signed) : 0,
    line_description: text,
    ...(Object.keys(bag).length > 0 ? { dimensions: bag } : {}),
  })
  const isExact = (l: LineRow) => roundOre(Number(debitSide ? l.debit_amount : l.credit_amount)) === amount
  const oneBag = (group: LineRow[]) => new Set(group.map((l) => dimensionsBagKey(bagOf(l)))).size === 1

  const item = normalizeLineDimensions({ dimensions: itemDimensions })
  const tiers: Array<(bag: LineDimensions) => boolean> = [
    (bag) => dimensionsBagKey(bag) === dimensionsBagKey(item),
    (bag) => containsBag(bag, item),
    () => true,
  ]
  for (const matches of tiers) {
    const hits = onOld.filter((l) => matches(bagOf(l)))
    if (hits.length === 0) continue

    const exact = hits.filter(isExact)
    if (exact.length > 0) {
      if (!oneBag(exact)) return null
      const struck = exact[0]!
      return {
        strike: [struck.id],
        add: [lineFor(newAccount, itemAmount, struck.line_description ?? description, bagOf(struck))],
      }
    }
    if (!oneBag(hits)) return null
    const bag = bagOf(hits[0]!)
    const net = roundOre(hits.reduce((s, l) => s + Number(l.debit_amount || 0) - Number(l.credit_amount || 0), 0))
    const rest = roundOre(net - itemAmount)
    const add = [lineFor(newAccount, itemAmount, description, bag)]
    if (rest !== 0) add.unshift(lineFor(oldAccount, rest, hits[0]!.line_description, bag))
    return { strike: hits.map((l) => l.id), add }
  }
  return null
}

export interface MoveItemAccountResult {
  changed: boolean
  /** Present when changed: whether the registration verifikat was corrected inline. */
  corrected?: boolean
}

function toRattelseLines(add: PlannedLine[]) {
  return add.map((l) => ({
    account_number: l.account_number,
    debit_amount: l.debit_amount,
    credit_amount: l.credit_amount,
    ...(l.line_description != null ? { line_description: l.line_description } : {}),
    dimensions: l.dimensions ?? {},
  }))
}

export async function moveSupplierInvoiceItemAccount(
  ctx: OperationContext,
  supplierInvoiceId: string,
  itemId: string,
  accountNumber: string,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<MoveItemAccountResult>> {
  const { supabase, companyId, userId, log } = ctx

  const { data: invoice } = await supabase
    .from('supplier_invoices')
    .select('id, status, registration_journal_entry_id, default_dimensions, currency, exchange_rate')
    .eq('id', supplierInvoiceId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (!invoice) return { ok: false, code: 'SI_NOT_FOUND' }
  const inv = invoice as InvoiceRow
  if (!isUnsettledSupplierInvoiceStatus(inv.status)) {
    return { ok: false, code: 'SI_ITEM_ACCOUNT_SETTLED', details: { currentStatus: inv.status } }
  }

  // The invoice was checked against the company above; the item is scoped
  // to that invoice, so a foreign item id never matches.
  const { data: item } = await supabase
    .from('supplier_invoice_items')
    .select('id, account_number, line_total, description, dimensions')
    .eq('id', itemId)
    .eq('supplier_invoice_id', supplierInvoiceId)
    .maybeSingle()
  if (!item) return { ok: false, code: 'SI_ITEM_NOT_FOUND' }
  const row = item as ItemRow
  if (row.account_number === accountNumber) {
    if (options.dryRun) {
      return {
        ok: true,
        dryRun: true,
        preview: {
          supplier_invoice_id: supplierInvoiceId,
          supplier_invoice_item_id: itemId,
          old_account: row.account_number,
          new_account: accountNumber,
          changed: false,
          will: 'change nothing: the line is already on that account',
        },
      }
    }
    return { ok: true, data: { changed: false } }
  }

  const entryId = inv.registration_journal_entry_id
  const itemDimensions = bookedItemDimensions(inv.default_dimensions, row.dimensions)

  // What the correction strikes and adds is the SEK amount the registration
  // verifikat booked for this line: the registration's own conversion at the
  // invoice's stored rate, rounding included, never a fresh rate. A foreign
  // invoice without a usable rate cannot be matched against the verifikat
  // and is refused before anything is written.
  let bookedSek = Number(row.line_total)
  if (entryId) {
    try {
      bookedSek = toSekOrThrow(
        Number(row.line_total),
        inv.currency ?? 'SEK',
        inv.exchange_rate == null ? null : Number(inv.exchange_rate),
      )
    } catch (err) {
      if (!(err instanceof SupplierInvoiceFxRateMissingError)) throw err
      return {
        ok: false,
        code: 'SI_ITEM_ACCOUNT_FX_RATE_UNKNOWN',
        details: { journal_entry_id: entryId, currency: inv.currency ?? null },
      }
    }
  }

  if (options.dryRun) {
    const base = {
      supplier_invoice_id: supplierInvoiceId,
      supplier_invoice_item_id: itemId,
      old_account: row.account_number,
      new_account: accountNumber,
      amount: roundOre(Number(row.line_total)),
      changed: true,
    }
    if (!entryId) {
      return {
        ok: true,
        dryRun: true,
        preview: { ...base, corrects_verifikat: false, will: 'move the line; the invoice has no verifikat yet' },
      }
    }
    const planned = await planForEntry(ctx, entryId, row, accountNumber, itemDimensions, bookedSek)
    if (!planned.ok) return planned
    const rattelseLines = toRattelseLines(planned.plan.add)
    const rattelse = await strikeJournalEntryLines(
      ctx,
      entryId,
      { strike_line_ids: planned.plan.strike, lines: rattelseLines },
      { dryRun: true },
    )
    if (!rattelse.ok) return rattelse
    return {
      ok: true,
      dryRun: true,
      preview: {
        ...base,
        corrects_verifikat: true,
        journal_entry_id: entryId,
        // The kronor the correction moves (amount is in the invoice currency).
        amount_sek: roundOre(bookedSek),
        // The kostnadsställe/projekt the moved cost keeps: the bag of the
        // line it is struck from (the rättelse's added_lines carry it too).
        dimensions: rattelseLines[rattelseLines.length - 1]?.dimensions ?? {},
        rattelse: rattelse.dryRun ? rattelse.preview : null,
        will: 'move the line and correct the registration verifikat inside the same verifikat (inline rättelse, logged with who and when)',
      },
    }
  }

  await backfillStandardBASAccounts(supabase, companyId, userId, [accountNumber])

  const { data: updated, error: updateError } = await supabase
    .from('supplier_invoice_items')
    .update({ account_number: accountNumber })
    .eq('id', itemId)
    .eq('supplier_invoice_id', supplierInvoiceId)
    .select('id')
  if (updateError || !updated?.length) {
    log.warn('supplier invoice item account update refused', { itemId, message: updateError?.message })
    return { ok: false, code: 'SI_ITEM_ACCOUNT_UPDATE_FAILED' }
  }

  if (!entryId) return { ok: true, data: { changed: true, corrected: false } }

  const revert = async () => {
    await supabase
      .from('supplier_invoice_items')
      .update({ account_number: row.account_number })
      .eq('id', itemId)
      .eq('supplier_invoice_id', supplierInvoiceId)
  }

  const planned = await planForEntry(ctx, entryId, row, accountNumber, itemDimensions, bookedSek)
  if (!planned.ok) {
    await revert()
    return planned
  }

  const corrected = await strikeJournalEntryLines(ctx, entryId, {
    strike_line_ids: planned.plan.strike,
    lines: toRattelseLines(planned.plan.add),
  })
  if (!corrected.ok) {
    await revert()
    return corrected
  }
  return { ok: true, data: { changed: true, corrected: true } }
}

async function planForEntry(
  ctx: OperationContext,
  entryId: string,
  row: ItemRow,
  accountNumber: string,
  itemDimensions: LineDimensions,
  /** The line's amount as the registration booked it, in SEK. */
  bookedSek: number,
): Promise<{ ok: true; plan: { strike: string[]; add: PlannedLine[] } } | Failure> {
  const { data: lines, error: linesError } = await ctx.supabase
    .from('journal_entry_lines')
    .select('id, account_number, debit_amount, credit_amount, line_description, dimensions')
    .eq('journal_entry_id', entryId)
  if (linesError) {
    ctx.log.error('supplier invoice item move: reading the verifikat lines failed', new Error(linesError.message), {
      entryId,
    })
    return { ok: false, code: 'SI_ITEM_ACCOUNT_UPDATE_FAILED' }
  }
  const plan = planAccountMove(
    (lines ?? []) as LineRow[],
    row.account_number,
    accountNumber,
    bookedSek,
    row.description,
    itemDimensions,
  )
  if (!plan) {
    return {
      ok: false,
      code: 'SI_ITEM_ACCOUNT_NO_MATCHING_LINE',
      details: { journal_entry_id: entryId, account_number: row.account_number },
    }
  }
  return { ok: true, plan }
}
