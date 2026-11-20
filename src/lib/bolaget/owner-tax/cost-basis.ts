/**
 * The omkostnadsbelopp of the shares an owner holds at the start of an
 * inkomstår, as far as the aktiebok and the tillskott register tell it.
 *
 * For each share the owner holds, the latest aktiebok entry that gave it to
 * them says what it cost: the price of the entry spread over its shares
 * (bildande, nyemission, a purchase), nothing for a fondemission share. Two
 * things the aktiebok cannot answer make the figure incomplete, and the
 * owner enters their own omkostnadsbelopp instead (k10_owner_inputs):
 *
 *   - a share received by gift, inheritance, will or bodelning keeps the
 *     giver's omkostnadsbelopp, which is not in this company's books;
 *   - an entry without a price, a split or sammanläggning (the share numbers
 *     changed), or a share no entry traces.
 *
 * Ovillkorade aktieägartillskott the owner made before the start of the
 * year are added (SKV 292: an ovillkorat tillskott adds to the
 * omkostnadsbelopp, a villkorat one does not). Pure: no I/O.
 */
import { roundOre } from '@/lib/money'
import { compareEvents, voidedEventIds } from '../register-state'
import type { HoldingRange, ShareEvent, TransferReason } from '../types'

/** The entries that give shares to a holder. */
const ACQUIRING_KINDS = new Set(['bildande', 'nyemission', 'fondemission', 'overlatelse'])
/** The entries that renumber shares: the trace through numbers breaks. */
const RENUMBER_KINDS = new Set(['split', 'sammanlaggning'])
/** Transfers where the receiver takes over the giver's omkostnadsbelopp. */
const CONTINUITY_REASONS: readonly TransferReason[] = ['gava', 'arv', 'testamente', 'bodelning']

export type CostBasisGap = 'continuity' | 'price_missing' | 'renumbered' | 'untraced'

export interface CostBasisPart {
  event_number: number
  event_date: string
  kind: string
  shares: number
  amount: number
}

export interface CostBasisResult {
  /** From the aktiebok entries the owner's shares trace to. */
  register_amount: number
  /** Ovillkorade tillskott before the start of the year. */
  contributions_amount: number
  amount: number
  complete: boolean
  gaps: CostBasisGap[]
  parts: CostBasisPart[]
}

export interface CostBasisContribution {
  party_id: string
  kind: 'contribution' | 'repayment'
  conditional: boolean
  status: string
  promised_on: string
  amount: number
}

type Interval = [number, number]

function intersectCount(held: readonly Interval[], start: number, end: number): number {
  let n = 0
  for (const [s, e] of held) if (s <= end && start <= e) n += Math.min(e, end) - Math.max(s, start) + 1
  return n
}

function subtractInterval(held: readonly Interval[], start: number, end: number): Interval[] {
  const out: Interval[] = []
  for (const [s, e] of held) {
    if (e < start || s > end) {
      out.push([s, e])
      continue
    }
    if (s < start) out.push([s, start - 1])
    if (e > end) out.push([end + 1, e])
  }
  return out
}

/**
 * The owner's omkostnadsbelopp at `asOf` (the last day before the
 * inkomstår): `held` is the owner's ranges in the aktiebok replayed to that
 * day, `events` every aktiebok entry.
 */
export function costBasisFromRegister(args: {
  partyId: string
  held: readonly Pick<HoldingRange, 'range_start' | 'range_end'>[]
  events: readonly ShareEvent[]
  asOf: string
  contributions: readonly CostBasisContribution[]
}): CostBasisResult {
  const voided = voidedEventIds(args.events)
  const valid = args.events
    .filter((e) => e.kind !== 'rattelse' && !voided.has(e.id) && e.event_date <= args.asOf)
    .sort(compareEvents)
  const gaps = new Set<CostBasisGap>()
  if (valid.some((e) => RENUMBER_KINDS.has(e.kind))) gaps.add('renumbered')

  let remaining: Interval[] = args.held.map((r) => [r.range_start, r.range_end])
  const parts: CostBasisPart[] = []
  for (const e of [...valid].reverse()) {
    if (remaining.length === 0) break
    if (!ACQUIRING_KINDS.has(e.kind) || e.to_party_id !== args.partyId) continue
    if (e.range_start === null || e.range_end === null) continue
    const shares = intersectCount(remaining, e.range_start, e.range_end)
    if (shares === 0) continue
    remaining = subtractInterval(remaining, e.range_start, e.range_end)
    const size = e.range_end - e.range_start + 1
    let amount = 0
    if (e.kind === 'fondemission') {
      amount = 0
    } else if (e.kind === 'overlatelse' && e.transfer_reason && CONTINUITY_REASONS.includes(e.transfer_reason)) {
      gaps.add('continuity')
    } else if (e.price_total === null || e.price_total === undefined) {
      gaps.add('price_missing')
    } else {
      amount = roundOre((Number(e.price_total) * shares) / size)
    }
    parts.push({ event_number: e.event_number, event_date: e.event_date, kind: e.kind, shares, amount })
  }
  if (remaining.length > 0) gaps.add('untraced')

  const registerAmount = roundOre(parts.reduce((n, p) => n + p.amount, 0))
  const contributionsAmount = roundOre(
    args.contributions
      .filter(
        (c) =>
          c.party_id === args.partyId &&
          c.kind === 'contribution' &&
          !c.conditional &&
          c.status !== 'cancelled' &&
          c.promised_on <= args.asOf,
      )
      .reduce((n, c) => n + c.amount, 0),
  )
  return {
    register_amount: registerAmount,
    contributions_amount: contributionsAmount,
    amount: roundOre(registerAmount + contributionsAmount),
    complete: gaps.size === 0,
    gaps: [...gaps],
    parts: parts.reverse(),
  }
}

export const COST_BASIS_GAP_TEXT_SV: Record<CostBasisGap, string> = {
  continuity: 'Aktier som fåtts genom gåva, arv, testamente eller bodelning behåller den tidigare ägarens omkostnadsbelopp, som inte finns i bolagets bokföring.',
  price_missing: 'En anteckning i aktieboken saknar pris.',
  renumbered: 'Aktierna har delats eller lagts samman, så anskaffningen kan inte följas per aktienummer.',
  untraced: 'Några aktier kan inte följas till en anteckning i aktieboken.',
}
