/**
 * The skattekonto check: Skatteverket's saldo against the booked balance of
 * the company's skattekonto account (1630, or 2012 for an enskild firma that
 * runs it in eget kapital), at the instant the saldo was fetched.
 *
 * Both figures and the bridge between them are the skattekonto
 * reconciliation's own (getSkattekontoReconciliationStatus, the Avstämning
 * page and gnubok_get_reconciliation_status): difference = saldo minus
 * booked, and the bridge names the Skatteverket events missing from the
 * books, the verifikat Skatteverket does not know, ignored events and the
 * opening difference. What the bridge leaves is the reconciliation's own
 * unexplained_difference, which is 0,00 whenever its data is consistent.
 *
 * Basis: the closing balance on 1630 is compared with the saldo on the
 * skattekontoutdrag and they must be equal (swedish-daily-bookkeeping,
 * skattekonto-and-owner; swedish-year-end-closing Phase 1: 1630 against the
 * Skatteverket kontoutdrag).
 */
import { toHandle } from '@/lib/handles'
import { roundOre } from '@/lib/money'
import { getSkattekontoReconciliationStatus, type SkattekontoReconciliationResult } from '@/lib/reconciliation/skattekonto-reconciliation'
import type { ReconciliationItem } from '@/lib/reconciliation/schemas'
import { toIsoDate } from '@/lib/dates/iso'
import { tiesOut } from '@/lib/measures/explain'
import { cannotCheck, kronor, sourceFailed, statusFor, sumOre } from '../shared'
import type { CheckBreakdown, CheckContext, CheckDefinition, CheckItem, CheckPart, CheckRun, CheckSide, CheckSource } from '../types'

const TOLERANCE = 0.005

const SKV_SOURCE: CheckSource = {
  report: 'Skatteverkets saldo på skattekontot (senaste hämtningen)',
  v1_path: '/reconciliation/accounts/skattekonto',
  mcp_tool: 'gnubok_get_reconciliation_status',
  screen: '/skattekonto',
}

const LEDGER_SOURCE: CheckSource = {
  report: 'Huvudbok, skattekontots konto (BAS 1630, eller 2012 för en enskild firma som valt det) per hämtningsdagen',
  v1_path: '/reconciliation/accounts/skattekonto',
  mcp_tool: 'gnubok_get_reconciliation_status',
  screen: '/reconciliation',
}

/** The bridge lines that explain the difference: every line but the two balances. */
const EXPLAINING_LINES = new Set(['unmatched_external', 'unmatched_ledger', 'ignored', 'opening_difference'])

function sidesOf(status: SkattekontoReconciliationResult | null): CheckSide[] {
  const account = status?.account_number ?? 'skattekontot'
  return [
    {
      key: 'skatteverket',
      label_sv: 'Saldo hos Skatteverket',
      label_en: 'Balance at Skatteverket',
      amount: status?.external_balance ?? null,
      source: SKV_SOURCE,
    },
    {
      key: 'ledger',
      label_sv: `Bokfört på ${account}`,
      label_en: `Booked on ${account}`,
      amount: status?.ledger_balance ?? null,
      source: LEDGER_SOURCE,
    },
  ]
}

async function run(ctx: CheckContext): Promise<CheckRun<SkattekontoReconciliationResult>[]> {
  const subject = { kind: 'company' } as const
  let status: SkattekontoReconciliationResult | null
  try {
    status = await getSkattekontoReconciliationStatus(ctx.supabase, ctx.companyId, { today: ctx.today })
  } catch (err) {
    return [cannotCheck(subject, ctx.today, sourceFailed('skattekonto_vs_skatteverket', 'Skattekontots avstämning', err))]
  }
  if (!status) {
    return [
      cannotCheck(subject, ctx.today, {
        code: 'SKATTEKONTO_NOT_CONNECTED',
        message_sv:
          'Skattekontot är inte kopplat och inga rader från skattekontot finns, så Skatteverkets saldo kan inte jämföras med bokföringen. Koppla Skatteverket eller importera skattekontoutdraget.',
        message_en:
          'The skattekonto is not connected and holds no rows, so Skatteverket\'s balance cannot be compared with the books. Connect Skatteverket or import the skattekonto statement.',
      }),
    ]
  }
  const fetchedAt = status.skattekonto?.fetched_at ?? null
  const asOf = fetchedAt ? toIsoDate(new Date(fetchedAt)) : ctx.today
  if (status.external_balance === null || !fetchedAt) {
    return [
      cannotCheck(
        subject,
        asOf,
        {
          code: 'NO_SKATTEVERKET_BALANCE',
          message_sv:
            'Skatteverkets saldo har aldrig hämtats, så skattekontot kan inte stämmas av. Hämta saldot via kopplingen till Skatteverket.',
          message_en: 'Skatteverket\'s balance has never been fetched, so the skattekonto cannot be reconciled. Fetch it through the Skatteverket connection.',
        },
        sidesOf(status),
      ),
    ]
  }
  if (status.ledger_read_failed || status.difference === null) {
    return [
      cannotCheck(
        subject,
        asOf,
        {
          code: 'SOURCE_FAILED',
          message_sv: 'Bokföringen på skattekontots konto gick inte att läsa, så kontrollen kunde inte köras. Försök igen om en stund.',
          message_en: 'The ledger on the skattekonto account could not be read, so the check could not run. Try again shortly.',
          retryable: true,
          details: { report: 'Skattekontots avstämning' },
        },
        sidesOf(status),
      ),
    ]
  }
  const difference = roundOre(status.difference)
  const result = statusFor(difference, TOLERANCE)
  return [
    {
      subject,
      status: result,
      difference,
      as_of: asOf,
      summary_sv:
        result === 'ok'
          ? `Skattekontot stämmer: ${status.account_number} har samma saldo som Skatteverket ${asOf}.`
          : `Skatteverket visade ${kronor(status.external_balance)} ${asOf} men ${status.account_number} har ${kronor(status.ledger_balance ?? 0)} bokfört: differens ${kronor(difference)}.`,
      sides: sidesOf(status),
      refusal: null,
      facts: {
        account_number: status.account_number,
        saldo_fetched_at: fetchedAt,
        stale: status.stale,
        ...(status.counts.unmatched_external + status.counts.proposed > 0
          ? { events_missing_in_books: status.counts.unmatched_external + status.counts.proposed }
          : {}),
      },
      source: status,
    },
  ]
}

function itemOf(item: ReconciliationItem, part: string): CheckItem {
  const external = item.side === 'external'
  return {
    part,
    item_type: external ? 'skattekonto_transaction' : 'journal_line',
    ...(external ? { skattekonto_transaction_id: item.item_id } : { journal_entry_id: item.item_id }),
    handle: external ? null : toHandle('journal_entry', item.item_id),
    date: item.date,
    label: external
      ? item.description
      : `${item.voucher_series ?? ''}${item.voucher_number ?? ''} ${item.description}`.trim(),
    // An event on Skatteverket's side moves the saldo, a verifikat moves the books: the saldo minus the books.
    amount: roundOre(external ? item.amount : -item.amount),
    currency: item.currency,
  }
}

async function explain(_ctx: CheckContext, run: CheckRun<SkattekontoReconciliationResult>): Promise<CheckBreakdown> {
  const status = run.source
  if (!status || run.difference === null) return { parts: [], items: [], residual: null, reconciles: false }
  const parts: CheckPart[] = status.bridge
    .filter((line) => EXPLAINING_LINES.has(line.key))
    .map((line) => ({
      key: line.key,
      label_sv: line.label_sv,
      label_en: line.label_en,
      // The bridge walks from the saldo down to the books; the difference is the saldo minus the books.
      amount: roundOre(-line.amount),
      count: line.count ?? 0,
    }))
  const items: CheckItem[] = [
    ...status.items.unmatched_external.map((i) => itemOf(i, 'unmatched_external')),
    ...status.items.proposed.map((i) => itemOf(i, 'unmatched_external')),
    ...status.items.unmatched_ledger.map((i) => itemOf(i, 'unmatched_ledger')),
    ...status.items.ignored.map((i) => itemOf(i, 'ignored')),
  ].sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '') || a.label.localeCompare(b.label))
  const explained = sumOre(parts.map((p) => p.amount))
  const residual = status.unexplained_difference ?? roundOre(run.difference - explained)
  const reconciles = tiesOut(explained, run.difference, parts.length + 1)
  const notes: string[] = []
  if (status.items_truncated.length > 0) notes.push(`Item lists capped at 500 per bucket: ${status.items_truncated.join(', ')}.`)
  if (status.stale) notes.push('The saldo is more than a week old: fetch it again before acting on a small difference.')
  if (!reconciles) {
    notes.push('The reconciliation\'s unexplained_difference is not zero: a link to a verifikat without a line on the account, or a read that disagrees with the trial balance. gnubok_get_reconciliation_status with account_key skattekonto shows it.')
  }
  return { parts, items, residual, reconciles, ...(notes.length > 0 ? { note: notes.join(' ') } : {}) }
}

export const skattekontoVsSkatteverket: CheckDefinition<SkattekontoReconciliationResult> = {
  id: 'skattekonto_vs_skatteverket',
  name_sv: 'Skattekontot mot Skatteverkets saldo',
  name_en: 'Skattekonto account against Skatteverket\'s balance',
  definition:
    'Skatteverket\'s saldo on the company\'s skattekonto at the last fetch minus the booked balance of the company\'s skattekonto account (BAS 1630, or 2012 for an enskild firma that chose eget kapital) at the end of the day of that fetch, floored at the latest ingående balans: exactly the difference of the skattekonto reconciliation (Avstämning, gnubok_get_reconciliation_status). Zero means every event on the skattekonto is booked and nothing else is. Needs the Skatteverket connection or an imported statement and a fetched saldo.',
  definition_sv:
    'Skatteverkets saldo på skattekontot vid senaste hämtningen minus bokfört saldo på skattekontots konto (BAS 1630, eller 2012 för en enskild firma) vid slutet av hämtningsdagen: samma differens som avstämningen av skattekontot. Noll betyder att varje händelse på skattekontot är bokförd och inget annat. Kräver kopplingen till Skatteverket eller ett importerat utdrag, och ett hämtat saldo.',
  basis:
    'The closing balance on 1630 is compared with the saldo on the skattekontoutdrag; they must be equal (swedish-daily-bookkeeping, skattekonto-and-owner). 1630 is reconciled against the Skatteverket kontoutdrag in Phase 1 of the bokslut (swedish-year-end-closing).',
  unit: 'SEK',
  tolerance: TOLERANCE,
  subject_kind: 'company',
  compares: [SKV_SOURCE, LEDGER_SOURCE],
  next_action: {
    message_sv:
      'Bokför eller koppla händelserna från Skatteverket som saknas i bokföringen, och granska verifikaten på skattekontot som Skatteverket inte känner till.',
    tool: 'gnubok_get_reconciliation_status',
    arguments: { account_key: 'skattekonto' },
    screen: '/skattekonto',
  },
  run,
  explain,
}
