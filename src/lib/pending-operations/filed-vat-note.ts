/**
 * A staged operation that would change the underlag for a momsdeklaration
 * already filed.
 *
 * Filing locks nothing, so the proposal can be approved while the period is
 * open, and the declaration Skatteverket holds then differs from the books
 * until a corrected one is filed. The stager is told when it stages and the
 * approver reads it on the proposal, before the click: the note is the
 * staged compliance_warning, like every other advisory on a proposal.
 *
 * Only the operation types in PLANS are judged: those whose approval posts
 * or moves lines the staged row states, on dates it states. What they post
 * is asked of the VAT block's one check
 * (lib/vat/voucher-filed-period-warning.ts), so a proposal that moves no
 * ruta of a filed period says nothing. gnubok_create_voucher is not here: the
 * confirm-before-posting guard asks it at staging and again at approval
 * (lib/bookkeeping/voucher-warnings-guard.ts). Adding a type means reading
 * its executor in ./commit.ts to the posting.
 *
 * The declaration reads a verifikat whole: whether it is a momsredovisning,
 * or an ingående balans, is decided by the verifikat, not by the lines a
 * rättelse changes. So a rättelse is judged as the verifikat before and
 * after, and the verifikat a correction touches is read for its source type,
 * only once a date is known to lie in a filed period.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { VoucherBlockWarningInput } from '@/lib/bookkeeping/voucher-block-warnings'
import type { PlausibilityLine } from '@/lib/bookkeeping/voucher-plausibility'
import type { Logger } from '@/lib/logger'
import { filedVatPeriodsOfDates, type FiledVatPeriod } from '@/lib/vat/filed-period-for-date'
import { describeFiledPeriods, filedPeriodVoucherWarning } from '@/lib/vat/voucher-filed-period-warning'

interface StagedOperation {
  operation_type: string
  params?: Record<string, unknown> | null
  preview_data?: Record<string, unknown> | null
}

/** The verifikat an operation corrects, as posted now. */
interface PostedEntry {
  source_type: string | null
  lines: PlausibilityLine[]
}

interface Plan {
  /** What the note calls the operation: "bokningen", "rättelsen", "makuleringen", "flytten", "datumändringen". */
  what: string
  /** Every date the approval posts on. */
  dates: string[]
  /** The verifikat the operation corrects, read only when a date lies in a filed period. */
  entryId: string | null
  /** What the approval posts, given that verifikat (null when there is none or it could not be read). */
  posting: (entry: PostedEntry | null) => VoucherBlockWarningInput | null
}

type Bag = Record<string, unknown>

function bag(value: unknown): Bag | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Bag) : null
}

function idOf(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** The lines a staged row states (none is an answer too), or null when they cannot be read. */
function linesOf(value: unknown): PlausibilityLine[] | null {
  if (!Array.isArray(value)) return null
  const lines: PlausibilityLine[] = []
  for (const raw of value) {
    const line = bag(raw)
    if (!line || typeof line.account_number !== 'string') return null
    lines.push({
      account_number: line.account_number,
      debit_amount: Number(line.debit_amount) || 0,
      credit_amount: Number(line.credit_amount) || 0,
    })
  }
  return lines
}

/** At least one line: a verifikat that posts nothing is not a posting. */
function postedLinesOf(value: unknown): PlausibilityLine[] | null {
  const lines = linesOf(value)
  return lines && lines.length > 0 ? lines : null
}

/** `from` with one line of the same account and amounts taken out per line in `remove`. */
function withoutLines(from: readonly PlausibilityLine[], remove: readonly PlausibilityLine[]): PlausibilityLine[] {
  const rest = [...from]
  for (const line of remove) {
    const at = rest.findIndex(
      (l) =>
        l.account_number === line.account_number &&
        l.debit_amount === line.debit_amount &&
        l.credit_amount === line.credit_amount,
    )
    if (at >= 0) rest.splice(at, 1)
  }
  return rest
}

const isOpeningBalance = (entry: PostedEntry | null) => entry?.source_type === 'opening_balance'

/** What approving each judged operation type posts, read off the staged row. */
const PLANS: Readonly<Record<string, (op: StagedOperation) => Plan | null>> = {
  // categorizeMatchedTransaction books the bank row on the row's own date
  // (preview.date) with the lines the preview states.
  categorize_transaction: (op) => {
    const date = op.preview_data?.date
    const lines = postedLinesOf(op.preview_data?.lines)
    return typeof date === 'string' && lines
      ? { what: 'bokningen', dates: [date], entryId: null, posting: () => ({ entry_date: date, lines }) }
      : null
  },
  // The storno mirrors the original on preview.reversal.entry_date.
  reverse_entry: (op) => {
    const reversal = bag(op.preview_data?.reversal)
    const lines = postedLinesOf(reversal?.lines)
    const date = reversal?.entry_date
    return typeof date === 'string' && lines
      ? {
          what: 'makuleringen',
          dates: [date],
          entryId: idOf(op.params?.entry_id),
          posting: (entry) => ({ entry_date: date, lines, opening_balance: isOpeningBalance(entry) }),
        }
      : null
  },
  // The storno takes the original out on its date and the corrected lines
  // (params.lines) go in on the same date: a staged rättelse has no own date.
  correct_entry: (op) => {
    const original = bag(op.preview_data?.original)
    const originalLines = postedLinesOf(original?.lines)
    const lines = postedLinesOf(op.params?.lines)
    const date = original?.entry_date
    return typeof date === 'string' && originalLines && lines
      ? {
          what: 'rättelsen',
          dates: [date],
          entryId: idOf(op.params?.entry_id),
          posting: (entry) => ({
            entry_date: date,
            lines,
            replaces: { entry_date: date, lines: originalLines },
            opening_balance: isOpeningBalance(entry),
          }),
        }
      : null
  },
  // Inline rättelse of lines: the verifikat as it stands (the resulting lines
  // without the added ones, with the struck ones back) is replaced by the
  // verifikat the rättelse leaves (resulting_lines), on its own date.
  correct_entry_lines_inline: (op) => {
    const preview = op.preview_data
    const resulting = postedLinesOf(preview?.resulting_lines)
    const struck = linesOf(preview?.struck_lines)
    const added = linesOf(preview?.added_lines)
    const date = preview?.entry_date
    if (typeof date !== 'string' || !resulting || !struck || !added || struck.length + added.length === 0) return null
    const before = [...withoutLines(resulting, added), ...struck]
    return {
      what: 'rättelsen',
      dates: [date],
      entryId: idOf(preview?.journal_entry_id),
      posting: (entry) => ({
        entry_date: date,
        lines: resulting,
        replaces: { entry_date: date, lines: before },
        opening_balance: isOpeningBalance(entry),
      }),
    }
  },
  // A redate posts a storno on the old date and the same lines on the new one.
  redate_entry: (op) => {
    const storno = bag(op.preview_data?.storno)
    const corrected = bag(op.preview_data?.corrected)
    const lines = postedLinesOf(corrected?.lines)
    const from = storno?.entry_date
    const to = corrected?.entry_date
    return typeof from === 'string' && typeof to === 'string' && lines
      ? {
          what: 'flytten',
          dates: [from, to],
          entryId: idOf(op.preview_data?.journal_entry_id) ?? idOf(op.params?.journal_entry_id),
          posting: (entry) => ({
            entry_date: to,
            lines,
            replaces: { entry_date: from, lines },
            opening_balance: isOpeningBalance(entry),
          }),
        }
      : null
  },
  // A date corrected inside the same verifikat: its lines leave the old date
  // and land on the new one. The staged row states the dates, not the lines.
  correct_entry_metadata: (op) => {
    const preview = op.preview_data
    const from = preview?.old_entry_date
    const to = preview?.new_entry_date
    const entryId = idOf(preview?.journal_entry_id)
    if (typeof from !== 'string' || typeof to !== 'string' || from === to || !entryId) return null
    return {
      what: 'datumändringen',
      dates: [from, to],
      entryId,
      posting: (entry) =>
        entry && entry.lines.length > 0
          ? {
              entry_date: to,
              lines: entry.lines,
              replaces: { entry_date: from, lines: entry.lines },
              opening_balance: isOpeningBalance(entry),
            }
          : null,
    }
  },
}

async function readPostedEntry(supabase: SupabaseClient, companyId: string, entryId: string): Promise<PostedEntry | null> {
  const { data, error } = await supabase
    .from('journal_entries')
    .select('source_type, lines:journal_entry_lines(account_number, debit_amount, credit_amount)')
    .eq('id', entryId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  const row = data as { source_type?: unknown; lines?: unknown } | null
  if (!row) return null
  return { source_type: typeof row.source_type === 'string' ? row.source_type : null, lines: linesOf(row.lines) ?? [] }
}

/**
 * The note for the stager and the approver, in Swedish like the proposal it
 * sits on, or null: the type is not judged, the row states no lines, no date
 * lies in a filed period, or the approval changes the underlag for no filed
 * declaration. A check that cannot be made is no note and never stops a
 * staging.
 */
export async function stagedFiledVatNote(
  supabase: SupabaseClient,
  companyId: string,
  op: StagedOperation,
  log: Pick<Logger, 'warn'>,
): Promise<string | null> {
  if (!Object.hasOwn(PLANS, op.operation_type)) return null
  try {
    const plan = PLANS[op.operation_type](op)
    if (!plan) return null
    // The cheap question first: most proposals are dated in no filed period.
    const filed = await filedVatPeriodsOfDates(supabase, companyId, plan.dates)
    if (filed.size === 0) return null
    const entry = plan.entryId ? await readPostedEntry(supabase, companyId, plan.entryId) : null
    const posting = plan.posting(entry)
    if (!posting) return null
    const warning = await filedPeriodVoucherWarning(supabase, companyId, posting)
    if (!warning) return null
    const periods = warning.details.filed_periods as FiledVatPeriod[]
    if (periods.length > 1) {
      return (
        `Momsdeklarationerna för ${describeFiledPeriods(periods, 'sv')} är redan inlämnade, ` +
        `och ${plan.what} ändrar underlaget för dem. Godkänns förslaget kan deklarationerna behöva rättas.`
      )
    }
    const [period] = periods
    return (
      `Momsdeklarationen för ${period.tax_period} är redan inlämnad (${period.filed_on}), ` +
      `och ${plan.what} ändrar underlaget för den. Godkänns förslaget kan deklarationen behöva rättas.`
    )
  } catch (err) {
    log.warn('filed VAT period note could not be read while staging', {
      operationType: op.operation_type,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}
