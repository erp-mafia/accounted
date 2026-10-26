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
 * A momsredovisning is often dated outside the period it settles: on the
 * day Skatteverket debits the net on the skattekonto, or on the first open
 * day after a closed year. A yearly filer's due date is months after the
 * period (SFL 26 kap. 33-33b §§). The proposal ties such a verifikat to the
 * period it settles by amount (lib/reports/vat-settlement-match.ts, crm#1316),
 * so the check, the momsdeklaration page and the booking guard give one
 * answer. A verifikat dated after the period that does not clear its
 * balances is named, not counted.
 *
 * Basis: at period end all 261x-264x accounts are cleared into 2650; residual
 * balances cause reconciliation failures (swedish-vat, period-end clearing).
 * 2650 then meets the skattekonto (swedish-accounting-compliance, BAS moms
 * workflow); BAS is not legally mandated, and a verifikat clearing 26xx
 * straight against the skattekonto leaves the same balances, so the
 * declaration already reads it as a momsredovisning (tax_account_shape,
 * #2805). The moms accounts are reconciled against the declared and
 * transferred amounts in Phase 1 of the bokslut (swedish-year-end-closing).
 */
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { addDaysIso } from '@/lib/dates/iso'
import { toHandle } from '@/lib/handles'
import { roundOre } from '@/lib/money'
import { formatPeriodLabel } from '@/lib/reports/period-dates'
import {
  VAT_REFUND_ACCOUNT,
  VAT_ROUNDING_ACCOUNT,
  VAT_SETTLEMENT_ACCOUNT,
  buildVatSettlementProposal,
  findDraftVatSettlement,
  findPostedVatSettlement,
  proposalBalance,
  type VatSettlementProposal,
} from '@/lib/reports/vat-settlement'
import {
  FILED_ROUNDING,
  LATE_LOOKAHEAD_DAYS,
  lateSettlementLookupEnd,
  settlementsDated,
  settlesPeriod,
  type SettlementVerifikat,
} from '@/lib/reports/vat-settlement-match'
import { listVatFilings } from '@/lib/vat/filing-record-store'
import type { VatFilingRecord } from '@/lib/vat/filing-record'
import { cannotCheck, companyFacts, kronor, sourceFailed, sumOre } from '../shared'
import type { CheckBreakdown, CheckContext, CheckDefinition, CheckItem, CheckRun, CheckSide, CheckSource, CheckSubject } from '../types'

/** Each 26xx balance is cleared at exact öre; the proposal lists an account only above that. */
const TOLERANCE = 0.005

/** The most recently declared periods the check reads, newest first. */
export const MAX_DECLARED_PERIODS = 6

const NET_ACCOUNTS = new Set([VAT_SETTLEMENT_ACCOUNT, VAT_REFUND_ACCOUNT, VAT_ROUNDING_ACCOUNT])

interface VatSource {
  proposal: VatSettlementProposal
  /** Momsredovisningar dated after the period that do not clear its balances: named, not counted. */
  late: SettlementVerifikat[]
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
  // Phase one: each declared period's proposal, as the momsdeklaration page
  // builds it. The proposal decides which momsredovisning settles the period,
  // one dated after it included (crm#1316).
  const built = await Promise.all(
    declared.map(async (record) => {
      try {
        return { record, proposal: await buildVatSettlementProposal(ctx.supabase, ctx.companyId, record.period_type, record.year, record.period) }
      } catch (err) {
        return { record, error: err }
      }
    }),
  )
  // A posted momsredovisning a declared period lists is that period's.
  const listed = new Set(built.flatMap((b) => (b.proposal?.existing_entries ?? []).filter((e) => e.status === 'posted').map((e) => e.id)))

  // Phase two: for a period still open, the verifikat dated after it that
  // move moms but do not clear its balances, named for a person to judge.
  // One that clears them exactly and still is not the period's is another
  // period's own momsredovisning (the proposal's judgement), never named.
  const open = await Promise.all(
    built.map(async ({ record, proposal, error }) => {
      if (!proposal || proposal.is_empty || findPostedVatSettlement(proposal.existing_entries)) {
        return { record, proposal, error, late: [] as SettlementVerifikat[] }
      }
      try {
        const balance = proposalBalance(proposal)
        const late = await settlementsDated(
          ctx.supabase,
          ctx.companyId,
          addDaysIso(proposal.period.end, 1),
          lateSettlementLookupEnd(proposal.period.end, proposal.entry_date),
        )
        return { record, proposal, error, late: late.filter((l) => !listed.has(l.journal_entry_id) && !settlesPeriod(l, balance)) }
      } catch (err) {
        return { record, proposal, error, late: [] as SettlementVerifikat[], lateError: err }
      }
    }),
  )

  // Phase three: the result per period.
  return open.map(({ record, proposal, error, late, lateError }): CheckRun<VatSource> => {
    if (!proposal) {
      return cannotCheck(subjectOf(record), record.period_end, sourceFailed('vat_declared_not_settled', 'Momsredovisningens förslag', error))
    }
    const subject = subjectOf(record, proposal)
    const posted = findPostedVatSettlement(proposal.existing_entries)
    const draft = findDraftVatSettlement(proposal.existing_entries)
    const label = proposal.period_label
    if (posted?.late_settlement) {
      const where = posted.late_settlement.via === 'tax_account' ? 'direkt mot skattekontot' : 'till redovisningskontot'
      return {
        subject,
        status: 'ok',
        difference: 0,
        as_of: proposal.period.end,
        summary_sv: `Momsen för ${label} är förd ${where} med verifikat ${voucherOf(posted)} (${posted.entry_date}), daterat efter perioden.`,
        sides: sidesOf(proposal.filed_net, proposal.filed_net),
        refusal: null,
        facts: {
          filed_on: record.filed_on,
          settlement_journal_entry_handle: toHandle('journal_entry', posted.id),
          settlement_dated_after_period: true,
        },
        source: { proposal, late: [] },
      }
    }
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
    if (lateError) {
      // Without the look-ahead the period cannot be called unsettled safely.
      return cannotCheck(subject, proposal.period.end, sourceFailed('vat_declared_not_settled', 'Verifikat efter perioden', lateError))
    }
    const lateSentence =
      late.length > 0
        ? ` Verifikat ${late.map((l) => `${l.label.split(' ')[0]} (${l.entry_date})`).join(', ')} daterat efter perioden för moms till redovisningskontot eller skattekontot men stämmer inte med periodens belopp: kontrollera om det är periodens momsredovisning innan något bokförs.`
        : ''
    return {
      subject,
      status: 'unexplained',
      difference: proposal.filed_net,
      as_of: proposal.period.end,
      summary_sv: `${label} är deklarerad ${record.filed_on} men momskontona är inte förda till redovisningskontot: ${kronor(proposal.filed_net)} ${proposal.filed_net >= 0 ? 'att betala' : 'att få tillbaka'} saknas där.${draft ? ' Ett utkast till momsredovisning finns men är inte bokfört.' : ''}${lateSentence}`,
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
  })
}

/** "A13": the voucher a person finds the verifikat by. */
function voucherOf(entry: { voucher_series: string | null; voucher_number: number | null }): string {
  return formatVoucher(entry)
}

async function explain(_ctx: CheckContext, run: CheckRun<VatSource>): Promise<CheckBreakdown> {
  if (!run.source || run.difference === null) return { parts: [], items: [], residual: null, reconciles: false }
  const { proposal, late } = run.source
  if (run.status === 'ok') {
    const posted = findPostedVatSettlement(proposal.existing_entries)
    const settled = posted?.late_settlement
    if (posted && settled) {
      return {
        parts: [],
        items: [],
        residual: 0,
        reconciles: true,
        note: `Booked by the settlement verifikat ${toHandle('journal_entry', posted.id)} on ${posted.entry_date}, dated after the period: it clears the period's VAT balances (${settled.cleared}) and moves ${settled.net} ${settled.via === 'tax_account' ? 'straight to the skattekonto' : 'to the settlement account'}.`,
      }
    }
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
      'Verifikat dated after the period move moms to the settlement account or the skattekonto (possible_late_settlement), but none clears exactly this period\'s balances: one may still be its momsredovisning, dated late or covering more than the period. Check them before booking a settlement, which would book the period twice.',
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
  definition: `Per declared momsperiod (the ${MAX_DECLARED_PERIODS} most recent periods recorded as filed, by Skatteverket's kvittens or marked by hand): unexplained when the period's VAT accounts (every 26xx account the momsdeklaration reads, output and input, own momsrutor included) still carry a balance for the period and no momsredovisning settles it, exactly as the momsredovisning proposal reads it. The difference is ruta 49 as filed in whole kronor (positive = to pay): the net that should sit on the VAT settlement account (vat_settlement role, BAS 2650) or the VAT receivable (vat_receivable role, BAS 1650). Tolerance: öre per account. A momsredovisning is a posted verifikat tagged vat_settlement or with either settlement shape the declaration excludes (a declaration account and a 2650/1650 line, or a pure 26xx movement against the skattekonto). Which period one settles is read by amount, as the momsredovisning proposal reads it: one inside the period settles it unless it clears exactly the previous period's balances instead (booked on that period's filing or debit day); one dated after it, up to ${LATE_LOOKAHEAD_DAYS} days, settles it when it clears exactly the period's VAT balances and moves the filed net, and it is not the own momsredovisning of the period it is dated in or of one between. Any other late one is named as a possible late momsredovisning; the period stays unexplained until a person decides.`,
  definition_sv: `Per deklarerad momsperiod (de ${MAX_DECLARED_PERIODS} senast deklarerade): oförklarad när periodens momskonton (alla 26xx-konton momsdeklarationen läser) fortfarande har saldo för perioden och ingen momsredovisning för över dem, precis som förslaget till momsredovisning läser det. Differensen är ruta 49 som deklarerad i hela kronor (positivt = att betala): det belopp som ska ligga på redovisningskontot för moms (BAS 2650) eller momsfordran (BAS 1650). En momsredovisning förs mot 2650/1650 eller direkt mot skattekontot. Ett bokfört verifikat daterat efter perioden, upp till ${LATE_LOOKAHEAD_DAYS} dagar, räknas som periodens momsredovisning när det nollar exakt periodens momssaldon och för över det deklarerade beloppet, och ett verifikat i perioden som i stället nollar exakt föregående periods saldon räknas som den periodens; andra sådana verifikat nämns som en möjlig sent daterad momsredovisning.`,
  basis:
    'At period end all 261x-264x accounts are cleared into 2650; residual balances cause reconciliation failures (swedish-vat, period-end clearing). 2650 then meets the skattekonto 1630 (swedish-accounting-compliance, BAS moms workflow); BAS is not legally mandated, and clearing 26xx straight against the skattekonto leaves the same balances. The moms accounts 2610-2650 are reconciled against declared and transferred amounts in Phase 1 of the bokslut (swedish-year-end-closing). Helårsmoms is due months after the räkenskapsår (SFL 26 kap. 33-33b §§), so its momsredovisning is often dated long after the period.',
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
