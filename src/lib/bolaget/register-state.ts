/**
 * The aktiebok replayed: who holds which share numbers on a date, the notes
 * on those shares (aktiebrev, pant, nyttjanderätt), and what each holder
 * owns of the capital and the votes.
 *
 * Pure: no I/O. The database holds the same rules for the holdings
 * (share_register_replay in 20261029210000_bolaget_registers.sql) and is
 * the authority: it refuses an entry the history cannot hold at commit.
 * This copy answers the preview of an entry before it is saved, with a
 * readable reason, and the notes, which only the app tracks.
 *
 * Order: by event date, then by entry number (an entry not yet saved goes
 * last on its date, as the database numbers it). A voided entry (one a
 * rattelse points at) is left out entirely.
 */
import { roundOre } from '@/lib/money'
import {
  HOLDER_KINDS,
  ISSUE_KINDS,
  type HoldingRange,
  type ShareClass,
  type ShareEvent,
} from './types'

/** Why an entry cannot be held, with the code the database raises for the same reason. */
export class ShareRegisterError extends Error {
  constructor(
    readonly code:
      | 'SHARE_REGISTER_RANGE_TAKEN'
      | 'SHARE_REGISTER_NOT_HELD'
      | 'SHARE_REGISTER_RATIO_MISALIGNED'
      | 'SHARE_REGISTER_NOTE_INVALID'
      | 'SHARE_REGISTER_CORRECTION_INVALID',
    message: string,
    readonly eventNumber: number | null = null,
  ) {
    super(message)
    this.name = 'ShareRegisterError'
  }
}

export type AnnotationKind = 'aktiebrev' | 'pant' | 'nyttjanderatt'

/** An open note on a range of share numbers. */
export interface ShareAnnotation {
  kind: AnnotationKind
  event_id: string
  event_number: number
  event_date: string
  range_start: number
  range_end: number
  aktiebrev_number: string | null
  counterparty_party_id: string | null
  note: string | null
}

/** A stored note entry the history cannot hold: left out of the answer and named here, so a read still answers. */
export interface NoteProblem {
  event_id: string
  event_number: number
  event_date: string
  kind: AnnotationKind
  message: string
}

export interface ReplayResult {
  /** Holdings with adjacent ranges of the same holder and class joined, by share number. */
  ranges: HoldingRange[]
  annotations: ShareAnnotation[]
  totalShares: number
  /** Empty unless the replay ran with `notes: 'collect'` and a stored note entry was left out. */
  noteProblems: NoteProblem[]
}

export interface ReplayOptions {
  /**
   * What an aktiebrev, pant or nyttjanderätt entry the history cannot hold
   * does. 'strict' (the default) throws, which is the check of an entry
   * before it is saved. 'collect' leaves the entry out and names it in
   * `noteProblems`: the database validates holdings but not notes, so a read
   * of the stored register must answer even when two note entries collide,
   * and a rättelse must still be possible. Holdings always throw.
   */
  notes?: 'strict' | 'collect'
}

type ReplayEvent = Pick<
  ShareEvent,
  | 'id'
  | 'event_number'
  | 'event_date'
  | 'kind'
  | 'share_class_id'
  | 'to_share_class_id'
  | 'from_party_id'
  | 'to_party_id'
  | 'range_start'
  | 'range_end'
  | 'ratio'
  | 'aktiebrev_number'
  | 'aktiebrev_action'
  | 'counterparty_party_id'
  | 'note_status'
  | 'corrects_event_id'
  | 'note'
>

/** The ids the rattelse entries void. */
export function voidedEventIds(events: readonly Pick<ShareEvent, 'kind' | 'corrects_event_id'>[]): Set<string> {
  const out = new Set<string>()
  for (const e of events) if (e.kind === 'rattelse' && e.corrects_event_id) out.add(e.corrects_event_id)
  return out
}

/** Entry order: date, then number (an unsaved entry, number 0 or less, last on its date). */
export function compareEvents(a: Pick<ShareEvent, 'event_date' | 'event_number'>, b: Pick<ShareEvent, 'event_date' | 'event_number'>): number {
  if (a.event_date !== b.event_date) return a.event_date < b.event_date ? -1 : 1
  const an = a.event_number > 0 ? a.event_number : Number.MAX_SAFE_INTEGER
  const bn = b.event_number > 0 ? b.event_number : Number.MAX_SAFE_INTEGER
  return an - bn
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart <= bEnd && bStart <= aEnd
}

function rangeText(start: number, end: number): string {
  return start === end ? `aktie ${start}` : `aktierna ${start}-${end}`
}

/** How many of [start, end] the ranges cover. */
function covered(ranges: readonly HoldingRange[], start: number, end: number): number {
  let n = 0
  for (const r of ranges) {
    if (!overlaps(r.range_start, r.range_end, start, end)) continue
    n += Math.min(r.range_end, end) - Math.max(r.range_start, start) + 1
  }
  return n
}

/** [start, end] minus [cutStart, cutEnd]: zero, one or two pieces. */
function subtract(start: number, end: number, cutStart: number, cutEnd: number): Array<[number, number]> {
  if (!overlaps(start, end, cutStart, cutEnd)) return [[start, end]]
  const out: Array<[number, number]> = []
  if (start < cutStart) out.push([start, cutStart - 1])
  if (end > cutEnd) out.push([cutEnd + 1, end])
  return out
}

/** Join adjacent ranges of the same holder and class; sort by share number. */
export function mergeRanges(ranges: readonly HoldingRange[]): HoldingRange[] {
  const sorted = [...ranges].sort((a, b) => a.range_start - b.range_start)
  const out: HoldingRange[] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && last.range_end + 1 === r.range_start && last.party_id === r.party_id && last.share_class_id === r.share_class_id) {
      last.range_end = r.range_end
    } else {
      out.push({ ...r })
    }
  }
  return out
}

/**
 * Replay the aktiebok up to and including `asOf` (null: every entry).
 * Throws ShareRegisterError on the first entry the history cannot hold.
 */
export function replayShareRegister(events: readonly ReplayEvent[], asOf: string | null = null, options: ReplayOptions = {}): ReplayResult {
  const voided = voidedEventIds(events)
  const ordered = events
    .filter((e) => e.kind !== 'rattelse' && !voided.has(e.id) && (asOf === null || e.event_date <= asOf))
    .sort(compareEvents)

  let state: HoldingRange[] = []
  let notes: ShareAnnotation[] = []
  const noteProblems: NoteProblem[] = []
  const collect = options.notes === 'collect'

  for (const ev of ordered) {
    const num = ev.event_number > 0 ? ev.event_number : null
    const start = ev.range_start ?? 0
    const end = ev.range_end ?? 0

    if (ISSUE_KINDS.includes(ev.kind)) {
      for (const r of state) {
        if (overlaps(r.range_start, r.range_end, start, end)) {
          throw new ShareRegisterError(
            'SHARE_REGISTER_RANGE_TAKEN',
            `${rangeText(Math.max(r.range_start, start), Math.min(r.range_end, end))} finns redan i aktieboken. Nya aktier får nästa lediga nummer.`,
            num,
          )
        }
      }
      state.push({ share_class_id: ev.share_class_id!, party_id: ev.to_party_id!, range_start: start, range_end: end })
      continue
    }

    if (HOLDER_KINDS.includes(ev.kind)) {
      const next: HoldingRange[] = []
      let cov = 0
      for (const r of state) {
        if (!overlaps(r.range_start, r.range_end, start, end)) {
          next.push(r)
          continue
        }
        if (r.party_id !== ev.from_party_id || r.share_class_id !== ev.share_class_id) {
          throw new ShareRegisterError(
            'SHARE_REGISTER_NOT_HELD',
            `${rangeText(start, end)} av det aktieslaget ägs inte av överlåtaren den ${ev.event_date}.`,
            num,
          )
        }
        const lo = Math.max(r.range_start, start)
        const hi = Math.min(r.range_end, end)
        cov += hi - lo + 1
        if (r.range_start < lo) next.push({ ...r, range_end: lo - 1 })
        if (ev.kind === 'overlatelse') next.push({ ...r, party_id: ev.to_party_id!, range_start: lo, range_end: hi })
        if (ev.kind === 'omvandling') next.push({ ...r, share_class_id: ev.to_share_class_id!, range_start: lo, range_end: hi })
        if (r.range_end > hi) next.push({ ...r, range_start: hi + 1 })
      }
      if (cov !== end - start + 1) {
        throw new ShareRegisterError(
          'SHARE_REGISTER_NOT_HELD',
          `${rangeText(start, end)} ägs inte alla av överlåtaren den ${ev.event_date}.`,
          num,
        )
      }
      state = next
      // Cancelled shares take their notes with them.
      if (ev.kind === 'indragning') {
        notes = notes.flatMap((n) => subtract(n.range_start, n.range_end, start, end).map(([s, e]) => ({ ...n, range_start: s, range_end: e })))
      }
      continue
    }

    if (ev.kind === 'split') {
      const k = ev.ratio!
      state = state.map((r) => ({ ...r, range_start: (r.range_start - 1) * k + 1, range_end: r.range_end * k }))
      notes = notes.map((n) => ({ ...n, range_start: (n.range_start - 1) * k + 1, range_end: n.range_end * k }))
      continue
    }

    if (ev.kind === 'sammanlaggning') {
      const k = ev.ratio!
      for (const r of mergeRanges(state)) {
        if ((r.range_start - 1) % k !== 0 || r.range_end % k !== 0) {
          throw new ShareRegisterError(
            'SHARE_REGISTER_RATIO_MISALIGNED',
            `${rangeText(r.range_start, r.range_end)} går inte att lägga samman ${k} till 1: varje innehav måste vara jämnt delbart.`,
            num,
          )
        }
      }
      state = mergeRanges(state).map((r) => ({ ...r, range_start: (r.range_start - 1) / k + 1, range_end: r.range_end / k }))
      notes = notes.map((n) => ({ ...n, range_start: Math.floor((n.range_start - 1) / k) + 1, range_end: Math.ceil(n.range_end / k) }))
      continue
    }

    if (ev.kind === 'aktiebrev' || ev.kind === 'pant' || ev.kind === 'nyttjanderatt') {
      const kind: AnnotationKind = ev.kind
      // A note the history cannot hold: refused before it is saved, left out and named when it is already stored.
      const invalid = (message: string): void => {
        if (!collect) throw new ShareRegisterError('SHARE_REGISTER_NOTE_INVALID', message, num)
        noteProblems.push({ event_id: ev.id, event_number: ev.event_number, event_date: ev.event_date, kind, message })
      }
      const opening = ev.kind === 'aktiebrev' ? ev.aktiebrev_action === 'issued' : ev.note_status === 'open'
      if (opening) {
        if (covered(state, start, end) !== end - start + 1) {
          invalid(`${rangeText(start, end)} finns inte i aktieboken den ${ev.event_date}.`)
          continue
        }
        if (ev.kind === 'aktiebrev') {
          // An aktiebrev is made out to one holder (ABL 6:2).
          const holders = new Set(state.filter((r) => overlaps(r.range_start, r.range_end, start, end)).map((r) => r.party_id))
          if (holders.size > 1) {
            invalid(`${rangeText(start, end)} ägs av flera; ett aktiebrev utfärdas till en ägare.`)
            continue
          }
          const clash = notes.find((n) => n.kind === 'aktiebrev' && (n.aktiebrev_number === ev.aktiebrev_number || overlaps(n.range_start, n.range_end, start, end)))
          if (clash) {
            invalid(`Aktiebrev ${clash.aktiebrev_number} gäller redan ${rangeText(clash.range_start, clash.range_end)}. Makulera det först.`)
            continue
          }
        }
        notes.push({
          kind: ev.kind,
          event_id: ev.id,
          event_number: ev.event_number,
          event_date: ev.event_date,
          range_start: start,
          range_end: end,
          aktiebrev_number: ev.aktiebrev_number,
          counterparty_party_id: ev.counterparty_party_id,
          note: ev.note,
        })
        continue
      }
      // Closing: an aktiebrev by its number, a pant or nyttjanderätt by its counterparty on these shares.
      const matches = (n: ShareAnnotation) =>
        n.kind === ev.kind &&
        (ev.kind === 'aktiebrev'
          ? n.aktiebrev_number === ev.aktiebrev_number
          : n.counterparty_party_id === ev.counterparty_party_id && overlaps(n.range_start, n.range_end, start, end))
      if (!notes.some(matches)) {
        invalid(
          ev.kind === 'aktiebrev'
            ? `Det finns inget utfärdat aktiebrev ${ev.aktiebrev_number ?? ''} att makulera.`
            : `Det finns ingen öppen anteckning att avsluta på ${rangeText(start, end)}.`,
        )
        continue
      }
      notes =
        ev.kind === 'aktiebrev'
          ? notes.filter((n) => !matches(n))
          : notes.flatMap((n) => (matches(n) ? subtract(n.range_start, n.range_end, start, end).map(([s, e]) => ({ ...n, range_start: s, range_end: e })) : [n]))
      continue
    }
    // anteckning: a dated note, no effect on holdings.
  }

  const ranges = mergeRanges(state)
  return {
    ranges,
    annotations: notes.sort((a, b) => a.range_start - b.range_start),
    totalShares: ranges.reduce((sum, r) => sum + (r.range_end - r.range_start + 1), 0),
    noteProblems,
  }
}

/** Check a rattelse before it is saved: it voids one earlier entry that is not itself a rattelse, and the rest still holds. */
export function checkCorrection(events: readonly ReplayEvent[], correctsEventId: string): void {
  const target = events.find((e) => e.id === correctsEventId)
  if (!target || target.kind === 'rattelse') {
    throw new ShareRegisterError('SHARE_REGISTER_CORRECTION_INVALID', 'Rättelsen måste gälla en tidigare anteckning i aktieboken som inte själv är en rättelse.')
  }
  if (voidedEventIds(events).has(correctsEventId)) {
    throw new ShareRegisterError('SHARE_REGISTER_CORRECTION_INVALID', 'Anteckningen är redan rättad.')
  }
}

export interface ClassTotal {
  share_class_id: string
  code: string
  shares: number
  votes: number
}

export interface HolderSummary {
  party_id: string
  shares: number
  votes: number
  /** Share of the capital (all shares), percent with two decimals. */
  capital_pct: number
  /** Share of the votes, percent with two decimals. */
  votes_pct: number
  by_class: Array<{ share_class_id: string; code: string; shares: number }>
  ranges: HoldingRange[]
}

export interface HoldingsSummary {
  total_shares: number
  total_votes: number
  classes: ClassTotal[]
  holders: HolderSummary[]
}

function pct(part: number, whole: number): number {
  return whole > 0 ? roundOre((part / whole) * 100) : 0
}

/** Capital and votes per holder, largest first; votes per share from the classes. */
export function summarizeHoldings(ranges: readonly HoldingRange[], classes: readonly ShareClass[]): HoldingsSummary {
  const classById = new Map(classes.map((c) => [c.id, c]))
  const votesPer = (classId: string) => Number(classById.get(classId)?.votes_per_share ?? 1)
  const codeOf = (classId: string) => classById.get(classId)?.code ?? '?'

  const byHolder = new Map<string, { shares: number; votes: number; byClass: Map<string, number>; ranges: HoldingRange[] }>()
  const classTotals = new Map<string, { shares: number; votes: number }>()
  let totalShares = 0
  let totalVotes = 0
  for (const r of ranges) {
    const n = r.range_end - r.range_start + 1
    const v = n * votesPer(r.share_class_id)
    totalShares += n
    totalVotes += v
    const h = byHolder.get(r.party_id) ?? { shares: 0, votes: 0, byClass: new Map<string, number>(), ranges: [] as HoldingRange[] }
    h.shares += n
    h.votes += v
    h.byClass.set(r.share_class_id, (h.byClass.get(r.share_class_id) ?? 0) + n)
    h.ranges.push(r)
    byHolder.set(r.party_id, h)
    const c = classTotals.get(r.share_class_id) ?? { shares: 0, votes: 0 }
    c.shares += n
    c.votes += v
    classTotals.set(r.share_class_id, c)
  }

  const holders: HolderSummary[] = [...byHolder.entries()]
    .map(([party_id, h]) => ({
      party_id,
      shares: h.shares,
      votes: h.votes,
      capital_pct: pct(h.shares, totalShares),
      votes_pct: pct(h.votes, totalVotes),
      by_class: [...h.byClass.entries()].map(([share_class_id, shares]) => ({ share_class_id, code: codeOf(share_class_id), shares })),
      ranges: [...h.ranges].sort((a, b) => a.range_start - b.range_start),
    }))
    .sort((a, b) => b.votes - a.votes || b.shares - a.shares || a.party_id.localeCompare(b.party_id))

  return {
    total_shares: totalShares,
    total_votes: totalVotes,
    classes: [...classTotals.entries()].map(([share_class_id, t]) => ({ share_class_id, code: codeOf(share_class_id), ...t })),
    holders,
  }
}

/** The next free share number: one after the highest number held now. */
export function nextFreeShareNumber(ranges: readonly HoldingRange[]): number {
  return ranges.reduce((max, r) => Math.max(max, r.range_end), 0) + 1
}
