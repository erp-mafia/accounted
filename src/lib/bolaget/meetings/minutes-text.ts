/**
 * What each paragraph of the minutes says when no one wrote its text: the
 * sentence is composed from the decision's terms and the meeting, so the
 * minutes always match the payload the registers and the bookings read.
 * A text a person wrote wins. Swedish only, like every statutory document.
 */
import { pdfNumberText, pdfAmount } from '@/lib/pdf/number-text'
import { parseDecisionPayload } from './payloads'
import type { JusterareState } from './rules'
import type { DecisionKind, DecisionOutcome, MeetingKind, MeetingOrgan } from './types'

const INT = new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 0 })

export function formatKr(n: number): string {
  return `${pdfAmount(n)} kr`
}

export function formatInt(n: number): string {
  return pdfNumberText(INT.format(n))
}

/** "A, B och C". */
export function joinNames(names: readonly string[]): string {
  const list = names.filter(Boolean)
  if (list.length <= 1) return list[0] ?? ''
  return `${list.slice(0, -1).join(', ')} och ${list[list.length - 1]}`
}

/** The procedural items of a meeting (kind ovrigt, payload.topic). */
export const PROCEDURAL_TOPICS = [
  'oppnande',
  'val_ordforande',
  'rostlangd',
  'val_justerare',
  'kallelse',
  'dagordning',
  'framlaggande',
  'avslutande',
] as const
export type ProceduralTopic = (typeof PROCEDURAL_TOPICS)[number]

export interface MinutesTextContext {
  kind: MeetingKind
  organ: MeetingOrgan
  meeting_date: string
  kallelse_date: string | null
  kallelse_method: string | null
  chair_name: string | null
  secretary_name: string | null
  adjuster_names: string[]
  justering: JusterareState
  fiscal_period: { period_start: string; period_end: string } | null
  has_auditor: boolean
}

function subject(ctx: Pick<MinutesTextContext, 'kind' | 'organ'>): string {
  if (ctx.organ === 'styrelse') return 'Styrelsen'
  return 'Stämman'
}

function meetingWord(ctx: Pick<MinutesTextContext, 'kind' | 'organ'>): string {
  return ctx.organ === 'styrelse' ? 'mötet' : 'stämman'
}

function periodText(ctx: MinutesTextContext): string {
  return ctx.fiscal_period ? `räkenskapsåret ${ctx.fiscal_period.period_start} till ${ctx.fiscal_period.period_end}` : 'räkenskapsåret'
}

function proceduralText(topic: string | null | undefined, ctx: MinutesTextContext): string | null {
  const word = meetingWord(ctx)
  const Word = word === 'mötet' ? 'Mötet' : 'Stämman'
  switch (topic) {
    case 'oppnande':
      return `${Word} öppnades${ctx.chair_name ? ` av ${ctx.chair_name}` : ''}.`
    case 'val_ordforande':
      return [
        ctx.chair_name ? `Till ordförande vid ${word} valdes ${ctx.chair_name}.` : `Ordförande vid ${word} valdes.`,
        ctx.secretary_name ? `Till protokollförare utsågs ${ctx.secretary_name}.` : null,
      ]
        .filter(Boolean)
        .join(' ')
    case 'rostlangd':
      return 'Röstlängden enligt bilaga 1 upprättades och godkändes.'
    case 'val_justerare':
      if (ctx.adjuster_names.length > 0) {
        return `Att jämte ordföranden justera protokollet valdes ${joinNames(ctx.adjuster_names)}.`
      }
      if (ctx.justering === 'not_needed_holds_all_shares') {
        return 'Då ordföranden och protokollföraren tillsammans företrädde samtliga aktier valdes ingen justeringsperson (7 kap. 48 § aktiebolagslagen).'
      }
      if (ctx.justering === 'not_needed_single_member_board') return 'Styrelsen har en ledamot; ingen justeringsperson valdes.'
      if (ctx.justering === 'covered_by_board_signatures') return 'Protokollet justeras av de närvarande ledamöterna.'
      return 'Ingen justeringsperson valdes.'
    case 'kallelse':
      return [
        `${Word} förklarades behörigen sammankallad.`,
        ctx.kallelse_date ? `Kallelse skedde ${ctx.kallelse_date}${ctx.kallelse_method ? ` genom ${ctx.kallelse_method}` : ''}.` : null,
      ]
        .filter(Boolean)
        .join(' ')
    case 'dagordning':
      return 'Dagordningen godkändes.'
    case 'framlaggande':
      return `Årsredovisningen${ctx.has_auditor ? ' och revisionsberättelsen' : ''} för ${periodText(ctx)} lades fram.`
    case 'avslutande':
      return `${Word} avslutades.`
    default:
      return null
  }
}

/** The text of a paragraph: the person's own, else composed from its terms. */
export function decisionText(
  decision: { kind: DecisionKind; text: string | null; payload: Record<string, unknown>; outcome: DecisionOutcome },
  ctx: MinutesTextContext,
): string {
  const own = decision.text?.trim()
  if (own) return own
  const who = subject(ctx)
  if (decision.outcome === 'bordlagd') return 'Frågan bordlades.'
  if (decision.outcome === 'avslagen') return 'Förslaget avslogs.'
  switch (decision.kind) {
    case 'ovrigt': {
      const parsed = parseDecisionPayload('ovrigt', decision.payload)
      return (parsed.ok ? proceduralText(parsed.payload.topic, ctx) : null) ?? ''
    }
    case 'faststallande_rr_br':
      return `${who} fastställde resultaträkningen och balansräkningen för ${periodText(ctx)}.`
    case 'resultatdisposition': {
      const parsed = parseDecisionPayload('resultatdisposition', decision.payload)
      if (!parsed.ok) return ''
      const p = parsed.payload
      const intro = p.available_amount !== null && p.available_amount !== undefined ? `Till stämmans förfogande stod ${formatKr(p.available_amount)}. ` : ''
      const follows = p.follows_board_proposal ? 'i enlighet med styrelsens förslag ' : ''
      if (p.carried_forward !== null && p.carried_forward !== undefined) {
        const dividend = p.dividend_total && p.dividend_total > 0 ? `${formatKr(p.dividend_total)} delas ut till aktieägarna och ` : ''
        return `${intro}${who} beslutade ${follows}att ${dividend}${formatKr(p.carried_forward)} balanseras i ny räkning.`
      }
      if (p.board_proposal_text) return `${intro}${who} beslutade ${follows}om disposition av resultatet: ${p.board_proposal_text}`
      return `${intro}${who} beslutade ${follows}om disposition av resultatet.`
    }
    case 'utdelning': {
      const parsed = parseDecisionPayload('utdelning', decision.payload)
      if (!parsed.ok) return ''
      const p = parsed.payload
      return (
        `${who} beslutade om utdelning med ${formatKr(p.amount_per_share)} per aktie, totalt ${formatKr(p.total_amount)} på ${formatInt(p.share_count)} aktier` +
        `${p.share_class_code ? ` av serie ${p.share_class_code}` : ''}. ` +
        (p.payment_date ? `Betalningsdag är ${p.payment_date}.` : 'Betalningsdag bestäms senare.')
      )
    }
    case 'ansvarsfrihet': {
      const parsed = parseDecisionPayload('ansvarsfrihet', decision.payload)
      if (!parsed.ok) return ''
      const granted = parsed.payload.persons.filter((p) => p.granted).map((p) => p.name)
      const refused = parsed.payload.persons.filter((p) => !p.granted).map((p) => p.name)
      return [
        granted.length > 0 ? `${who} beviljade ${joinNames(granted)} ansvarsfrihet för förvaltningen under ${periodText(ctx)}.` : null,
        refused.length > 0 ? `${who} beviljade inte ${joinNames(refused)} ansvarsfrihet.` : null,
      ]
        .filter(Boolean)
        .join(' ')
    }
    case 'val_styrelse': {
      const parsed = parseDecisionPayload('val_styrelse', decision.payload)
      if (!parsed.ok) return ''
      const m = parsed.payload.members
      const term = parsed.payload.term ? ` för tiden ${parsed.payload.term}` : ''
      const chair = m.filter((x) => x.role === 'styrelseordforande').map((x) => x.name)
      const members = m.filter((x) => x.role === 'styrelseledamot').map((x) => x.name)
      const deputies = m.filter((x) => x.role === 'styrelsesuppleant').map((x) => x.name)
      if (m.length === 0) return `${who} valde ingen styrelse.`
      return [
        members.length > 0 ? `Till ${members.length === 1 ? 'styrelseledamot' : 'styrelseledamöter'} valdes ${joinNames(members)}${term}.` : null,
        chair.length > 0 ? `Till styrelsens ordförande valdes ${joinNames(chair)}${term}.` : null,
        deputies.length > 0 ? `Till ${deputies.length === 1 ? 'styrelsesuppleant' : 'styrelsesuppleanter'} valdes ${joinNames(deputies)}${term}.` : null,
      ]
        .filter(Boolean)
        .join(' ')
    }
    case 'val_revisor': {
      const parsed = parseDecisionPayload('val_revisor', decision.payload)
      if (!parsed.ok) return ''
      if (parsed.payload.no_auditor || parsed.payload.auditors.length === 0) return 'Bolaget har ingen revisor; ingen revisor valdes.'
      const term = parsed.payload.term ? ` för tiden ${parsed.payload.term}` : ''
      const main = parsed.payload.auditors.filter((a) => a.role !== 'revisorssuppleant').map((a) => a.name)
      const deputies = parsed.payload.auditors.filter((a) => a.role === 'revisorssuppleant').map((a) => a.name)
      return [
        main.length > 0 ? `Till revisor valdes ${joinNames(main)}${term}.` : null,
        deputies.length > 0 ? `Till revisorssuppleant valdes ${joinNames(deputies)}${term}.` : null,
      ]
        .filter(Boolean)
        .join(' ')
    }
    case 'arvoden': {
      const parsed = parseDecisionPayload('arvoden', decision.payload)
      if (!parsed.ok) return ''
      const p = parsed.payload
      const board =
        p.board_fees.length > 0
          ? `Arvode till styrelsen utgår med ${joinNames(p.board_fees.map((f) => `${formatKr(f.amount)} till ${f.name}`))}.`
          : p.board_fee_total
            ? `Arvode till styrelsen utgår med totalt ${formatKr(p.board_fee_total)}.`
            : 'Inget arvode utgår till styrelsen.'
      return [`${who} beslutade om arvoden.`, board, p.auditor_fee ? `Arvode till revisorn utgår ${p.auditor_fee}.` : null].filter(Boolean).join(' ')
    }
    case 'andrad_bolagsordning': {
      const parsed = parseDecisionPayload('andrad_bolagsordning', decision.payload)
      if (!parsed.ok) return ''
      return `${who} beslutade att ändra bolagsordningen${parsed.payload.sections ? ` (${parsed.payload.sections})` : ''}.${parsed.payload.new_wording ? ` Ny lydelse: ${parsed.payload.new_wording}` : ''}`
    }
    case 'nyemission': {
      const parsed = parseDecisionPayload('nyemission', decision.payload)
      if (!parsed.ok) return ''
      const p = parsed.payload
      return `${who} beslutade om nyemission av ${formatInt(p.share_count)} aktier${p.share_class_code ? ` av serie ${p.share_class_code}` : ''} till en teckningskurs om ${formatKr(p.price_per_share)} per aktie.${p.subscription_end ? ` Teckning sker senast ${p.subscription_end}.` : ''}${p.payment_date ? ` Betalning sker senast ${p.payment_date}.` : ''}`
    }
    case 'fondemission': {
      const parsed = parseDecisionPayload('fondemission', decision.payload)
      if (!parsed.ok) return ''
      const p = parsed.payload
      return `${who} beslutade att öka aktiekapitalet med ${formatKr(p.amount)} genom fondemission${p.new_share_count ? ` med ${formatInt(p.new_share_count)} nya aktier` : ' utan nya aktier'}${p.source ? `, genom överföring från ${p.source}` : ''}.`
    }
    case 'minskning': {
      const parsed = parseDecisionPayload('minskning', decision.payload)
      if (!parsed.ok) return ''
      const purpose = { tackning_forlust: 'för täckning av förlust', aterbetalning: 'för återbetalning till aktieägarna', fri_fond: 'för avsättning till fritt eget kapital' }
      const p = parsed.payload
      return `${who} beslutade att minska aktiekapitalet med ${formatKr(p.amount)}${p.purpose ? ` ${purpose[p.purpose]}` : ''}${p.cancelled_share_count ? ` genom indragning av ${formatInt(p.cancelled_share_count)} aktier` : ''}.`
    }
    case 'optioner': {
      const parsed = parseDecisionPayload('optioner', decision.payload)
      if (!parsed.ok) return ''
      const p = parsed.payload
      return `${who} beslutade om emission av ${formatInt(p.option_count)} teckningsoptioner med en teckningskurs för aktie om ${formatKr(p.strike_price)}.${p.exercise_end ? ` Optionerna kan utnyttjas till och med ${p.exercise_end}.` : ''}`
    }
    case 'aterbetalning_villkorat_tillskott': {
      const parsed = parseDecisionPayload('aterbetalning_villkorat_tillskott', decision.payload)
      if (!parsed.ok) return ''
      const p = parsed.payload
      const to = p.recipients.length > 0 ? ` till ${joinNames(p.recipients.map((r) => `${r.name} (${formatKr(r.amount)})`))}` : ''
      return `${who} beslutade att återbetala villkorat aktieägartillskott med totalt ${formatKr(p.total_amount)}${to}.${p.payment_date ? ` Betalning sker ${p.payment_date}.` : ''}`
    }
  }
}
