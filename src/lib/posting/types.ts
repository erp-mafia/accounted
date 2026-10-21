import type { SupabaseClient } from '@supabase/supabase-js'
import type { CommitActor } from '@/lib/bookkeeping/actor-context'
import type {
  commitAssetDepreciation,
  commitAssetDisposal,
  commitBulkBooking,
  commitExpensePayoutBatch,
  commitInvoiceVoucherLink,
  commitMatchBatchAllocation,
  commitSupplierInvoiceVoucherLink,
  CreateEntryOptions,
  replaceOpeningBalanceEntry,
} from '@/lib/bookkeeping/engine'
import type { CorrectionBusinessEvents, correctEntry, recordateEntry } from '@/lib/core/bookkeeping/storno-service'
import type { HandleType } from '@/lib/handles/registry'
import type { CreateJournalEntryInput, CreateJournalEntryLineInput, JournalEntry } from '@/types'
import type { BusinessEventCategory } from './categories'
import type { BusinessEventKind } from './kinds'
import type {
  BusinessEventEntryRole,
  BusinessEventLink,
  BusinessEventPartyType,
  BusinessEventTaxAmount,
  SqlBusinessEventLink,
} from './store'

/**
 * What happened, as a producer describes it to the port. The producer still
 * builds its own journal lines (CreateJournalEntryInput) and the port hands
 * them to the adapter unchanged: during Phase 2 the event describes the
 * posting, it does not generate it.
 */
export interface BusinessEventDraft {
  /**
   * Made by the port when absent. A producer that retries a whole posting
   * passes its own id (or an idempotencyKey) so the retry records no second
   * event.
   */
  id?: string
  kind: BusinessEventKind
  category?: BusinessEventCategory | null
  /** The date of the business act (the bank line's date), not the verifikat's. */
  occurredOn: string
  /** The producer's own record: a typed handle's type and the row's UUID. */
  subject?: { type: HandleType; id: string } | null
  /** The counterparty by type and id only: never a name or a personnummer. */
  party?: { type: BusinessEventPartyType; id: string } | null
  currency?: string | null
  /** Magnitude in currency, never negative: the kind and evidence say which way the money went. */
  amount?: number | null
  /** Magnitude in SEK, never negative. */
  amountSek?: number | null
  taxAmounts?: BusinessEventTaxAmount[]
  /** Cleaned against the closed evidence shape (./evidence.ts) before the write. */
  evidence?: Record<string, unknown>
  /** The decision receipt (suggestion_log row), when it exists at posting time. */
  receiptId?: string | null
  /** The staged operation whose approval posts this. */
  pendingOperationId?: string | null
  /** The rule source and version that produced the lines (./mapping-version.ts). */
  mappingVersion?: string | null
  /** ISO 3166-1 alpha-2; 'SE' when absent. */
  jurisdiction?: string
  /** Unique per company when set: one event per import job, later. */
  idempotencyKey?: string | null
}

/** A posting through the port: what happened, and the producer's own engine input. */
export interface PostJournalEntryRequest {
  supabase: SupabaseClient
  companyId: string
  userId: string
  /**
   * What happened. A function is called only while POSTING_EVENTS is shadow
   * or strict, inside the port's error handling, so with the port off not
   * even the event is built.
   */
  event: BusinessEventDraft | (() => BusinessEventDraft)
  /** Handed to the engine unchanged. */
  input: CreateJournalEntryInput
  commitMethod?: string
  rubricVersion?: string
  /** Engine options of the producer (replayDimensions); the port adds only the event link. */
  options?: Omit<CreateEntryOptions, 'businessEvent'>
}

/**
 * A set of verifikat that are one business act, posted all or none: a salary
 * run's lön, arbetsgivaravgifter, semesteravsättning and pension (1 to 4
 * verifikat). One event is recorded for the whole set and linked to every
 * draft before the first voucher number is drawn
 * (lib/bookkeeping/journal-entry-batch.ts, which keeps its order and its
 * all-or-nothing checks exactly as they were).
 */
export interface PostJournalEntrySetRequest {
  supabase: SupabaseClient
  companyId: string
  userId: string
  /** What happened, once for the set; a function is called only while the port is on (see PostJournalEntryRequest). */
  event: BusinessEventDraft | (() => BusinessEventDraft)
  /** Handed to the engine unchanged, in posting order. */
  inputs: CreateJournalEntryInput[]
}

/**
 * The draft half of a posting a producer commits itself, with its own work in
 * between: the kassa and webbshop doors claim their source row on the draft
 * before a voucher number is drawn, and cancel the draft when the claim
 * loses. The event is recorded and linked to the draft exactly as for
 * postJournalEntry; the commit goes through commitJournalEntry.
 */
export interface DraftJournalEntryRequest {
  supabase: SupabaseClient
  companyId: string
  userId: string
  /** What happened; a function is called only while the port is on (see PostJournalEntryRequest). */
  event: BusinessEventDraft | (() => BusinessEventDraft)
  /** Handed to the engine unchanged. */
  input: CreateJournalEntryInput
  /** Engine options of the producer (replayDimensions); the port adds only the event link. */
  options?: Omit<CreateEntryOptions, 'businessEvent'>
}

/**
 * The commit of a draft made through draftJournalEntry: commitEntry's own
 * arguments. The event was linked to the draft already, so nothing else is
 * written here in any mode.
 */
export interface CommitJournalEntryRequest {
  supabase: SupabaseClient
  companyId: string
  userId: string
  entryId: string
  commitMethod?: string
  rubricVersion?: string
}

/** correctEntry's options (storno-service), without the event links the port adds. */
export type CorrectEntryOptions = Omit<NonNullable<Parameters<typeof correctEntry>[5]>, 'businessEvents'>

/** recordateEntry's options (storno-service), without the event links the port adds. */
export type RecordateEntryOptions = Omit<NonNullable<Parameters<typeof recordateEntry>[5]>, 'businessEvents'>

/** What a correction answers: the storno and the corrected verifikat (correctEntry's result). */
export type CorrectJournalEntryResult = Awaited<ReturnType<typeof correctEntry>>

/**
 * A rättelse through the port (BFL 5 kap 5 §, lib/core/bookkeeping/storno-service.ts):
 * the storno of a posted verifikat and the corrected verifikat that replaces
 * it, with new lines (correctEntry) or the same lines on another date
 * (recordateEntry). Two verifikat, two events: the storno's (ledger.storno,
 * linked with role reversal) and the corrected verifikat's
 * (ledger.correction, role correction). Both are recorded before the storno
 * is drafted, and each is linked to its own draft before that draft's number
 * is drawn.
 */
export interface CorrectJournalEntryRequest {
  supabase: SupabaseClient
  companyId: string
  userId: string
  /** The posted verifikat corrected. */
  entryId: string
  /** The storno's event; a function is called only while the port is on (see PostJournalEntryRequest). */
  stornoEvent: BusinessEventDraft | (() => BusinessEventDraft)
  /** The corrected verifikat's event; a function is called only while the port is on. */
  correctionEvent: BusinessEventDraft | (() => BusinessEventDraft)
  /** What is corrected: the lines (correctEntry's arguments), or only the date (recordateEntry's). */
  correction:
    | { lines: CreateJournalEntryLineInput[]; options?: CorrectEntryOptions }
    | { newDate: string; options?: RecordateEntryOptions }
}

/** A storno through the port: the event it answers, and reverseEntry's own arguments. */
export interface ReverseJournalEntryRequest {
  supabase: SupabaseClient
  companyId: string
  userId: string
  /** What happened; a function is called only while the port is on (see PostJournalEntryRequest). */
  event: BusinessEventDraft | (() => BusinessEventDraft)
  entryId: string
  reversalDate?: string
  /** reverseEntry's own options, handed to it unchanged (collectionsRebook: lib/collections/rebook.ts only). */
  options?: { allowDeepChain?: boolean; collectionsRebook?: boolean }
  /** What the storno is to the event; 'reversal' when absent. */
  role?: Extract<BusinessEventEntryRole, 'reversal' | 'correction'>
}

/**
 * A business act whose verifikat the port does not post: an SIE import job,
 * whose vouchers import_sie_chunk writes in SQL, chunk by chunk, long before
 * the job completes. ONE event stands for the whole job and is linked to no
 * verifikat (design call 1: imports are about 88 % of all postings, and the
 * read-side projection, ./project.ts, answers per entry from the entry's own
 * import batch). With POSTING_EVENTS off nothing is built or written; under
 * shadow a failed write is logged and answers null; under strict it throws
 * (BookkeepingDatabaseError), and the producer decides what that stops.
 */
export interface RecordBusinessEventRequest {
  supabase: SupabaseClient
  companyId: string
  /** What happened; a function is called only while the port is on (see PostJournalEntryRequest). */
  event: BusinessEventDraft | (() => BusinessEventDraft)
  /**
   * Who the event names as actor. Undefined: the surrounding runWithActor
   * scope, as for a posting. A worker that runs a job for someone else (the
   * SIE import worker, under a cron) names the actor the job recorded, null
   * for none, so the event names whoever its verifikat name.
   */
  actor?: CommitActor | null
}

/**
 * The events of verifikat a SQL function drafts and commits itself, in one
 * transaction (bulk_book_transactions, match_batch_allocate,
 * link_invoice_to_voucher, link_supplier_invoice_to_voucher,
 * create_expense_payout_batch, commit_opening_balance_replacement). The port
 * records them first and answers their ids and the mode; the producer hands
 * that to its engine door, and the function links each draft it writes
 * before commit_journal_entry draws the number (migration 20261018210000).
 * With POSTING_EVENTS off nothing is built or written and the answer is
 * undefined, so the door calls the function as before.
 */
export interface RecordSqlPostingEventsRequest {
  supabase: SupabaseClient
  companyId: string
  /**
   * The events in the order the function reads their ids (one per bank
   * line, allocation or claim, or by position). Called only while the port
   * is on, inside its error handling, so it may read what the events need:
   * under shadow a failure is logged and nothing is linked, under strict it
   * throws before the function runs.
   */
  events: () => BusinessEventDraft[] | Promise<BusinessEventDraft[]>
}

/**
 * The SQL posting functions, each with the engine wrapper that is its one
 * application door (lib/bookkeeping/engine.ts). Each numbers a verifikat in
 * SQL through commit_journal_entry, in one transaction with its own writes:
 * the first six draft and commit theirs (their events come from
 * recordEventsForSql and travel in the wrapper's own arguments, as
 * `businessEvents`); commit_asset_depreciation and commit_asset_disposal
 * commit a draft made through draftJournalEntry, which linked its event
 * already.
 */
export interface SqlPostingDoors {
  bulk_book_transactions: typeof commitBulkBooking
  match_batch_allocate: typeof commitMatchBatchAllocation
  link_invoice_to_voucher: typeof commitInvoiceVoucherLink
  link_supplier_invoice_to_voucher: typeof commitSupplierInvoiceVoucherLink
  create_expense_payout_batch: typeof commitExpensePayoutBatch
  commit_opening_balance_replacement: typeof replaceOpeningBalanceEntry
  commit_asset_depreciation: typeof commitAssetDepreciation
  commit_asset_disposal: typeof commitAssetDisposal
}

/** A SQL posting function by its database name. */
export type SqlPostingFunction = keyof SqlPostingDoors

/** A wrapper's arguments after its leading supabase, companyId and userId. */
type ArgumentsAfterUser<F> = F extends (supabase: SupabaseClient, companyId: string, userId: string, ...rest: infer R) => unknown
  ? R
  : never

/** What a SQL posting function's wrapper answers. */
export type SqlPostingResult<F extends SqlPostingFunction> = Awaited<ReturnType<SqlPostingDoors[F]>>

/**
 * A SQL posting function called through the port: its wrapper's own
 * arguments, handed to it unchanged and in the same number (a producer that
 * omits an optional one omits it here too), so the function gets exactly the
 * request a direct call sent. Nothing is recorded here in any mode: the
 * events were recorded before (recordEventsForSql, or the draft's).
 */
export interface CommitSqlPostingRequest<F extends SqlPostingFunction> {
  supabase: SupabaseClient
  companyId: string
  userId: string
  fn: F
  /** The wrapper's arguments after userId. */
  args: ArgumentsAfterUser<SqlPostingDoors[F]>
}

/**
 * The posting port: every new posting records its business event here. Step
 * 1 moves one producer (bank-line booking) onto it; step 2 moves the rest.
 * A producer that drafts, does its own work and then commits (kassa,
 * webbshop) uses draftJournalEntry and commitJournalEntry instead of
 * postJournalEntry; a producer whose one business act is several verifikat
 * posted all or none (a salary run) uses postJournalEntrySet; a producer
 * whose verifikat are written in SQL as one job (an SIE import) records the
 * job's one event with recordEvent; a producer whose verifikat a SQL
 * function drafts and commits (a bulk booking, a batch allocation, a voucher
 * link's kursdifferens, an utlägg payout, the IB cascade) records its events
 * with recordEventsForSql and hands their ids to the function through
 * commitSqlPosting, the door every SQL posting function is called through
 * (the asset doors' commit of their draft included).
 */
export interface PostingPort {
  postJournalEntry(request: PostJournalEntryRequest): Promise<JournalEntry>
  /** One event for a set of verifikat posted all or none (the design's postSet); see PostJournalEntrySetRequest. */
  postJournalEntrySet(request: PostJournalEntrySetRequest): Promise<JournalEntry[]>
  /** The draft of a producer that commits itself; see DraftJournalEntryRequest. */
  draftJournalEntry(request: DraftJournalEntryRequest): Promise<JournalEntry>
  commitJournalEntry(request: CommitJournalEntryRequest): Promise<JournalEntry>
  /** A storno and its corrected verifikat, one event each; see CorrectJournalEntryRequest. */
  correctJournalEntry(request: CorrectJournalEntryRequest): Promise<CorrectJournalEntryResult>
  reverseJournalEntry(request: ReverseJournalEntryRequest): Promise<JournalEntry>
  /** The event alone, linked to no verifikat: its id, or null when none was recorded; see RecordBusinessEventRequest. */
  recordEvent(request: RecordBusinessEventRequest): Promise<string | null>
  /** The events a SQL posting function links to its own drafts; see RecordSqlPostingEventsRequest. */
  recordEventsForSql(request: RecordSqlPostingEventsRequest): Promise<SqlBusinessEventLink | undefined>
  /** A SQL posting function, through its engine wrapper with the producer's own arguments; see CommitSqlPostingRequest. */
  commitSqlPosting<F extends SqlPostingFunction>(request: CommitSqlPostingRequest<F>): Promise<SqlPostingResult<F>>
}

/**
 * Where a posting lands. The ledger (./ledger-adapter.ts) is the only
 * adapter: it calls the engine (lib/bookkeeping/engine.ts) with the
 * producer's input unchanged. A company without the ledger gets a proposal
 * adapter in Phase 4.
 */
export interface PostingAdapter {
  readonly id: 'ledger'
  createJournalEntry(args: {
    supabase: SupabaseClient
    companyId: string
    userId: string
    input: CreateJournalEntryInput
    commitMethod?: string
    rubricVersion?: string
    options?: Omit<CreateEntryOptions, 'businessEvent'>
    businessEvent?: BusinessEventLink
  }): Promise<JournalEntry>
  /** createJournalEntries (lib/bookkeeping/journal-entry-batch.ts): the set, all or none. */
  createJournalEntries(args: {
    supabase: SupabaseClient
    companyId: string
    userId: string
    inputs: CreateJournalEntryInput[]
    businessEvent?: BusinessEventLink
  }): Promise<JournalEntry[]>
  createDraftEntry(args: {
    supabase: SupabaseClient
    companyId: string
    userId: string
    input: CreateJournalEntryInput
    options?: Omit<CreateEntryOptions, 'businessEvent'>
    businessEvent?: BusinessEventLink
  }): Promise<JournalEntry>
  commitEntry(args: {
    supabase: SupabaseClient
    companyId: string
    userId: string
    entryId: string
    commitMethod?: string
    rubricVersion?: string
  }): Promise<JournalEntry>
  reverseEntry(args: {
    supabase: SupabaseClient
    companyId: string
    userId: string
    entryId: string
    reversalDate?: string
    options?: { allowDeepChain?: boolean; collectionsRebook?: boolean }
    businessEvent?: BusinessEventLink
  }): Promise<JournalEntry>
  /** correctEntry or recordateEntry (lib/core/bookkeeping/storno-service.ts): the storno and the corrected verifikat. */
  correctEntry(args: {
    supabase: SupabaseClient
    companyId: string
    userId: string
    entryId: string
    correction: CorrectJournalEntryRequest['correction']
    businessEvents?: CorrectionBusinessEvents
  }): Promise<CorrectJournalEntryResult>
  /** The SQL posting function's engine wrapper (SqlPostingDoors), called with exactly these arguments. */
  commitSqlPosting<F extends SqlPostingFunction>(args: CommitSqlPostingRequest<F>): Promise<SqlPostingResult<F>>
}
