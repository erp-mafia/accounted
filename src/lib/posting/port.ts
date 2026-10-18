import { getActor, type CommitActor } from '@/lib/bookkeeping/actor-context'
import { assertLinesWellFormed, validateBalance } from '@/lib/bookkeeping/engine'
import { BookkeepingDatabaseError } from '@/lib/bookkeeping/errors'
import { isHandleType } from '@/lib/handles/registry'
import { createLogger } from '@/lib/logger'
import type { CreateJournalEntryLineInput, JournalEntry } from '@/types'
import { isBusinessEventCategory } from './categories'
import { cleanBusinessEventEvidence } from './evidence'
import { isBusinessEventKind } from './kinds'
import { ledgerAdapter } from './ledger-adapter'
import { postingEventsMode, type PostingEventsMode } from './mode'
import {
  BusinessEventWriteError,
  recordBusinessEvent,
  type BusinessEventEntryRole,
  type BusinessEventLink,
  type BusinessEventRow,
  type SqlBusinessEventLink,
} from './store'
import type { BusinessEventDraft, CorrectJournalEntryResult, PostingAdapter, PostingPort } from './types'

/**
 * The posting port (Phase 2 of the building-blocks plan, step 1).
 *
 * Every posting that goes through here records what happened in business
 * terms (a business_events row) and is linked to the verifikat it produced.
 * The producer still builds its own journal lines and the port hands them to
 * the ledger adapter unchanged, which is what keeps booking output identical.
 *
 * Order, for one posting under shadow or strict:
 *   1. the port checks the event against the closed lists and writes it
 *      (business_events), before anything else;
 *   2. the engine inserts the draft header, then the link
 *      (business_event_entries), then the lines;
 *   3. commit_journal_entry draws the voucher number and posts.
 * A set of verifikat that is one business act (postJournalEntrySet: a
 * salary run) records ONE event in 1 and links it to every draft of the set
 * in 2, all before the first number is drawn in 3.
 * A correction (correctJournalEntry) records TWO events in 1, the storno's and
 * the corrected verifikat's, and the storno service links each to its own
 * draft in 2. The storno is numbered and posted before the corrected
 * verifikat is drafted, so the corrected verifikat's link is the one write in
 * 2 that comes after a number: refused under strict, the posted storno is
 * cancelled as any later failure of a correction cancels it, and keeps its
 * number as a cancelled verifikat (the series has no gap).
 * Any other failure in 1 or 2 never costs a number. Under shadow it is
 * logged and the posting goes ahead without the event (or without its link);
 * under strict it stops the posting (BookkeepingDatabaseError). With
 * POSTING_EVENTS off, nothing in 1 or 2 runs and the adapter is called with
 * the producer's arguments as they were.
 *
 * An import job (recordEvent) records ONE event in 1 and links nothing: its
 * verifikat are written in SQL by import_sie_chunk, chunk by chunk, and the
 * read-side projection (./project.ts) names the job per entry. Under strict a
 * failed write throws and the producer decides what it stops; the import
 * worker holds the job's completion, as its verifikat are numbered already.
 *
 * A SQL posting function (recordEventsForSql) drafts and commits its own
 * verifikat in one transaction, so 2 moves into SQL: the port records the
 * events in 1 and answers their ids, the producer hands them to the
 * function, which links each draft it writes before commit_journal_entry
 * draws the number (public.link_business_events_to_draft). A refused link is
 * logged by the function under shadow and fails it under strict, before any
 * number; a refused event write is the port's, as for any posting.
 *
 * Kept free of the event bus and lib/init (the antipattern guard counts
 * lib/init's reach); the engine announces the posting as it always has.
 */

const log = createLogger('posting.port')

/** How many events recordEventsForSql writes at once (a bulk booking has up to 200). */
const SQL_EVENT_WRITE_WAVE = 10

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CURRENCY = /^[A-Z]{3}$/
const JURISDICTION = /^[A-Z]{2}$/

/** An event that does not fit the closed lists or the table's shape: a producer bug. */
export class BusinessEventInvalidError extends Error {
  constructor(reason: string) {
    super(`POSTING_EVENT_INVALID: ${reason}`)
    this.name = 'BusinessEventInvalidError'
  }
}

export interface PostingPortDeps {
  adapter?: PostingAdapter
  mode?: () => PostingEventsMode
  /** The event id when the producer passes none; Web Crypto, so the module stays isomorphic. */
  newId?: () => string
}

export function createPostingPort(deps: PostingPortDeps = {}): PostingPort {
  const adapter = deps.adapter ?? ledgerAdapter
  const modeOf = deps.mode ?? (() => postingEventsMode())
  const newId = deps.newId ?? (() => globalThis.crypto.randomUUID())

  /**
   * Write the event under shadow or strict. Answers its id, or undefined when
   * none was recorded (a missing table, a shadow failure). `actor`, when not
   * undefined, names the event's actor instead of the surrounding scope's
   * (recordEvent's request); null names none.
   */
  async function writeEvent(
    mode: Exclude<PostingEventsMode, 'off'>,
    supabase: Parameters<typeof recordBusinessEvent>[0],
    companyId: string,
    event: BusinessEventDraft | (() => BusinessEventDraft),
    actor?: CommitActor | null,
  ): Promise<string | undefined> {
    let kind: string | undefined
    try {
      const draft = typeof event === 'function' ? event() : event
      kind = draft.kind
      const row = buildRow(companyId, draft, newId, actor)
      const recorded = await recordBusinessEvent(supabase, row)
      if (recorded.status === 'missing_table') return undefined
      return recorded.id
    } catch (err) {
      if (mode === 'strict') {
        if (err instanceof BusinessEventWriteError) {
          throw new BookkeepingDatabaseError('record_business_event', err.message, err.pgCode)
        }
        throw err
      }
      log.warn('business event not recorded (shadow); the posting goes ahead without it', {
        companyId,
        kind,
        error: err instanceof Error ? err.message : String(err),
        pgCode: err instanceof BusinessEventWriteError ? err.pgCode : undefined,
      })
      return undefined
    }
  }

  /**
   * Record the event for a posting under shadow or strict. Answers the link
   * the engine writes, or undefined when nothing is to be linked (a missing
   * table, a shadow failure, lines the engine will refuse anyway).
   */
  async function recordFor(
    mode: Exclude<PostingEventsMode, 'off'>,
    supabase: Parameters<typeof recordBusinessEvent>[0],
    companyId: string,
    event: BusinessEventDraft | (() => BusinessEventDraft),
    role: BusinessEventEntryRole,
  ): Promise<BusinessEventLink | undefined> {
    const id = await writeEvent(mode, supabase, companyId, event)
    return id === undefined ? undefined : { id, role, onFailure: mode === 'strict' ? 'abort' : 'log' }
  }

  return {
    async postJournalEntry(request): Promise<JournalEntry> {
      const { supabase, companyId, userId, event, input, commitMethod, rubricVersion, options } = request
      const mode = modeOf()
      // Lines the engine refuses on its own pure checks get no event: the
      // engine throws its usual error, before any write, as it always did.
      const businessEvent =
        mode !== 'off' && linesPassEngineChecks(input.lines)
          ? await recordFor(mode, supabase, companyId, event, 'produced')
          : undefined
      return adapter.createJournalEntry({ supabase, companyId, userId, input, commitMethod, rubricVersion, options, businessEvent })
    },

    async postJournalEntrySet(request): Promise<JournalEntry[]> {
      const { supabase, companyId, userId, event, inputs } = request
      const mode = modeOf()
      // One event for the whole set, recorded before the first draft; the
      // set's drafts each carry its link, all written before the first
      // voucher number is drawn. An empty set (every voucher adopted from an
      // earlier attempt) posts nothing and records nothing; a set with lines
      // the engine refuses on its pure checks gets no event, as one posting.
      const businessEvent =
        mode !== 'off' && inputs.length > 0 && inputs.every((input) => linesPassEngineChecks(input.lines))
          ? await recordFor(mode, supabase, companyId, event, 'produced')
          : undefined
      return adapter.createJournalEntries({ supabase, companyId, userId, inputs, businessEvent })
    },

    async draftJournalEntry(request): Promise<JournalEntry> {
      const { supabase, companyId, userId, event, input, options } = request
      const mode = modeOf()
      // As postJournalEntry: the event and its link, then the draft, before
      // the producer's own work and before any voucher number.
      const businessEvent =
        mode !== 'off' && linesPassEngineChecks(input.lines)
          ? await recordFor(mode, supabase, companyId, event, 'produced')
          : undefined
      return adapter.createDraftEntry({ supabase, companyId, userId, input, options, businessEvent })
    },

    async commitJournalEntry(request): Promise<JournalEntry> {
      const { supabase, companyId, userId, entryId, commitMethod, rubricVersion } = request
      // The draft carries its event link already: nothing to record here.
      return adapter.commitEntry({ supabase, companyId, userId, entryId, commitMethod, rubricVersion })
    },

    async correctJournalEntry(request): Promise<CorrectJournalEntryResult> {
      const { supabase, companyId, userId, entryId, stornoEvent, correctionEvent, correction } = request
      const mode = modeOf()
      // Both events before the storno's draft, so under strict a refused
      // event stops the correction before either number is drawn. Lines the
      // storno service refuses on its own first check (an unbalanced
      // correction) get no event, as a posting's do.
      const record = mode !== 'off' && (!('lines' in correction) || validateBalance(correction.lines).valid)
      const reversal = record ? await recordFor(mode, supabase, companyId, stornoEvent, 'reversal') : undefined
      const corrected = record ? await recordFor(mode, supabase, companyId, correctionEvent, 'correction') : undefined
      const businessEvents = reversal || corrected ? { reversal, correction: corrected } : undefined
      return adapter.correctEntry({ supabase, companyId, userId, entryId, correction, businessEvents })
    },

    async reverseJournalEntry(request): Promise<JournalEntry> {
      const { supabase, companyId, userId, event, entryId, reversalDate, options, role } = request
      const mode = modeOf()
      const businessEvent =
        mode !== 'off' ? await recordFor(mode, supabase, companyId, event, role ?? 'reversal') : undefined
      return adapter.reverseEntry({ supabase, companyId, userId, entryId, reversalDate, options, businessEvent })
    },

    async recordEvent(request): Promise<string | null> {
      const { supabase, companyId, event } = request
      const mode = modeOf()
      if (mode === 'off') return null
      // No verifikat to link and no adapter call: the event is the whole
      // write. A named actor (null for none) replaces the scope's.
      return (await writeEvent(mode, supabase, companyId, event, request.actor)) ?? null
    },

    async recordEventsForSql(request): Promise<SqlBusinessEventLink | undefined> {
      const { supabase, companyId } = request
      const mode = modeOf()
      if (mode === 'off') return undefined
      let drafts: BusinessEventDraft[]
      try {
        drafts = await request.events()
      } catch (err) {
        if (mode === 'strict') throw err
        log.warn('business events not built (shadow); the posting goes ahead without them', {
          companyId,
          error: err instanceof Error ? err.message : String(err),
        })
        return undefined
      }
      if (drafts.length === 0) return undefined
      // Each event is written as for one posting (a shadow failure leaves its
      // slot null, a strict one throws), in small waves so a bulk booking of
      // 200 bank lines does not cost 200 round trips in a row.
      const ids: Array<string | null> = drafts.map(() => null)
      for (let start = 0; start < drafts.length; start += SQL_EVENT_WRITE_WAVE) {
        const wave = drafts.slice(start, start + SQL_EVENT_WRITE_WAVE)
        const written = await Promise.all(wave.map((draft) => writeEvent(mode, supabase, companyId, draft)))
        written.forEach((id, i) => {
          ids[start + i] = id ?? null
        })
      }
      // Nothing recorded (a missing table, every write refused under shadow):
      // the function is called as before.
      return ids.some((id) => id !== null) ? { ids, mode } : undefined
    },
  }
}

/** The port every producer uses: the ledger adapter, POSTING_EVENTS read per posting. */
export const postingPort: PostingPort = createPostingPort()

function linesPassEngineChecks(lines: CreateJournalEntryLineInput[]): boolean {
  try {
    assertLinesWellFormed(lines)
  } catch {
    return false
  }
  return validateBalance(lines).valid
}

/**
 * The business_events row for an event, or BusinessEventInvalidError. Pure
 * but for the actor: the surrounding runWithActor scope's unless the caller
 * names one (null for none).
 */
export function buildRow(
  companyId: string,
  event: BusinessEventDraft,
  newId: () => string,
  actorOverride?: CommitActor | null,
): BusinessEventRow {
  if (!isBusinessEventKind(event.kind)) throw new BusinessEventInvalidError(`unknown kind ${JSON.stringify(event.kind)}`)
  const category = event.category ?? null
  if (category !== null && !isBusinessEventCategory(category)) {
    throw new BusinessEventInvalidError(`unknown category ${JSON.stringify(category)}`)
  }
  if (!ISO_DATE.test(event.occurredOn)) throw new BusinessEventInvalidError(`occurredOn ${JSON.stringify(event.occurredOn)}`)
  const id = event.id ?? newId()
  if (!UUID.test(id)) throw new BusinessEventInvalidError('id is not a UUID')
  const subject = event.subject ?? null
  if (subject && (!isHandleType(subject.type) || !UUID.test(subject.id))) {
    throw new BusinessEventInvalidError(`subject ${JSON.stringify(subject)}`)
  }
  const party = event.party ?? null
  if (party && !UUID.test(party.id)) throw new BusinessEventInvalidError('party id is not a UUID')
  const currency = event.currency ?? null
  if (currency !== null && !CURRENCY.test(currency)) throw new BusinessEventInvalidError(`currency ${JSON.stringify(currency)}`)
  const amount = magnitude(event.amount, 'amount')
  const amountSek = magnitude(event.amountSek, 'amountSek')
  if (amount !== null && currency === null) throw new BusinessEventInvalidError('amount without currency')
  const jurisdiction = event.jurisdiction ?? 'SE'
  if (!JURISDICTION.test(jurisdiction)) throw new BusinessEventInvalidError(`jurisdiction ${JSON.stringify(jurisdiction)}`)
  const mappingVersion = event.mappingVersion ?? null
  if (mappingVersion !== null && (mappingVersion.length === 0 || mappingVersion.length > 200)) {
    throw new BusinessEventInvalidError('mappingVersion length')
  }
  const idempotencyKey = event.idempotencyKey ?? null
  if (idempotencyKey !== null && (idempotencyKey.length === 0 || idempotencyKey.length > 200)) {
    throw new BusinessEventInvalidError('idempotencyKey length')
  }
  const taxAmounts = (event.taxAmounts ?? []).map((t) => {
    if (t.tax !== 'vat' || !(t.amount_sek >= 0)) throw new BusinessEventInvalidError(`tax amount ${JSON.stringify(t)}`)
    return { tax: t.tax, treatment: t.treatment ?? null, amount_sek: t.amount_sek }
  })
  const actor = actorOverride === undefined ? getActor() : (actorOverride ?? undefined)

  return {
    id,
    company_id: companyId,
    kind: event.kind,
    category,
    occurred_on: event.occurredOn,
    subject_type: subject?.type ?? null,
    subject_id: subject?.id ?? null,
    party_type: party?.type ?? null,
    party_id: party?.id ?? null,
    currency,
    amount,
    amount_sek: amountSek,
    tax_amounts: taxAmounts,
    evidence: cleanBusinessEventEvidence(event.evidence),
    receipt_id: uuidOrNull(event.receiptId),
    pending_operation_id: uuidOrNull(event.pendingOperationId),
    actor_type: actor?.type ?? null,
    actor_label: actor?.label ? actor.label.slice(0, 200) : null,
    mapping_version: mappingVersion,
    jurisdiction,
    idempotency_key: idempotencyKey,
  }
}

function magnitude(value: number | null | undefined, field: string): number | null {
  if (value === null || value === undefined) return null
  if (!Number.isFinite(value) || value < 0) throw new BusinessEventInvalidError(`${field} must be a magnitude, got ${value}`)
  return value
}

function uuidOrNull(value: string | null | undefined): string | null {
  return value && UUID.test(value) ? value : null
}
