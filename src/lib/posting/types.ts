import type { SupabaseClient } from '@supabase/supabase-js'
import type { CreateEntryOptions } from '@/lib/bookkeeping/engine'
import type { HandleType } from '@/lib/handles/registry'
import type { CreateJournalEntryInput, JournalEntry } from '@/types'
import type { BusinessEventCategory } from './categories'
import type { BusinessEventKind } from './kinds'
import type { BusinessEventEntryRole, BusinessEventLink, BusinessEventPartyType, BusinessEventTaxAmount } from './store'

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

/** A storno through the port: the event it answers, and reverseEntry's own arguments. */
export interface ReverseJournalEntryRequest {
  supabase: SupabaseClient
  companyId: string
  userId: string
  /** What happened; a function is called only while the port is on (see PostJournalEntryRequest). */
  event: BusinessEventDraft | (() => BusinessEventDraft)
  entryId: string
  reversalDate?: string
  options?: { allowDeepChain?: boolean }
  /** What the storno is to the event; 'reversal' when absent. */
  role?: Extract<BusinessEventEntryRole, 'reversal' | 'correction'>
}

/**
 * The posting port: every new posting records its business event here. Step
 * 1 moves one producer (bank-line booking) onto it; step 2 moves the rest.
 */
export interface PostingPort {
  postJournalEntry(request: PostJournalEntryRequest): Promise<JournalEntry>
  reverseJournalEntry(request: ReverseJournalEntryRequest): Promise<JournalEntry>
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
  reverseEntry(args: {
    supabase: SupabaseClient
    companyId: string
    userId: string
    entryId: string
    reversalDate?: string
    options?: { allowDeepChain?: boolean }
    businessEvent?: BusinessEventLink
  }): Promise<JournalEntry>
}
