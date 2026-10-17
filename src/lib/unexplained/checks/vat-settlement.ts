/**
 * The VAT check: a momsperiod the company has declared whose VAT accounts
 * were never moved to the redovisningskonto.
 *
 * The declared periods are the filing records (lib/vat/filing-record-store,
 * the completed moms deadline every filing path leaves: the Skatteverket
 * kvittens or a person marking it filed). Per period the check builds the
 * momsredovisning proposal the momsdeklaration page builds
 * (buildVatSettlementProposal): every 26xx account the declaration reads,
 * with its period balance, and the settlements already booked (tagged
 * vat_settlement or recognised by shape). A declared period whose accounts
 * still carry a balance and that has no posted settlement is unexplained;
 * the difference is ruta 49 as filed, the net that should sit on 2650 (att
 * betala) or 1650 (att återfå).
 *
 * Basis: at period end all 261x-264x accounts are cleared into 2650; residual
 * balances cause reconciliation failures (swedish-vat, period-end clearing),
 * and only 2650 meets the skattekonto (swedish-daily-bookkeeping). The moms
 * accounts are reconciled against the declared and transferred amounts in
 * Phase 1 of the bokslut (swedish-year-end-closing).
 */
import { fetchEntryLines, type EntryLinesQuery } from '@/lib/bookkeeping/entry-lines'
import { addDaysIso } from '@/lib/dates/iso'
import { toHandle } from '@/lib/handles'
import { roundOre } from '@/lib/money'
import { formatPeriodLabel } from '@/lib/reports/period-dates'
import { VAT_ACCOUNTS, VAT_SETTLEMENT_NET_ACCOUNTS } from '@/lib/reports/vat-declaration'
import {
  VAT_REFUND_ACCOUNT,
  VAT_ROUNDING_ACCOUNT,
  VAT_SETTLEMENT_ACCOUNT,
  buildVatSettlementProposal,
  findDraftVatSettlement,
  findPostedVatSettlement,
  type VatSettlementProposal,
} from '@/lib/reports/vat-settlement'
import { listVatFilings } from '@/lib/vat/filing-record-store'
import type { VatFilingRecord } from '@/lib/vat/filing-record'
import { cannotCheck, companyFacts, kronor, sourceFailed, sumOre } from '../shared'
import type { CheckBreakdown, CheckContext, CheckDefinition, CheckItem, CheckRun, CheckSide, CheckSource, CheckSubject } from '../types'

/** Each 26xx balance is cleared at exact öre; the proposal lists an account only above that. */
const TOLERANCE = 0.005

/** Ruta 49 is filed in whole kronor (öretal faller bort): the net may differ from the öre sum by under a krona. */
const FILED_ROUNDING = 1

/** The most recently declared periods the check reads, newest first. */
export const MAX_DECLARED_PERIODS = 6

/** How long after a period end a momsredovisning dated late is looked for. */
const LATE_SETTLEMENT_WINDOW_DAYS = 90

/** A posted verifikat dated after the period that moves moms to the settlement account. */
interface LateSettlement {
  journal_entry_id: string
  entry_date: string
  label: string
}

/**
 * Verifikat dated in the LATE_SETTLEMENT_WINDOW_DAYS after the period that
 * have the declaration's own settlement shape (a declaration account and a
 * 2650/1650 line: the net_account_shape the momsdeklaration leaves out of
 * the rutor). The proposal only looks inside the period, so a momsredovisning
 * a person dated on the filing day reads as missing there. Such a verifikat
 * may be this period's settlement or the next one's: the check names it and
 * tells the reader to look before anything is booked twice.
 */
async function lateSettlements(ctx: CheckContext, periodEnd: string): Promise<LateSettlement[]> {
  const from = addDaysIso(periodEnd, 1)
  const windowEnd = addDaysIso(periodEnd, LATE_SETTLEMENT_WINDOW_DAYS)
  const to = windowEnd < ctx.today ? windowEnd : ctx.today
  if (to < from) return []
  const declaration = new Set(VAT_ACCOUNTS)
  const net = new Set(VAT_SETTLEMENT_NET_ACCOUNTS)
  const lines = await fetchEntryLines<{
    account_number: string
    journal_entry_id: string
    journal_entries: { entry_date: string; voucher_series: string | null; voucher_number: number | null; description: string | null }
  }>({
    supabase: ctx.supabase,
    entryColumns: 'entry_date, voucher_series, voucher_number, description',
    lineColumns: 'account_number',
    filterEntries: (q: EntryLinesQuery) =>
      q
        .eq('company_id', ctx.companyId)
        .eq('status', 'posted')
        .neq('source_type', 'storno')
        .gte('entry_date', from)
        .lte('entry_date', to),
    filterLines: (q: EntryLinesQuery) => q.in('account_number', [...VAT_ACCOUNTS, ...VAT_SETTLEMENT_NET_ACCOUNTS]),
  })
  const byEntry = new Map<string, { declaration: boolean; net: boolean; head: (typeof lines)[number]['journal_entries'] }>()
  for (const line of lines) {
    const seen = byEntry.get(line.journal_entry_id) ?? { declaration: false, net: false, head: line.journal_entries }
    if (declaration.has(line.account_number)) seen.declaration = true
    if (net.has(line.account_number)) seen.net = true
    byEntry.set(line.journal_entry_id, seen)
  }
  return [...byEntry]
    .filter(([, e]) => e.declaration && e.net)
    .map(([id, e]) => ({
      journal_entry_id: id,
      entry_date: e.head.entry_date,
      label: `${e.head.voucher_series ?? ''}${e.head.voucher_number ?? ''} ${e.head.description ?? ''}`.trim(),
    }))
    .sort((a, b) => a.entry_date.localeCompare(b.entry_date))
}

interface VatSource {
  proposal: VatSettlementProposal
  late: LateSettlement[]
}

const DECLARATION_SOURCE: CheckSource = {
  report: 'Momsdeklaration, ruta 49 som deklarerad (hela kronor)',
  v1_path: '/reports/vat-declaration',
  mcp_tool: 'gnubok_get_vat_report',
  screen: '/reports/vat-declaration',
}

const SETTLEMENT_SOURCE: CheckSource = {
  report: 'Momsredovisning (förslag och bokförda momsredovisningar för perioden)',
  v1_path: '/reports/vat-declaration/settlement-proposal',
  mcp_tool: 'gnubok_get_vat_settlement_proposal',
  screen: '/reports/vat-declaration',
}

function subjectOf(record: VatFilingRecord, proposal?: VatSettlementProposal): CheckSubject {
  return {
    kind: 'vat_period',
    period_type: record.period_type,
    year: record.year,
    period: record.period,
    start: proposal?.period.start ?? record.period_start,
    end: proposal?.period.end ?? record.period_end,
    label: proposal?.period_label ?? formatPeriodLabel(record.period_type, record.year, record.period),
  }
}

function sidesOf(declared: number | null, moved: number | null): CheckSide[] {
  return [
    { key: 'declared', label_sv: 'Deklarerad moms (ruta 49)', label_en: 'Declared VAT (ruta 49)', amount: declared, source: DECLARATION_SOURCE },
    {
      key: 'settled',
      label_sv: 'Förd till redovisningskontot för moms',
      label_en: 'Moved to the VAT settlement account',
      amount: moved,
      source: SETTLEMENT_SOURCE,
    },
  ]
}

async function run(ctx: CheckContext): Promise<CheckRun<VatSource>[]> {
  const company: CheckSubject = { kind: 'company' }
  let filings: VatFilingRecord[]
  try {
    const facts = await companyFacts(ctx)
    if (!facts.vatRegistered) {
      return [
        cannotCheck(company, ctx.today, {
          code: 'NOT_VAT_REGISTERED',
          message_sv: 'Bolaget är inte registrerat för moms, så det finns ingen deklarerad moms att föra över.',
          message_en: 'The company is not registered for VAT, so there is no declared VAT to settle.',
        }),
      ]
    }
    filings = await listVatFilings(ctx.supabase, ctx.companyId)
  } catch (err) {
    return [cannotCheck(company, ctx.today, sourceFailed('vat_declared_not_settled', 'Deklarerade momsperioder', err))]
  }
  const declared = filings
    .filter((f) => f.period_end <= ctx.today)
    .sort((a, b) => b.period_end.localeCompare(a.period_end))
    .slice(0, MAX_DECLARED_PERIODS)
  if (declared.length === 0) {
    return [
      cannotCheck(company, ctx.today, {
        code: 'NO_DECLARED_PERIODS',
        message_sv:
          'Ingen momsperiod är markerad som deklarerad, så det går inte att veta vilka perioder som ska vara förda till redovisningskontot. Markera inlämnade momsdeklarationer som deklarerade.',
        message_en:
          'No momsperiod is recorded as declared, so it is unknown which periods should have been moved to the settlement account. Mark filed VAT declarations as filed.',
      }),
    ]
  }

  // Phase one: each declared period's proposal, as the momsdeklaration page builds it.
  const built = await Promise.all(
    declared.map(async (record) => {
      try {
        return { record, proposal: await buildVatSettlementProposal(ctx.supabase, ctx.companyId, record.period_type, record.year, record.period) }
      } catch (err) {
        return { record, error: err }
      }
    }),
  )
  // The settlements the proposals already attribute to a period: never a
  // candidate for another period's late momsredovisning.
  const attributed = new Set(
    built.flatMap((b) => (b.proposal ? b.proposal.existing_entries.filter((e) => e.status === 'posted').map((e) => e.id) : [])),
  )

  // Phase two: the result per period.
  return Promise.all(
    built.map(async ({ record, proposal, error }): Promise<CheckRun<VatSource>> => {
      if (!proposal) {
        return cannotCheck(subjectOf(record), record.period_end, sourceFailed('vat_declared_not_settled', 'Momsredovisningens förslag', error))
      }
      const subject = subjectOf(record, proposal)
      const posted = findPostedVatSettlement(proposal.existing_entries)
      const draft = findDraftVatSettlement(proposal.existing_entries)
      const label = proposal.period_label
      if (proposal.is_empty || posted) {
        return {
          subject,
          status: 'ok',
          difference: 0,
          as_of: proposal.period.end,
          summary_sv: posted
            ? `Momsen för ${label} är förd till redovisningskontot.`
            : `${label} har inga saldon på momskontona att föra över.`,
          sides: sidesOf(proposal.filed_net, posted ? proposal.filed_net : 0),
          refusal: null,
          facts: {
            filed_on: record.filed_on,
            ...(posted ? { settlement_journal_entry_handle: toHandle('journal_entry', posted.id) } : {}),
          },
          source: { proposal, late: [] },
        }
      }
      let late: LateSettlement[]
      try {
        late = (await lateSettlements(ctx, proposal.period.end)).filter((l) => !attributed.has(l.journal_entry_id))
      } catch (err) {
        // Without the look-ahead the period cannot be called unsettled safely.
        return cannotCheck(subject, proposal.period.end, sourceFailed('vat_declared_not_settled', 'Verifikat efter perioden', err))
      }
      const lateSentence =
        late.length > 0
          ? ` Verifikat ${late.map((l) => `${l.label.split(' ')[0]} (${l.entry_date})`).join(', ')} daterat efter perioden för moms till redovisningskontot: kontrollera om det är periodens momsredovisning innan något bokförs.`
          : ''
      return {
        subject,
        status: 'unexplained',
        difference: proposal.filed_net,
        as_of: proposal.period.end,
        summary_sv: `${label} är deklarerad ${record.filed_on} men momskontona är inte förda till redovisningskontot inom perioden: ${kronor(proposal.filed_net)} ${proposal.filed_net >= 0 ? 'att betala' : 'att få tillbaka'} saknas där.${draft ? ' Ett utkast till momsredovisning finns men är inte bokfört.' : ''}${lateSentence}`,
        sides: sidesOf(proposal.filed_net, 0),
        refusal: null,
        facts: {
          filed_on: record.filed_on,
          ...(draft ? { draft_settlement_journal_entry_handle: toHandle('journal_entry', draft.id) } : {}),
          ...(late.length > 0
            ? { possible_late_settlement_handles: late.map((l) => toHandle('journal_entry', l.journal_entry_id)) }
            : {}),
        },
        source: { proposal, late },
      }
    }),
  )
}

const NET_ACCOUNTS = new Set([VAT_SETTLEMENT_ACCOUNT, VAT_REFUND_ACCOUNT, VAT_ROUNDING_ACCOUNT])

async function explain(_ctx: CheckContext, run: CheckRun<VatSource>): Promise<CheckBreakdown> {
  if (!run.source || run.difference === null) return { parts: [], items: [], residual: null, reconciles: false }
  const { proposal, late } = run.source
  if (run.status === 'ok') {
    const posted = findPostedVatSettlement(proposal.existing_entries)
    return {
      parts: [],
      items: [],
      residual: 0,
      reconciles: true,
      ...(posted ? { note: `Booked by the settlement verifikat ${toHandle('journal_entry', posted.id)} on ${posted.entry_date}.` } : {}),
    }
  }
  // The clearing lines of the proposal: debit an output VAT account by its
  // credit balance, credit an input VAT account by its debit balance. As
  // contributions to the net that should reach 2650/1650: debit minus credit.
  const items: CheckItem[] = proposal.lines
    .filter((line) => !NET_ACCOUNTS.has(line.account_number))
    .map((line) => ({
      part: 'vat_accounts',
      item_type: 'vat_account',
      account_number: line.account_number,
      handle: null,
      date: proposal.period.end,
      label: `Konto ${line.account_number}: saldo för ${proposal.period_label}`,
      amount: roundOre(line.debit_amount - line.credit_amount),
    }))
  const explained = sumOre(items.map((i) => i.amount))
  const residual = roundOre(run.difference - explained)
  const reconciles = Math.abs(residual) < FILED_ROUNDING
  const draft = findDraftVatSettlement(proposal.existing_entries)
  const notes: string[] = []
  if (Math.abs(residual) > TOLERANCE) {
    notes.push(`The residual ${residual} is the öre the whole-krona filing drops (öretal faller bort); the momsredovisning books it on the rounding account.`)
  }
  if (draft) notes.push(`A draft settlement exists (${toHandle('journal_entry', draft.id)}): review and post it instead of booking a new one.`)
  if (late.length > 0) {
    notes.push(
      'Verifikat dated after the period move moms to the settlement account (possible_late_settlement): one may be this period\'s momsredovisning dated late. Check them before booking a settlement, which would book the period twice.',
    )
  }
  const lateItems: CheckItem[] = late.map((l) => ({
    part: 'possible_late_settlement',
    item_type: 'journal_line',
    journal_entry_id: l.journal_entry_id,
    handle: toHandle('journal_entry', l.journal_entry_id),
    date: l.entry_date,
    label: l.label,
    // Not counted: whether it settles this period is what the reader decides.
    amount: 0,
  }))
  return {
    parts: [
      {
        key: 'vat_accounts',
        label_sv: `Momskontonas saldo för ${proposal.period_label}`,
        label_en: `VAT account balances for ${proposal.period_label}`,
        amount: explained,
        count: items.length,
      },
      ...(late.length > 0
        ? [
            {
              key: 'possible_late_settlement',
              label_sv: 'Verifikat efter perioden som kan vara momsredovisningen (räknas inte)',
              label_en: 'Vouchers after the period that may be the settlement (not counted)',
              amount: 0,
              count: late.length,
            },
          ]
        : []),
    ],
    items: [...items, ...lateItems],
    residual,
    reconciles,
    ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
  }
}

export const vatDeclaredNotSettled: CheckDefinition<VatSource> = {
  id: 'vat_declared_not_settled',
  name_sv: 'Deklarerad moms som inte förts till redovisningskontot',
  name_en: 'Declared VAT not moved to the settlement account',
  definition: `Per declared momsperiod (the ${MAX_DECLARED_PERIODS} most recent periods recorded as filed, by Skatteverket's kvittens or marked by hand): unexplained when the period's VAT accounts (every 26xx account the momsdeklaration reads, output and input, own momsrutor included) still carry a balance for the period and no momsredovisning is posted for it (tagged vat_settlement or recognised by shape), exactly as the momsredovisning proposal reads it. The difference is ruta 49 as filed in whole kronor (positive = to pay): the net that should sit on the VAT settlement account (vat_settlement role, BAS 2650) or the VAT receivable (vat_receivable role, BAS 1650). Tolerance: öre per account. A posted verifikat dated in the ${LATE_SETTLEMENT_WINDOW_DAYS} days after the period with the declaration's settlement shape (a declaration account and a 2650/1650 line) that no other declared period claims is named as a possible late momsredovisning; the period stays unexplained until a person decides.`,
  definition_sv: `Per deklarerad momsperiod (de ${MAX_DECLARED_PERIODS} senast deklarerade): oförklarad när periodens momskonton (alla 26xx-konton momsdeklarationen läser) fortfarande har saldo för perioden och ingen momsredovisning är bokförd för den, precis som förslaget till momsredovisning läser det. Differensen är ruta 49 som deklarerad i hela kronor (positivt = att betala): det belopp som ska ligga på redovisningskontot för moms (BAS 2650) eller momsfordran (BAS 1650). Ett bokfört verifikat daterat inom ${LATE_SETTLEMENT_WINDOW_DAYS} dagar efter perioden som för moms till redovisningskontot nämns som en möjlig sent daterad momsredovisning.`,
  basis:
    'At period end all 261x-264x accounts are cleared into 2650; residual balances cause reconciliation failures (swedish-vat, period-end clearing). Only 2650 meets the skattekonto (swedish-daily-bookkeeping), and the moms accounts 2610-2650 are reconciled against declared and transferred amounts in Phase 1 of the bokslut (swedish-year-end-closing).',
  unit: 'SEK',
  tolerance: TOLERANCE,
  subject_kind: 'vat_period',
  compares: [DECLARATION_SOURCE, SETTLEMENT_SOURCE],
  next_action: {
    message_sv:
      'Hämta förslaget till momsredovisning för perioden och bokför det, eller bokför utkastet om ett finns.',
    tool: 'gnubok_get_vat_settlement_proposal',
    screen: '/reports/vat-declaration',
  },
  run,
  explain,
}
