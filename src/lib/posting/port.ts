import { getActor } from '@/lib/bookkeeping/actor-context'
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
} from './store'
import type { BusinessEventDraft, PostingAdapter, PostingPort } from './types'

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
 * A failure in 1 or 2 therefore never costs a number. Under shadow it is
 * logged and the posting goes ahead without the event (or without its link);
 * under strict it stops the posting (BookkeepingDatabaseError). With
 * POSTING_EVENTS off, nothing in 1 or 2 runs and the adapter is called with
 * the producer's arguments as they were.
 *
 * Kept free of the event bus and lib/init (the antipattern guard counts
 * lib/init's reach); the engine announces the posting as it always has.
 */

const log = createLogger('posting.port')

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
    let kind: string | undefined
    try {
      const draft = typeof event === 'function' ? event() : event
      kind = draft.kind
      const row = buildRow(companyId, draft, newId)
      const recorded = await recordBusinessEvent(supabase, row)
      if (recorded.status === 'missing_table') return undefined
      return { id: recorded.id, role, onFailure: mode === 'strict' ? 'abort' : 'log' }
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

    async reverseJournalEntry(request): Promise<JournalEntry> {
      const { supabase, companyId, userId, event, entryId, reversalDate, options, role } = request
      const mode = modeOf()
      const businessEvent =
        mode !== 'off' ? await recordFor(mode, supabase, companyId, event, role ?? 'reversal') : undefined
      return adapter.reverseEntry({ supabase, companyId, userId, entryId, reversalDate, options, businessEvent })
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

/** The business_events row for an event, or BusinessEventInvalidError. Pure. */
export function buildRow(companyId: string, event: BusinessEventDraft, newId: () => string): BusinessEventRow {
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
  const actor = getActor()

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
