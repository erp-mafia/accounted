/**
 * The aktiebok (ABL 5 kap.): read it as of a date, and add an entry.
 *
 * Every entry is dated and kept (ABL 5:3, 5:9); a mistake is voided by a
 * rattelse entry and entered again. The register has two phases. While it
 * is set up an entry carries the day of the event, so a company can enter
 * its history, or the holdings it carries over from the register it kept
 * before (kind ingaende). Once every share is entered the setup is
 * completed, and from then on an entry carries the day it is made: a
 * shareholder has rights against the company from the day they are entered
 * (ABL 4:37, 7:2), so an entry never changes who the register showed on an
 * earlier day. The database holds the same rule
 * (share_register_events_number). The database refuses an entry the
 * history cannot hold (share_register_replay); this service checks the same
 * rules first (register-state.ts) so the preview says why in Swedish, and
 * adds what only a person can judge as warnings: a förbehåll to clear, a
 * holder without a personnummer, an emission not yet registered.
 *
 * Who may add an entry is decided here, not at a door: the board keeps the
 * aktiebok (ABL 5:7), so only the company's owner or an administrator does,
 * through the page, the API, an agent's approval or the capital events.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { requireCompanyAdmin } from '@/lib/operations/access'
import type { OperationContext, OperationOutcome, OperationWarning } from '@/lib/operations/types'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { bolagetFailure } from './errors'
import {
  assertPartiesInCompany,
  checkPartyRef,
  createRegisterParty,
  ensureRegisterParty,
  findRegisterPersonByName,
  loadRegisterParties,
  type PartyRef,
} from './people'
import {
  checkCorrection,
  nextFreeShareNumber,
  replayShareRegister,
  ShareRegisterError,
  summarizeHoldings,
  type HoldingsSummary,
  type NoteProblem,
  type ReplayResult,
} from './register-state'
import { reconcileWithSettings, type ShareCapitalReconciliation } from './reconcile'
import {
  HOLDER_KINDS,
  ISSUE_KINDS,
  SHARE_EVENT_LABELS_SV,
  type RegisterParty,
  type ShareClass,
  type ShareEvent,
  type ShareEventKind,
  type TransferReason,
} from './types'

/** Numbers as numbers: PostgREST answers bigint and numeric as strings or numbers. */
function normaliseEvent(row: Record<string, unknown>): ShareEvent {
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v))
  return {
    ...(row as unknown as ShareEvent),
    event_number: Number(row.event_number),
    range_start: num(row.range_start),
    range_end: num(row.range_end),
    price_total: num(row.price_total),
    ratio: num(row.ratio),
  }
}

function normaliseClass(row: Record<string, unknown>): ShareClass {
  return { ...(row as unknown as ShareClass), votes_per_share: Number(row.votes_per_share) }
}

export async function loadShareClasses(supabase: SupabaseClient, companyId: string): Promise<ShareClass[]> {
  const { data, error } = await supabase.from('share_classes').select('id, code, name, votes_per_share, forbehall_samtycke, forbehall_forkop, forbehall_hembud, forbehall_omvandling, forbehall_inlosen, forbehall_text, bolagsordning_reference').eq('company_id', companyId).order('code')
  if (error) throw new Error(`share_classes read failed: ${error.message}`)
  return ((data ?? []) as Record<string, unknown>[]).map(normaliseClass)
}

/**
 * Every entry of the company's aktiebok, in entry order. Read in pages: a
 * single read stops at 1,000 rows, and a register that silently lost its
 * newest entries (the rättelser among them) would answer wrong holdings.
 */
export async function loadShareEvents(supabase: SupabaseClient, companyId: string): Promise<ShareEvent[]> {
  const rows = await fetchAllRows<Record<string, unknown>>(
    ({ from, to }) =>
      supabase
        .from('share_register_events')
        .select('id, event_number, event_date, occurred_on, kind, share_class_id, to_share_class_id, from_party_id, to_party_id, range_start, range_end, transfer_reason, price_total, ratio, aktiebrev_number, aktiebrev_action, counterparty_party_id, note_status, corrects_event_id, registered_on, decision_id, document_id, journal_entry_id, note, created_at, created_via')
        .eq('company_id', companyId)
        .order('event_number')
        .range(from, to),
    { dedupeBy: (row) => String(row.id) },
  )
  return rows.map(normaliseEvent)
}

export interface RegisterSettings {
  is_avstamningsbolag: boolean
  /** When every share had been entered here; null while the register is set up. */
  setup_completed_at: string | null
}

export async function loadRegisterSettings(supabase: SupabaseClient, companyId: string): Promise<RegisterSettings> {
  const { data, error } = await supabase
    .from('share_register_settings')
    .select('is_avstamningsbolag, setup_completed_at')
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw new Error(`share_register_settings read failed: ${error.message}`)
  const row = data as { is_avstamningsbolag?: boolean; setup_completed_at?: string | null } | null
  return { is_avstamningsbolag: Boolean(row?.is_avstamningsbolag), setup_completed_at: row?.setup_completed_at ?? null }
}

async function loadShareCapitalSettings(supabase: SupabaseClient, companyId: string): Promise<{ aktiekapital: number | null; antal_aktier: number | null }> {
  const { data, error } = await supabase
    .from('company_settings')
    .select('aktiekapital, antal_aktier')
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw new Error(`company_settings read failed: ${error.message}`)
  const row = (data ?? {}) as { aktiekapital?: number | string | null; antal_aktier?: number | string | null }
  return {
    aktiekapital: row.aktiekapital === null || row.aktiekapital === undefined ? null : Number(row.aktiekapital),
    antal_aktier: row.antal_aktier === null || row.antal_aktier === undefined ? null : Number(row.antal_aktier),
  }
}

export interface ShareRegisterData {
  as_of: string
  is_avstamningsbolag: boolean
  /** When the setup was completed; null while the register is set up and an entry carries the day of the event. */
  setup_completed_at: string | null
  classes: ShareClass[]
  /** Every entry, in entry order (the history), voided ones included. */
  events: ShareEvent[]
  replay: ReplayResult
  summary: HoldingsSummary
  /** Every party the register names (holders, transferors, pledgees). */
  parties: Map<string, RegisterParty>
  reconciliation: ShareCapitalReconciliation
  /** Stored note entries the history cannot hold: left out of `replay`, to be voided with a rättelse. */
  note_problems: NoteProblem[]
}

/** How the stored register is read: a note entry the history cannot hold is left out and named, never fatal. */
const STORED = { notes: 'collect' } as const

/** The aktiebok as of a date (today when null). */
export async function loadShareRegisterData(ctx: OperationContext, asOf: string | null = null): Promise<ShareRegisterData> {
  const day = asOf ?? todayIsoStockholm()
  const [settings, classes, events, capital] = await Promise.all([
    loadRegisterSettings(ctx.supabase, ctx.companyId),
    loadShareClasses(ctx.supabase, ctx.companyId),
    loadShareEvents(ctx.supabase, ctx.companyId),
    loadShareCapitalSettings(ctx.supabase, ctx.companyId),
  ])
  const replay = replayShareRegister(events, day, STORED)
  const summary = summarizeHoldings(replay.ranges, classes)
  const partyIds = events.flatMap((e) => [e.from_party_id, e.to_party_id, e.counterparty_party_id]).filter((id): id is string => Boolean(id))
  const parties = await loadRegisterParties(ctx.companyId, partyIds)
  // Reconcile the register as it stands today with the settings (which hold today's figures).
  const current = asOf && asOf < todayIsoStockholm() ? replayShareRegister(events, null, STORED) : replay
  return {
    as_of: day,
    is_avstamningsbolag: settings.is_avstamningsbolag,
    setup_completed_at: settings.setup_completed_at,
    classes,
    events,
    replay,
    summary,
    parties,
    reconciliation: reconcileWithSettings(current.totalShares, capital),
    note_problems: current.noteProblems,
  }
}

/** A class by id or code; null when neither names one. */
function findClass(classes: readonly ShareClass[], id?: string | null, code?: string | null): ShareClass | null {
  if (id) return classes.find((c) => c.id === id) ?? null
  if (code) return classes.find((c) => c.code.toLowerCase() === code.trim().toLowerCase()) ?? null
  return null
}

export interface ShareEventInput {
  kind: ShareEventKind
  /**
   * The day of the event; today when left out. While the register is set up
   * the entry carries it. Once the register is in use the entry carries
   * today, and an earlier day given here is kept as occurred_on.
   */
  event_date?: string | null
  /** The day of the event, said beside an entry that carries a later day. */
  occurred_on?: string | null
  /**
   * This entry makes the register complete: once it is in, the setup is
   * completed (completeShareRegisterSetup) and the register is in use.
   */
  completes_setup?: boolean | null
  share_class_id?: string | null
  share_class_code?: string | null
  to_share_class_id?: string | null
  to_share_class_code?: string | null
  from_party_id?: string | null
  to_party_id?: string | null
  to_name?: string | null
  to_kind?: 'person' | 'company' | null
  to_org_number?: string | null
  range_start?: number | null
  range_end?: number | null
  share_count?: number | null
  transfer_reason?: TransferReason | null
  price_total?: number | null
  ratio?: number | null
  aktiebrev_number?: string | null
  aktiebrev_action?: 'issued' | 'returned' | null
  counterparty_party_id?: string | null
  counterparty_name?: string | null
  counterparty_kind?: 'person' | 'company' | null
  counterparty_org_number?: string | null
  note_status?: 'open' | 'closed' | null
  corrects_event_id?: string | null
  registered_on?: string | null
  decision_id?: string | null
  document_id?: string | null
  note?: string | null
  /** The person has handled the class's samtycke, förköp or hembud for this transfer. */
  forbehall_cleared?: boolean | null
  /** to_name is somebody new although a register person already has that name. */
  to_is_new?: boolean | null
  /** counterparty_name is somebody new although a register person already has that name. */
  counterparty_is_new?: boolean | null
  /**
   * The number of the last entry the caller saw (the preview answers it as
   * last_event_number). Sent back with the entry, it is refused with
   * SHARE_REGISTER_STALE when the register has moved on since: a transfer
   * previewed before a split would otherwise land on other shares.
   */
  expected_last_event_number?: number | null
  created_via?: 'app' | 'api' | 'mcp'
}

/** Said to a member who is neither the owner nor an administrator. */
export const REGISTER_ADMIN_MESSAGE_SV = 'Bara företagets ägare eller en administratör kan föra in något i aktieboken (styrelsen ansvarar för den, 5 kap. 7 § ABL).'

export interface ShareEventCreated {
  share_register_event_id: string
  event_number: number
  kind: ShareEventKind
  /** The day the entry carries. */
  event_date: string
  /** The day of the event when it is earlier than event_date. */
  occurred_on?: string | null
  range_start: number | null
  range_end: number | null
  share_class_id: string | null
  from_party_id: string | null
  to_party_id: string | null
  /** Set when the entry completed the setup of the register. */
  setup_completed_at?: string | null
}

const NEW_TO = 'new:to'
const NEW_COUNTERPARTY = 'new:counterparty'
const NEW_CLASS = 'new:class'
const CANDIDATE = 'candidate'

function warning(code: string, sv: string, en: string): OperationWarning {
  return { code, message_sv: sv, message_en: en }
}

function partyRef(id?: string | null, name?: string | null, kind?: 'person' | 'company' | null, org?: string | null): PartyRef | null {
  if (id) return { party_id: id }
  if (name && name.trim()) return { name, kind: kind ?? (org ? 'company' : 'person'), org_number: org ?? null }
  return null
}

/**
 * Add an aktiebok entry (dry-runnable). The dry run answers the holdings
 * before and after for the holders it touches, so the approver sees the
 * change, and the warnings a person must judge.
 */
export async function registerShareEvent(
  ctx: OperationContext,
  input: ShareEventInput,
  { dryRun }: { dryRun: boolean },
): Promise<OperationOutcome<ShareEventCreated>> {
  try {
    const today = todayIsoStockholm()
    const givenDate = input.event_date || today
    if (givenDate > today) return { ok: false, code: 'BOLAGET_DATES_INVALID', messageSv: 'En anteckning i aktieboken kan inte dateras framåt i tiden.' }
    if (input.occurred_on && input.occurred_on > givenDate) {
      return { ok: false, code: 'BOLAGET_DATES_INVALID', messageSv: 'Händelsens dag kan inte vara senare än anteckningens datum.' }
    }
    // Checked here so every door answers the same, a preview included: a
    // member is told before filling in a form or staging a proposal.
    const refused = await requireCompanyAdmin(ctx, REGISTER_ADMIN_MESSAGE_SV)
    if (refused) return refused
    const [settings, classes, events] = await Promise.all([
      loadRegisterSettings(ctx.supabase, ctx.companyId),
      loadShareClasses(ctx.supabase, ctx.companyId),
      loadShareEvents(ctx.supabase, ctx.companyId),
    ])
    if (settings.is_avstamningsbolag) return { ok: false, code: 'SHARE_REGISTER_AVSTAMNINGSBOLAG' }
    const lastEventNumber = events.reduce((max, e) => Math.max(max, e.event_number), 0)
    if (input.expected_last_event_number !== null && input.expected_last_event_number !== undefined && input.expected_last_event_number !== lastEventNumber) {
      return { ok: false, code: 'SHARE_REGISTER_STALE', details: { last_event_number: lastEventNumber } }
    }

    const kind = input.kind
    const warnings: OperationWarning[] = []

    // The day the entry belongs to. In use, the register takes no holding
    // carried over from an earlier register, and an entry carries today.
    const inUse = settings.setup_completed_at !== null
    if (kind === 'ingaende' && inUse) return { ok: false, code: 'SHARE_REGISTER_SETUP_COMPLETE' }
    if (input.completes_setup && inUse) return { ok: false, code: 'SHARE_REGISTER_SETUP_COMPLETE', messageSv: 'Aktieboken är redan upplagd och i bruk.' }
    const eventDate = inUse ? today : givenDate
    const occurredOn = entryOccurredOn(eventDate, input.occurred_on ?? (inUse ? givenDate : null))
    if (inUse && givenDate < today && !input.occurred_on) {
      warnings.push(warning(
        'SHARE_REGISTER_DATED_ENTRY_DAY',
        `Aktieboken är i bruk: anteckningen dateras ${today}, den dag den förs in. Händelsens dag ${givenDate} står i anteckningen.`,
        `The share register is in use: the entry is dated ${today}, the day it is made. The day of the event, ${givenDate}, is stated in the entry.`,
      ))
    }

    // The class: named, the only one, or (first issue in an empty register) a new class A with one vote per share.
    let shareClass = findClass(classes, input.share_class_id, input.share_class_code)
    let createDefaultClass = false
    const needsClass = ISSUE_KINDS.includes(kind) || HOLDER_KINDS.includes(kind)
    if (needsClass && !shareClass) {
      if (input.share_class_id || input.share_class_code) return { ok: false, code: 'SHARE_CLASS_NOT_FOUND' }
      if (classes.length === 1) shareClass = classes[0]!
      else if (classes.length === 0 && ISSUE_KINDS.includes(kind)) createDefaultClass = true
      else return { ok: false, code: 'SHARE_CLASS_REQUIRED' }
    }
    const classId = shareClass?.id ?? (createDefaultClass ? NEW_CLASS : null)
    let toClassId: string | null = null
    if (kind === 'omvandling') {
      const toClass = findClass(classes, input.to_share_class_id, input.to_share_class_code)
      if (!toClass) return { ok: false, code: 'SHARE_CLASS_NOT_FOUND' }
      toClassId = toClass.id
    }

    if (kind === 'omvandling' && toClassId === classId) {
      return { ok: false, code: 'VALIDATION_ERROR', messageSv: 'Aktierna har redan det aktieslaget. Välj ett annat aktieslag att omvandla till.' }
    }

    // The parties.
    let toRef = ISSUE_KINDS.includes(kind) || kind === 'overlatelse' ? partyRef(input.to_party_id, input.to_name, input.to_kind, input.to_org_number) : null
    let counterRef = kind === 'pant' || kind === 'nyttjanderatt'
      ? partyRef(input.counterparty_party_id, input.counterparty_name, input.counterparty_kind, input.counterparty_org_number)
      : null
    if ((ISSUE_KINDS.includes(kind) || kind === 'overlatelse') && !toRef) return { ok: false, code: 'BOLAGET_PARTY_INVALID', messageSv: 'Ange vem som får aktierna.' }
    if ((kind === 'pant' || kind === 'nyttjanderatt') && !counterRef) {
      return { ok: false, code: 'BOLAGET_PARTY_INVALID', messageSv: kind === 'pant' ? 'Ange panthavaren.' : 'Ange den som har nyttjanderätten.' }
    }
    if (HOLDER_KINDS.includes(kind) && !input.from_party_id) return { ok: false, code: 'BOLAGET_PARTY_INVALID', messageSv: 'Ange nuvarande ägare av aktierna.' }
    if (toRef) checkPartyRef(toRef, 'mottagaren')
    if (counterRef) checkPartyRef(counterRef, 'motparten')
    // A person given by name who is already in the registers is that person,
    // and the preview says so before anything is saved. Somebody new with the
    // same name is entered with to_is_new (or counterparty_is_new).
    const matched: Array<{ field: 'to' | 'counterparty'; party_id: string; name: string }> = []
    if (toRef && !toRef.party_id && toRef.kind === 'person' && !input.to_is_new) {
      const match = await findRegisterPersonByName(ctx.supabase, ctx.companyId, toRef.name!)
      if (match) {
        matched.push({ field: 'to', ...match })
        toRef = { party_id: match.party_id }
      }
    }
    if (counterRef && !counterRef.party_id && counterRef.kind === 'person' && !input.counterparty_is_new) {
      const match = await findRegisterPersonByName(ctx.supabase, ctx.companyId, counterRef.name!)
      if (match) {
        matched.push({ field: 'counterparty', ...match })
        counterRef = { party_id: match.party_id }
      }
    }
    await assertPartiesInCompany(ctx.supabase, ctx.companyId, [input.from_party_id, toRef?.party_id, counterRef?.party_id])
    if (kind === 'overlatelse' && toRef?.party_id && toRef.party_id === input.from_party_id) {
      return { ok: false, code: 'BOLAGET_PARTY_INVALID', messageSv: 'Överlåtaren och mottagaren är samma. Välj en annan mottagare.' }
    }

    // The share numbers: given, or for a count the next free numbers (an issue) or the holder's lowest block that fits.
    let rangeStart = input.range_start ?? null
    let rangeEnd = input.range_end ?? null
    const rangeKinds: readonly ShareEventKind[] = [...ISSUE_KINDS, ...HOLDER_KINDS, 'aktiebrev', 'pant', 'nyttjanderatt']
    if (rangeKinds.includes(kind)) {
      const count = input.share_count ?? null
      if (rangeStart === null && count) {
        const stored = replayShareRegister(events, null, STORED)
        if (ISSUE_KINDS.includes(kind)) {
          rangeStart = nextFreeShareNumber(stored.ranges)
        } else if (HOLDER_KINDS.includes(kind)) {
          const asOfDay = replayShareRegister(events, eventDate, STORED)
          const block = asOfDay.ranges.find(
            (r) => r.party_id === input.from_party_id && r.share_class_id === classId && r.range_end - r.range_start + 1 >= count,
          )
          if (!block) return { ok: false, code: 'SHARE_REGISTER_RANGE_REQUIRED' }
          rangeStart = block.range_start
        }
      }
      if (rangeStart === null) return { ok: false, code: 'SHARE_REGISTER_RANGE_REQUIRED' }
      // A first number with a count names the block: 500 shares from number 1 are 1 to 500, not share 1 alone.
      if (rangeEnd === null) rangeEnd = count ? rangeStart + count - 1 : rangeStart
      if (rangeEnd < rangeStart) return { ok: false, code: 'SHARE_REGISTER_RANGE_REQUIRED' }
      if (count && rangeEnd - rangeStart + 1 !== count) {
        return { ok: false, code: 'VALIDATION_ERROR', messageSv: `Antalet aktier (${count}) stämmer inte med aktienumren ${rangeStart}-${rangeEnd}. Ange det ena eller rätta det andra.` }
      }
    } else {
      rangeStart = null
      rangeEnd = null
    }
    if ((kind === 'split' || kind === 'sammanlaggning') && !(input.ratio && input.ratio >= 2)) {
      return { ok: false, code: 'VALIDATION_ERROR', messageSv: 'Ange kvoten (minst 2).' }
    }
    if (kind === 'overlatelse' && !input.transfer_reason) return { ok: false, code: 'VALIDATION_ERROR', messageSv: 'Ange grunden för överlåtelsen (köp, gåva, arv ...).' }
    if (kind === 'aktiebrev' && (!input.aktiebrev_number?.trim() || !input.aktiebrev_action)) {
      return { ok: false, code: 'VALIDATION_ERROR', messageSv: 'Ange aktiebrevets nummer och om det utfärdas eller makuleras.' }
    }
    if ((kind === 'pant' || kind === 'nyttjanderatt') && !input.note_status) return { ok: false, code: 'VALIDATION_ERROR', messageSv: 'Ange om anteckningen öppnas eller avslutas.' }
    // A note that only completes the setup brings no text of its own: the
    // register's note of the completion is the entry, and no other is made.
    const completionOnly = kind === 'anteckning' && Boolean(input.completes_setup) && !input.note?.trim()
    if ((kind === 'anteckning' || kind === 'rattelse') && !input.note?.trim() && !completionOnly) {
      return { ok: false, code: 'VALIDATION_ERROR', messageSv: kind === 'rattelse' ? 'Ange varför anteckningen rättas.' : 'Skriv anteckningen.' }
    }

    const candidate: ShareEvent = {
      id: CANDIDATE,
      event_number: 0,
      event_date: eventDate,
      occurred_on: occurredOn,
      kind,
      share_class_id: classId,
      to_share_class_id: toClassId,
      from_party_id: HOLDER_KINDS.includes(kind) ? input.from_party_id ?? null : null,
      to_party_id: toRef ? toRef.party_id ?? NEW_TO : null,
      range_start: rangeStart,
      range_end: rangeEnd,
      transfer_reason: kind === 'overlatelse' ? input.transfer_reason ?? null : null,
      price_total: input.price_total ?? null,
      ratio: kind === 'split' || kind === 'sammanlaggning' ? input.ratio ?? null : null,
      aktiebrev_number: kind === 'aktiebrev' ? input.aktiebrev_number!.trim() : null,
      aktiebrev_action: kind === 'aktiebrev' ? input.aktiebrev_action ?? null : null,
      counterparty_party_id: counterRef ? counterRef.party_id ?? NEW_COUNTERPARTY : null,
      note_status: kind === 'pant' || kind === 'nyttjanderatt' ? input.note_status ?? null : null,
      corrects_event_id: kind === 'rattelse' ? input.corrects_event_id ?? null : null,
      registered_on: input.registered_on ?? null,
      decision_id: input.decision_id ?? null,
      document_id: input.document_id ?? null,
      journal_entry_id: null,
      note: input.note?.trim() || null,
      created_at: new Date().toISOString(),
    }
    if (kind === 'rattelse') {
      if (!candidate.corrects_event_id) return { ok: false, code: 'SHARE_REGISTER_CORRECTION_INVALID' }
      checkCorrection(events, candidate.corrects_event_id)
    }

    // The whole history must still hold with the entry in it (the database
    // checks the holdings again at commit). A note entry already stored that
    // the history cannot hold is not this entry's doing, and must not stop the
    // rättelse that voids it; one this entry brings about is refused.
    const withEntry = [...events, candidate]
    const alreadyBroken = new Set(replayShareRegister(events, null, STORED).noteProblems.map((problem) => problem.event_id))
    const broken = replayShareRegister(withEntry, null, STORED).noteProblems.find((problem) => !alreadyBroken.has(problem.event_id))
    if (broken) throw new ShareRegisterError('SHARE_REGISTER_NOTE_INVALID', broken.message, broken.event_number > 0 ? broken.event_number : null)
    const before = replayShareRegister(events, eventDate, STORED)
    const after = replayShareRegister(withEntry, eventDate, STORED)
    if (input.completes_setup) {
      // A register is complete when it holds the company's shares: with this entry in, it must hold some.
      if (replayShareRegister(withEntry, null, STORED).totalShares === 0) return { ok: false, code: 'SHARE_REGISTER_EMPTY' }
      warnings.push(warning(
        'SHARE_REGISTER_SETUP_COMPLETES',
        'Med den här anteckningen är aktieboken upplagd och tas i bruk. Härefter dateras varje anteckning den dag den förs in, och ingående innehav kan inte längre föras in. Det kan inte ångras. En aktiebok som fördes tidigare ska bevaras i minst tio år (5 kap. 3 § ABL).',
        'With this entry the share register is set up and taken into use. From then on every entry carries the day it is made, and no opening holding is taken. This cannot be undone. A share register kept before must be kept for at least ten years (ABL 5:3).',
      ))
    }

    // What a person must judge.
    if (kind === 'overlatelse' && shareClass && (shareClass.forbehall_samtycke || shareClass.forbehall_forkop || shareClass.forbehall_hembud) && !input.forbehall_cleared) {
      warnings.push(warning(
        'SHARE_REGISTER_FORBEHALL_OPEN',
        'Aktieslaget har samtyckes-, förköps- eller hembudsförbehåll. Kontrollera att förbehållet är hanterat innan överlåtelsen förs in.',
        'The share class carries a consent, pre-emption or right-of-first-refusal clause. Check it has been handled before entering the transfer.',
      ))
    }
    if (kind === 'ingaende') {
      warnings.push(warning(
        'SHARE_REGISTER_KEEP_EARLIER_REGISTER',
        'Ett ingående innehav förs in från den aktiebok bolaget har fört tidigare, med de aktienummer som står där. Den tidigare aktieboken ska bevaras i minst tio år efter att alla aktier har förts in här (5 kap. 3 § ABL).',
        'An opening holding is carried over from the share register the company kept before, with the share numbers that register gives. That earlier register must be kept for at least ten years after every share has been entered here (ABL 5:3).',
      ))
    }
    if (kind === 'nyemission' && !input.registered_on) {
      warnings.push(warning(
        'SHARE_REGISTER_NOT_REGISTERED',
        'De tilldelade aktierna förs in nu (13 kap. 18 § ABL). En införd anteckning ändras inte: när Bolagsverket har registrerat emissionen förs registreringsdagen in som en egen anteckning.',
        'The allotted shares are entered now (ABL 13:18). An entry is never changed: once Bolagsverket has registered the issue, record the registration date as a note of its own.',
      ))
    }
    if (kind === 'fondemission' && !input.registered_on) {
      warnings.push(warning(
        'SHARE_REGISTER_FONDEMISSION_NOT_REGISTERED',
        'Aktier från en fondemission förs in i aktieboken först när Bolagsverket har registrerat beslutet (12 kap. 10 § ABL). Ange registreringsdagen, eller vänta med anteckningen tills beslutet är registrerat.',
        'Bonus shares are entered in the share register only once Bolagsverket has registered the decision (ABL 12:10). Give the registration date, or wait with the entry until the decision is registered.',
      ))
    }
    for (const match of matched) {
      warnings.push(warning(
        'BOLAGET_PARTY_MATCHED_EXISTING',
        `${match.name} finns redan i bolagets register och anteckningen förs på den personen. Gäller det någon annan med samma namn, lägg in personen som ny.`,
        `${match.name} is already in the company's registers and the entry is made for that person. If this is somebody else with the same name, enter them as a new person.`,
      ))
    }
    if (toRef && !toRef.party_id && (toRef.kind ?? 'person') === 'person') {
      warnings.push(warning(
        'BOLAGET_PERSONNUMMER_MISSING',
        'Lägg till personnummer och adress för den nya ägaren under Aktiebok (5 kap. 5 § ABL).',
        'Add the new holder\'s personnummer and address in Aktiebok (ABL 5:5).',
      ))
    }

    if (dryRun) {
      // Whose holdings the entry changes: the parties it names; for a rättelse
      // the parties of the entry it voids; for a split or a sammanläggning
      // every holder, since every share is renumbered.
      const voidedEntry = kind === 'rattelse' ? events.find((e) => e.id === candidate.corrects_event_id) ?? null : null
      const everyHolder = kind === 'split' || kind === 'sammanlaggning' ? [...before.ranges, ...after.ranges].map((r) => r.party_id) : []
      const touched = new Set(
        [candidate.from_party_id, candidate.to_party_id, voidedEntry?.from_party_id, voidedEntry?.to_party_id, ...everyHolder].filter((id): id is string => Boolean(id)),
      )
      const holdingOf = (ranges: ReplayResult['ranges'], partyId: string) =>
        ranges.filter((r) => r.party_id === partyId).reduce((n, r) => n + (r.range_end - r.range_start + 1), 0)
      return {
        ok: true,
        dryRun: true,
        preview: {
          kind,
          kind_label: SHARE_EVENT_LABELS_SV[kind],
          // The day the entry will carry, and the day of the event when that is earlier.
          event_date: eventDate,
          occurred_on: occurredOn,
          register_in_use: inUse,
          completes_setup: Boolean(input.completes_setup),
          share_class: shareClass ? shareClass.code : createDefaultClass ? 'A' : null,
          creates_share_class: createDefaultClass ? 'A' : null,
          range_start: rangeStart,
          range_end: rangeEnd,
          share_count: rangeStart !== null && rangeEnd !== null ? rangeEnd - rangeStart + 1 : null,
          from_party_id: candidate.from_party_id,
          to: toRef ? (toRef.party_id ? { party_id: toRef.party_id } : { name: toRef.name, kind: toRef.kind ?? 'person' }) : null,
          counterparty: counterRef ? (counterRef.party_id ? { party_id: counterRef.party_id } : { name: counterRef.name }) : null,
          transfer_reason: candidate.transfer_reason,
          price_total: candidate.price_total,
          ratio: candidate.ratio,
          corrects_event_id: candidate.corrects_event_id,
          corrects_event_number: voidedEntry?.event_number ?? null,
          // Send back as expected_last_event_number with the entry itself.
          last_event_number: lastEventNumber,
          // Named people who were already in the registers: the entry is made for them.
          matched_parties: matched,
          total_shares_before: before.totalShares,
          total_shares_after: after.totalShares,
          holders_changed: [...touched].map((partyId) => ({
            party_id: partyId.startsWith('new:') ? null : partyId,
            new_party: partyId.startsWith('new:'),
            shares_before: holdingOf(before.ranges, partyId),
            shares_after: holdingOf(after.ranges, partyId),
          })),
          warnings: warnings.map((w) => w.message_sv),
          // The code of each warning, in the same order: a caller that says one of them its own way leaves that sentence out by code.
          warning_codes: warnings.map((w) => w.code),
        },
      }
    }

    if (completionOnly) {
      // Nothing of its own to enter: completing the setup has the database
      // write the register's note, and that note is what the caller gets back.
      const completed = await completeShareRegisterSetup(ctx, { expected_last_event_number: lastEventNumber }, { dryRun: false })
      if (!completed.ok) return completed
      if (completed.dryRun || !completed.data.completed_now) return { ok: false, code: 'SHARE_REGISTER_SETUP_COMPLETE', messageSv: 'Aktieboken är redan upplagd och i bruk.' }
      // The note is written in the completing write itself and carries its moment: a note made right after does not.
      const completedAt = Date.parse(completed.data.setup_completed_at)
      const written = (await loadShareEvents(ctx.supabase, ctx.companyId)).find(
        (e) => e.kind === 'anteckning' && e.event_number > lastEventNumber && Date.parse(e.created_at) === completedAt,
      )
      if (!written) throw new Error('share_register_events: the note of the completed setup was not written')
      return {
        ok: true,
        data: {
          share_register_event_id: written.id,
          event_number: written.event_number,
          kind,
          event_date: written.event_date,
          occurred_on: null,
          range_start: null,
          range_end: null,
          share_class_id: null,
          from_party_id: null,
          to_party_id: null,
          setup_completed_at: completed.data.setup_completed_at,
        },
        created: true,
        ...(warnings.length > 0 ? { warnings } : {}),
      }
    }

    // Commit: the parties and the class first, then the entry.
    let finalClassId = shareClass?.id ?? null
    if (createDefaultClass) {
      const created = await insertShareClass(ctx, { code: 'A', name: null, votes_per_share: 1 })
      finalClassId = created.id
    }
    // A named person was looked for above; whoever is still unnamed here is new.
    const partyOf = (ref: PartyRef) => (ref.party_id || ref.kind !== 'person' ? ensureRegisterParty(ctx, ref) : createRegisterParty(ctx, ref))
    const toPartyId = toRef ? await partyOf(toRef) : null
    const counterpartyId = counterRef ? await partyOf(counterRef) : null
    const { data, error } = await ctx.supabase
      .from('share_register_events')
      .insert({
        company_id: ctx.companyId,
        event_date: eventDate,
        occurred_on: occurredOn,
        kind,
        share_class_id: needsClass ? finalClassId : null,
        to_share_class_id: toClassId,
        from_party_id: candidate.from_party_id,
        to_party_id: toPartyId,
        range_start: rangeStart,
        range_end: rangeEnd,
        transfer_reason: candidate.transfer_reason,
        price_total: candidate.price_total,
        ratio: candidate.ratio,
        aktiebrev_number: candidate.aktiebrev_number,
        aktiebrev_action: candidate.aktiebrev_action,
        counterparty_party_id: counterpartyId,
        note_status: candidate.note_status,
        corrects_event_id: candidate.corrects_event_id,
        registered_on: candidate.registered_on,
        decision_id: candidate.decision_id,
        document_id: candidate.document_id,
        note: candidate.note,
        details: input.forbehall_cleared ? { forbehall_cleared: true } : {},
        // The last entry this check saw: the database refuses the row when another entry got in between.
        based_on_event_number: lastEventNumber,
        created_by: ctx.userId,
        created_via: input.created_via ?? (ctx.pendingOperationId ? 'mcp' : 'app'),
      })
      // The database has the last word on the day (share_register_events_number): read it back.
      .select('id, event_number, event_date, occurred_on')
      .single()
    if (error) return bolagetFailure(error)
    const row = data as { id: string; event_number: number; event_date?: string | null; occurred_on?: string | null }
    // The entry is in and stays. Completing the setup is its own write: if it
    // fails the register is still being set up, and the caller is told.
    let setupCompletedAt: string | null = null
    if (input.completes_setup) {
      const completed = await completeShareRegisterSetup(ctx, {}, { dryRun: false })
      if (completed.ok && !completed.dryRun) setupCompletedAt = completed.data.setup_completed_at
      else {
        warnings.push(warning(
          'SHARE_REGISTER_SETUP_NOT_COMPLETED',
          'Anteckningen är införd, men aktieboken kunde inte markeras som upplagd. Markera den som upplagd under Aktiebok.',
          'The entry is made, but the share register could not be marked as set up. Mark it as set up in Aktiebok.',
        ))
      }
    }
    return {
      ok: true,
      data: {
        share_register_event_id: row.id,
        event_number: Number(row.event_number),
        kind,
        event_date: row.event_date ?? eventDate,
        occurred_on: row.occurred_on ?? occurredOn,
        range_start: rangeStart,
        range_end: rangeEnd,
        share_class_id: needsClass ? finalClassId : null,
        from_party_id: candidate.from_party_id,
        to_party_id: toPartyId,
        ...(input.completes_setup ? { setup_completed_at: setupCompletedAt } : {}),
      },
      created: true,
      ...(warnings.length > 0 ? { warnings } : {}),
    }
  } catch (error) {
    if (error instanceof ShareRegisterError) return bolagetFailure(error)
    return bolagetFailure(error)
  }
}

/** The day of the event as an entry keeps it: only when it is earlier than the day the entry carries. */
export function entryOccurredOn(eventDate: string, occurredOn: string | null | undefined): string | null {
  return occurredOn && occurredOn < eventDate ? occurredOn : null
}

export interface SetupCompleted {
  setup_completed_at: string
  total_shares: number
  holders: number
  /** False when the setup had been completed before this call. */
  completed_now: boolean
}

/**
 * Say that every share of the company is entered (dry-runnable). From then
 * on an entry carries the day it is made, and no opening holding is taken.
 * The database enters the completion in the register as a dated note: it is
 * the day ABL 5:3 counts the ten years of an earlier register from. Done
 * once; a second call answers the first one's moment.
 */
export async function completeShareRegisterSetup(
  ctx: OperationContext,
  input: { expected_last_event_number?: number | null },
  { dryRun }: { dryRun: boolean },
): Promise<OperationOutcome<SetupCompleted>> {
  try {
    const refused = await requireCompanyAdmin(ctx, REGISTER_ADMIN_MESSAGE_SV)
    if (refused) return refused
    const [settings, classes, events, capital] = await Promise.all([
      loadRegisterSettings(ctx.supabase, ctx.companyId),
      loadShareClasses(ctx.supabase, ctx.companyId),
      loadShareEvents(ctx.supabase, ctx.companyId),
      loadShareCapitalSettings(ctx.supabase, ctx.companyId),
    ])
    if (settings.is_avstamningsbolag) return { ok: false, code: 'SHARE_REGISTER_AVSTAMNINGSBOLAG' }
    const lastEventNumber = events.reduce((max, e) => Math.max(max, e.event_number), 0)
    const summary = summarizeHoldings(replayShareRegister(events, null, STORED).ranges, classes)
    const answer = (completedAt: string, completedNow: boolean): SetupCompleted => ({
      setup_completed_at: completedAt,
      total_shares: summary.total_shares,
      holders: summary.holders.length,
      completed_now: completedNow,
    })
    if (settings.setup_completed_at && !dryRun) return { ok: true, data: answer(settings.setup_completed_at, false) }
    if (input.expected_last_event_number !== null && input.expected_last_event_number !== undefined && input.expected_last_event_number !== lastEventNumber) {
      return { ok: false, code: 'SHARE_REGISTER_STALE', details: { last_event_number: lastEventNumber } }
    }
    if (summary.total_shares === 0) return { ok: false, code: 'SHARE_REGISTER_EMPTY' }
    const reconciliation = reconcileWithSettings(summary.total_shares, capital)
    if (dryRun) {
      const warnings: string[] = []
      if (reconciliation.status === 'mismatch') {
        warnings.push(`Aktieboken har ${summary.total_shares} aktier men företagsuppgifterna anger ${reconciliation.settings_shares}. Kontrollera vilket som stämmer innan aktieboken tas i bruk.`)
      }
      return {
        ok: true,
        dryRun: true,
        preview: {
          already_completed_at: settings.setup_completed_at,
          total_shares: summary.total_shares,
          holders: summary.holders.length,
          last_event_number: lastEventNumber,
          consequence_sv:
            'Aktieboken tas i bruk. Härefter dateras varje anteckning den dag den förs in, och ingående innehav kan inte längre föras in. Det antecknas i aktieboken och kan inte ångras. En aktiebok som fördes tidigare ska bevaras i minst tio år (5 kap. 3 § ABL).',
          warnings,
        },
      }
    }
    const { data, error } = await ctx.supabase
      .from('share_register_settings')
      .upsert({ company_id: ctx.companyId, setup_completed_at: new Date().toISOString(), setup_completed_by: ctx.userId }, { onConflict: 'company_id' })
      .select('setup_completed_at')
      .single()
    if (error) return bolagetFailure(error)
    const completedAt = (data as { setup_completed_at: string | null }).setup_completed_at
    if (!completedAt) throw new Error('share_register_settings: the setup was not completed')
    return { ok: true, data: answer(completedAt, true) }
  } catch (error) {
    return bolagetFailure(error)
  }
}

export interface ShareClassInput {
  code: string
  name?: string | null
  votes_per_share: number
  forbehall_samtycke?: boolean
  forbehall_forkop?: boolean
  forbehall_hembud?: boolean
  forbehall_omvandling?: boolean
  forbehall_inlosen?: boolean
  forbehall_text?: string | null
  bolagsordning_reference?: string | null
}

async function insertShareClass(ctx: OperationContext, input: ShareClassInput): Promise<ShareClass> {
  const { data, error } = await ctx.supabase
    .from('share_classes')
    .insert({
      company_id: ctx.companyId,
      code: input.code.trim(),
      name: input.name?.trim() || null,
      votes_per_share: input.votes_per_share,
      forbehall_samtycke: input.forbehall_samtycke ?? false,
      forbehall_forkop: input.forbehall_forkop ?? false,
      forbehall_hembud: input.forbehall_hembud ?? false,
      forbehall_omvandling: input.forbehall_omvandling ?? false,
      forbehall_inlosen: input.forbehall_inlosen ?? false,
      forbehall_text: input.forbehall_text?.trim() || null,
      bolagsordning_reference: input.bolagsordning_reference?.trim() || null,
    })
    .select('id, code, name, votes_per_share, forbehall_samtycke, forbehall_forkop, forbehall_hembud, forbehall_omvandling, forbehall_inlosen, forbehall_text, bolagsordning_reference')
    .single()
  if (error) {
    if (error.code === '23505') throw Object.assign(new Error('SHARE_CLASS_DUPLICATE'), { shareClassDuplicate: true })
    throw new Error(`share_classes insert failed: ${error.message}`)
  }
  return normaliseClass(data as Record<string, unknown>)
}

/** ABL 4:5: no class may carry more than ten times the votes of another. A warning, not a refusal. */
export function votesRatioWarning(classes: ReadonlyArray<Pick<ShareClass, 'votes_per_share'>>): OperationWarning | null {
  const votes = classes.map((c) => Number(c.votes_per_share)).filter((v) => v > 0)
  if (votes.length < 2) return null
  if (Math.max(...votes) <= Math.min(...votes) * 10) return null
  return warning(
    'SHARE_CLASS_VOTES_RATIO',
    'Ett aktieslag får ha högst tio gånger så många röster som ett annat (4 kap. 5 § ABL). Kontrollera bolagsordningen.',
    'One share class may carry at most ten times the votes of another (ABL 4:5). Check the articles of association.',
  )
}

/** Add a share class (dry-runnable). */
export async function createShareClass(
  ctx: OperationContext,
  input: ShareClassInput,
  { dryRun }: { dryRun: boolean },
): Promise<OperationOutcome<ShareClass>> {
  try {
    const classes = await loadShareClasses(ctx.supabase, ctx.companyId)
    if (classes.some((c) => c.code.toLowerCase() === input.code.trim().toLowerCase())) return { ok: false, code: 'SHARE_CLASS_DUPLICATE' }
    const ratio = votesRatioWarning([...classes, { votes_per_share: input.votes_per_share }])
    if (dryRun) return { ok: true, dryRun: true, preview: { ...input, code: input.code.trim(), warnings: ratio ? [ratio.message_sv] : [] } }
    const created = await insertShareClass(ctx, input)
    return { ok: true, data: created, created: true, ...(ratio ? { warnings: [ratio] } : {}) }
  } catch (error) {
    if (error instanceof Error && (error as { shareClassDuplicate?: boolean }).shareClassDuplicate) return { ok: false, code: 'SHARE_CLASS_DUPLICATE' }
    return bolagetFailure(error)
  }
}

export type ShareClassPatch = Partial<Omit<ShareClassInput, 'code'>>

/** Change a share class's name, votes or förbehåll (dry-runnable). Its code stays: entries point at it. */
export async function updateShareClass(
  ctx: OperationContext,
  shareClassId: string,
  patch: ShareClassPatch,
  { dryRun }: { dryRun: boolean },
): Promise<OperationOutcome<ShareClass>> {
  try {
    const classes = await loadShareClasses(ctx.supabase, ctx.companyId)
    const current = classes.find((c) => c.id === shareClassId)
    if (!current) return { ok: false, code: 'SHARE_CLASS_NOT_FOUND' }
    const text = (value: string | null | undefined) => (value === undefined ? undefined : value?.trim() || null)
    // Undefined keys are left out of the request, so an absent field keeps its value.
    const changes = {
      name: text(patch.name),
      votes_per_share: patch.votes_per_share,
      forbehall_samtycke: patch.forbehall_samtycke,
      forbehall_forkop: patch.forbehall_forkop,
      forbehall_hembud: patch.forbehall_hembud,
      forbehall_omvandling: patch.forbehall_omvandling,
      forbehall_inlosen: patch.forbehall_inlosen,
      forbehall_text: text(patch.forbehall_text),
      bolagsordning_reference: text(patch.bolagsordning_reference),
    }
    const changed = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined))
    const merged = { ...current, ...changed } as ShareClass
    const ratio = votesRatioWarning(classes.map((c) => (c.id === shareClassId ? merged : c)))
    if (dryRun) return { ok: true, dryRun: true, preview: { share_class_id: shareClassId, code: current.code, changes: changed, warnings: ratio ? [ratio.message_sv] : [] } }
    if (Object.keys(changed).length === 0) return { ok: true, data: current }
    const { data, error } = await ctx.supabase
      .from('share_classes')
      .update({
        name: changes.name,
        votes_per_share: changes.votes_per_share,
        forbehall_samtycke: changes.forbehall_samtycke,
        forbehall_forkop: changes.forbehall_forkop,
        forbehall_hembud: changes.forbehall_hembud,
        forbehall_omvandling: changes.forbehall_omvandling,
        forbehall_inlosen: changes.forbehall_inlosen,
        forbehall_text: changes.forbehall_text,
        bolagsordning_reference: changes.bolagsordning_reference,
      })
      .eq('company_id', ctx.companyId)
      .eq('id', shareClassId)
      .select('id, code, name, votes_per_share, forbehall_samtycke, forbehall_forkop, forbehall_hembud, forbehall_omvandling, forbehall_inlosen, forbehall_text, bolagsordning_reference')
      .single()
    if (error) throw new Error(`share_classes update failed: ${error.message}`)
    return { ok: true, data: normaliseClass(data as Record<string, unknown>), ...(ratio ? { warnings: [ratio] } : {}) }
  } catch (error) {
    return bolagetFailure(error)
  }
}

/** Mark the company an avstämningsbolag (or not): the register then takes no entries (ABL 5:11-12). */
export async function setAvstamningsbolag(ctx: OperationContext, value: boolean): Promise<void> {
  const { error } = await ctx.supabase
    .from('share_register_settings')
    .upsert({ company_id: ctx.companyId, is_avstamningsbolag: value }, { onConflict: 'company_id' })
  if (error) throw new Error(`share_register_settings upsert failed: ${error.message}`)
}
