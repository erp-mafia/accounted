/**
 * The aktiebok entry form as plain data: what a person typed, read strictly,
 * and the request body POST /api/bolaget/share-register/events takes.
 *
 * Pure (no React, no I/O). An entry in the aktiebok is permanent, so the
 * reading of every number and the body it becomes are tested on their own
 * (__tests__/share-event-form.test.ts) instead of living inside the page.
 */
import { parseAmountInput, roundOre } from '@/lib/money'
import { HOLDER_KINDS, ISSUE_KINDS, type ShareEventKind } from '@/lib/bolaget/types'

export type FormState = Record<string, string>

/** The picker value for somebody who is not in the registers yet. */
export const NEW_PARTY = '__new'

/** Kinds that take a count: an issue gets the next free numbers, a holder's kind the holder's lowest block that fits. */
export const COUNTED_KINDS: readonly ShareEventKind[] = [...ISSUE_KINDS, ...HOLDER_KINDS]
/** Notes on shares: the server needs their numbers, so a count alone is never asked for. */
export const NUMBERS_ONLY_KINDS: readonly ShareEventKind[] = ['aktiebrev', 'pant', 'nyttjanderatt']
/** Kinds that name share numbers. */
export const RANGED_KINDS: readonly ShareEventKind[] = [...COUNTED_KINDS, ...NUMBERS_ONLY_KINDS]
/** Kinds with a receiver (form fields to_*). */
export const RECEIVER_KINDS: readonly ShareEventKind[] = [...ISSUE_KINDS, 'overlatelse']
/** Kinds with a pledgee or a holder of a right (form fields counter_party, counterparty_*). */
export const COUNTERPARTY_KINDS: readonly ShareEventKind[] = ['pant', 'nyttjanderatt']
/** Kinds that can carry a price or a subscription amount. A holding carried over from an earlier register has neither. */
export const PRICED_KINDS: readonly ShareEventKind[] = [...ISSUE_KINDS.filter((k) => k !== 'ingaende'), 'overlatelse', 'indragning']
/** Kinds that can be the entry that makes a register complete while it is set up. */
export const SETUP_KINDS: readonly ShareEventKind[] = ISSUE_KINDS
/** Kinds Bolagsverket registers. */
export const REGISTERED_KINDS: readonly ShareEventKind[] = ['nyemission', 'fondemission', 'indragning']

/**
 * A new entry before anyone has typed. Nobody is chosen: `to_party` and
 * `counter_party` are empty until the person picks someone from the registers
 * or NEW_PARTY, so an entry is never made for a preselected name.
 */
export const EMPTY_EVENT: FormState = {
  kind: 'overlatelse',
  event_date: '',
  share_class_code: '',
  to_share_class_code: '',
  from_party_id: '',
  to_party: '',
  to_name: '',
  to_kind: 'person',
  to_org_number: '',
  to_is_new: '',
  counter_party: '',
  counterparty_name: '',
  counterparty_kind: 'company',
  counterparty_org_number: '',
  counterparty_is_new: '',
  share_count: '',
  range_start: '',
  range_end: '',
  transfer_reason: 'kop',
  price_total: '',
  ratio: '',
  aktiebrev_number: '',
  aktiebrev_action: 'issued',
  note_status: 'open',
  corrects_event_id: '',
  registered_on: '',
  note: '',
  forbehall_cleared: '',
  completes_setup: '',
}

/** Why a field cannot be sent. The page has one sentence per code (messages: err_<code>). */
export type FieldError =
  | 'date_required'
  | 'date_future'
  | 'choose'
  | 'text_required'
  | 'whole_number'
  | 'count_required'
  | 'range_start_required'
  | 'range_order'
  | 'count_mismatch'
  | 'ratio_min'
  | 'amount_invalid'

export type FieldErrors = Partial<Record<string, FieldError>>

export type WholeNumber = { ok: true; value: number | null } | { ok: false }

/**
 * A share count, a share number or a ratio as a person typed it: digits,
 * with spaces between the groups ("25 000", and the no-break spaces a pasted
 * figure carries). Blank is null. Anything else is refused, never guessed:
 * parseInt read "25.000" and "25,000" as 25, and that became the entry.
 */
export function parseWholeNumber(text: string): WholeNumber {
  const compact = text.replace(/\s/g, '')
  if (compact === '') return { ok: true, value: null }
  if (!/^\d+$/.test(compact)) return { ok: false }
  const value = Number(compact)
  if (!Number.isSafeInteger(value) || value < 1) return { ok: false }
  return { ok: true, value }
}

/** The "somebody else with the same name" flag belongs to one typed name: it falls when that name, its kind or the pick changes. */
const IS_NEW_FLAG: Record<string, string> = {
  to_party: 'to_is_new',
  to_name: 'to_is_new',
  to_kind: 'to_is_new',
  counter_party: 'counterparty_is_new',
  counterparty_name: 'counterparty_is_new',
  counterparty_kind: 'counterparty_is_new',
}

/** The form with one field changed. */
export function withField(form: FormState, key: string, value: string): FormState {
  const flag = IS_NEW_FLAG[key]
  return flag ? { ...form, [key]: value, [flag]: '' } : { ...form, [key]: value }
}

export type EventBodyResult = { ok: true; body: Record<string, unknown> } | { ok: false; errors: FieldErrors }

const PARTY_FIELDS = {
  to: { pick: 'to_party', name: 'to_name', kind: 'to_kind', org: 'to_org_number', isNew: 'to_is_new' },
  counterparty: { pick: 'counter_party', name: 'counterparty_name', kind: 'counterparty_kind', org: 'counterparty_org_number', isNew: 'counterparty_is_new' },
} as const

/** A receiver or a counterparty: somebody picked from the registers, or a new name with its kind. */
function readParty(form: FormState, which: keyof typeof PARTY_FIELDS, body: Record<string, unknown>, errors: FieldErrors): void {
  const fields = PARTY_FIELDS[which]
  const picked = form[fields.pick] ?? ''
  if (!picked) {
    errors[fields.pick] = 'choose'
    return
  }
  if (picked !== NEW_PARTY) {
    body[`${which}_party_id`] = picked
    return
  }
  const name = (form[fields.name] ?? '').trim()
  if (!name) {
    errors[fields.name] = 'text_required'
    return
  }
  body[`${which}_name`] = name
  body[`${which}_kind`] = form[fields.kind]
  const org = (form[fields.org] ?? '').trim()
  if (form[fields.kind] === 'company' && org) body[`${which}_org_number`] = org
  if (form[fields.isNew] === 'true') body[`${which}_is_new`] = true
}

/**
 * The share numbers of the entry.
 *   - a count alone: the server takes the next free numbers (an issue) or the
 *     holder's lowest block that fits;
 *   - a first number with a count: the whole block from that number (the
 *     server computes its last number);
 *   - a first and a last number: those shares, and a count typed beside them
 *     must agree;
 *   - a first number alone: that one share.
 * A note on shares (aktiebrev, pant, nyttjanderätt) is given by its numbers
 * only; a count typed before the kind was changed is not sent.
 */
function readShareNumbers(form: FormState, kind: ShareEventKind, body: Record<string, unknown>, errors: FieldErrors): void {
  const numbersOnly = NUMBERS_ONLY_KINDS.includes(kind)
  const read = (key: string): number | null => {
    const parsed = parseWholeNumber(form[key] ?? '')
    if (!parsed.ok) {
      errors[key] = 'whole_number'
      return null
    }
    return parsed.value
  }
  const start = read('range_start')
  const end = read('range_end')
  const count = numbersOnly ? null : read('share_count')
  if (errors.range_start || errors.range_end || errors.share_count) return

  if (start === null) {
    if (end !== null) errors.range_start = 'range_start_required'
    else if (count !== null) body.share_count = count
    else if (numbersOnly) errors.range_start = 'range_start_required'
    else errors.share_count = 'count_required'
    return
  }
  body.range_start = start
  if (end === null) {
    if (count !== null) body.share_count = count
    return
  }
  if (end < start) {
    errors.range_end = 'range_order'
    return
  }
  if (count !== null && end - start + 1 !== count) {
    errors.share_count = 'count_mismatch'
    return
  }
  body.range_end = end
}

/**
 * The form as POST /api/bolaget/share-register/events takes it: only the
 * fields the kind uses. Nothing a person typed is dropped or guessed: a
 * value that cannot be read is an error at its field and no body is built.
 *
 * `today` (YYYY-MM-DD) refuses a date ahead of it, as the server does.
 * `expectedLastEventNumber` is the preview's last_event_number, sent with the
 * real write so the server refuses it when the register has moved on.
 *
 * `inUse`: the register's setup is completed. An entry then carries the day
 * it is made, which the server sets: the form's date is the day of the event
 * and optional, sent as occurred_on when it is an earlier day. While the
 * register is set up the date is the entry's own and required.
 */
export function buildEventBody(form: FormState, options: { today: string; expectedLastEventNumber?: number; inUse?: boolean }): EventBodyResult {
  const kind = form.kind as ShareEventKind
  const errors: FieldErrors = {}
  const body: Record<string, unknown> = { kind }

  if (options.inUse) {
    if (form.event_date > options.today) errors.event_date = 'date_future'
    else if (form.event_date && form.event_date < options.today && kind !== 'rattelse') body.occurred_on = form.event_date
  } else {
    body.event_date = form.event_date
    if (!form.event_date) errors.event_date = 'date_required'
    else if (form.event_date > options.today) errors.event_date = 'date_future'
    if (SETUP_KINDS.includes(kind) && form.completes_setup === 'true') body.completes_setup = true
  }

  const note = (form.note ?? '').trim()
  if (note) body.note = note
  else if (kind === 'anteckning' || kind === 'rattelse') errors.note = 'text_required'

  if (COUNTED_KINDS.includes(kind) && form.share_class_code) body.share_class_code = form.share_class_code
  if (HOLDER_KINDS.includes(kind)) {
    if (form.from_party_id) body.from_party_id = form.from_party_id
    else errors.from_party_id = 'choose'
  }
  if (RECEIVER_KINDS.includes(kind)) readParty(form, 'to', body, errors)
  if (COUNTERPARTY_KINDS.includes(kind)) {
    readParty(form, 'counterparty', body, errors)
    body.note_status = form.note_status
  }
  if (RANGED_KINDS.includes(kind)) readShareNumbers(form, kind, body, errors)
  if (kind === 'omvandling') {
    if (form.to_share_class_code) body.to_share_class_code = form.to_share_class_code
    else errors.to_share_class_code = 'choose'
  }
  if (kind === 'overlatelse') {
    body.transfer_reason = form.transfer_reason
    if (form.forbehall_cleared === 'true') body.forbehall_cleared = true
  }
  if (PRICED_KINDS.includes(kind) && (form.price_total ?? '').trim()) {
    const price = parseAmountInput(form.price_total)
    if (price === null || price < 0) errors.price_total = 'amount_invalid'
    else body.price_total = price
  }
  if (kind === 'split' || kind === 'sammanlaggning') {
    const ratio = parseWholeNumber(form.ratio ?? '')
    if (!ratio.ok || ratio.value === null || ratio.value < 2) errors.ratio = 'ratio_min'
    else body.ratio = ratio.value
  }
  if (kind === 'aktiebrev') {
    const number = (form.aktiebrev_number ?? '').trim()
    if (number) body.aktiebrev_number = number
    else errors.aktiebrev_number = 'text_required'
    body.aktiebrev_action = form.aktiebrev_action
  }
  if (kind === 'rattelse') body.corrects_event_id = form.corrects_event_id
  if (REGISTERED_KINDS.includes(kind) && form.registered_on) body.registered_on = form.registered_on

  if (Object.keys(errors).length > 0) return { ok: false, errors }
  if (options.expectedLastEventNumber !== undefined) body.expected_last_event_number = options.expectedLastEventNumber
  return { ok: true, body }
}

/** What the dry run answers (registerShareEvent's preview in lib/bolaget/share-register.ts). */
export interface EventPreview {
  kind: ShareEventKind
  kind_label: string
  /** The day the entry will carry: the day of the event while the register is set up, today once it is in use. */
  event_date: string
  /** The day of the event when it is earlier than the day the entry carries. */
  occurred_on: string | null
  register_in_use: boolean
  /** The entry makes the register complete and takes it into use. */
  completes_setup: boolean
  share_class: string | null
  creates_share_class: string | null
  range_start: number | null
  range_end: number | null
  share_count: number | null
  from_party_id: string | null
  to: { party_id?: string; name?: string | null; kind?: 'person' | 'company' } | null
  counterparty: { party_id?: string; name?: string | null } | null
  transfer_reason: string | null
  price_total: number | null
  ratio: number | null
  corrects_event_id: string | null
  corrects_event_number: number | null
  /** The newest entry the preview saw: sent back as expected_last_event_number. */
  last_event_number: number
  /** Typed names that belong to somebody already in the registers: the entry is made for them. */
  matched_parties: Array<{ field: 'to' | 'counterparty'; party_id: string; name: string }>
  total_shares_before: number
  total_shares_after: number
  holders_changed: Array<{ party_id: string | null; new_party: boolean; shares_before: number; shares_after: number }>
  warnings: string[]
  /** The code of each warning, in the same order. */
  warning_codes: string[]
}

/** Share numbers as a register writes them: "7" for one share, "1-500" for a block. */
export function shareNumbersLabel(start: number | null, end: number | null, format: (n: number) => string = String): string {
  if (start === null || end === null) return ''
  return start === end ? format(start) : `${format(start)}-${format(end)}`
}

export interface VoteShare {
  party_id: string
  name: string
  before_pct: number
  after_pct: number
}

/**
 * Each holder's share of the votes before and after one class gets a new
 * number of votes per share. Rounded like the register's own percentages
 * (two decimals), so a holder the change does not touch reads the same.
 */
export function voteSharesAfter(
  holders: ReadonlyArray<{ party_id: string; name: string; votes_pct: number; by_class: ReadonlyArray<{ share_class_id: string; shares: number }> }>,
  classes: ReadonlyArray<{ share_class_id: string; votes_per_share: number }>,
  shareClassId: string,
  votesPerShare: number,
): VoteShare[] {
  const votesPer = new Map(classes.map((c) => [c.share_class_id, c.share_class_id === shareClassId ? votesPerShare : c.votes_per_share]))
  const votes = holders.map((h) => h.by_class.reduce((sum, c) => sum + c.shares * (votesPer.get(c.share_class_id) ?? 1), 0))
  const total = votes.reduce((sum, v) => sum + v, 0)
  return holders.map((h, i) => ({
    party_id: h.party_id,
    name: h.name,
    before_pct: h.votes_pct,
    after_pct: total > 0 ? roundOre(((votes[i] ?? 0) / total) * 100) : 0,
  }))
}
