/**
 * Suggestions: changes the system proposes to a company, as staged operations
 * a person approves (Profiles and Suggestions, step 3, 2026-10-16).
 *
 * One record, rendered twice: a suggestion is a pending_operations row with
 * actor 'system' plus its company_suggestions row (migration
 * 20261016200600). The customer's agent finds it in the briefing
 * (gnubok_get_agent_briefing `suggestions`) and raises it in chat; the app
 * shows it as a card in Att göra. Either way the answer goes through the
 * doors every staged operation has (approve, reject), so the receipt, the
 * audit row and the actor come with it, and a package switch adds its dated
 * line to behandlingshistorik.
 *
 * The detector interface is the one a user flow's trigger shares: an event
 * type (or a schedule), a condition, and a proposed operation with a plain
 * Swedish title and reason. A built-in suggestion is a flow we ship.
 *
 * Pure types, no server imports.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CoreEvent, CoreEventType } from '@/lib/events/types'
import type { Logger } from '@/lib/logger'
import type { CompanyCapabilities } from '@/lib/modules/capabilities'

/** The operations a suggestion can propose today: a package switch. */
export const SUGGESTION_OPERATION_TYPES = ['enable_package', 'disable_package'] as const
export type SuggestionOperationType = (typeof SUGGESTION_OPERATION_TYPES)[number]

/** What a detector proposes: one staged operation, said in plain Swedish. */
export interface SuggestionProposal {
  /**
   * The dedupe key per company (`<operation>:<subject>`, e.g.
   * enable_package:payroll): never staged twice while open, and the
   * company's "Inte nu" and "Visa aldrig" are remembered per key.
   */
  key: string
  operationType: SuggestionOperationType
  /** pending_operations.params: what the executor runs. Never personal data. */
  params: Record<string, unknown>
  /** The question, plain Swedish: "Slå på Lön?". The pending operation's title. */
  title: string
  /** Why, plain Swedish, one or two sentences. Shown to the approver and the agent. */
  reason: string
  /** Higher first: at most three open suggestions are shown, the most useful first. */
  rank: number
  /** Extra facts for the approver's preview (preview_data), besides the reason. */
  preview?: Record<string, unknown>
}

/** What wakes a detector: events of these types, or a schedule. */
export type DetectorTrigger =
  | { kind: 'event'; eventTypes: readonly CoreEventType[] }
  | { kind: 'schedule'; cadence: 'daily' }

/** What a detector reads with, for one company and one firing. */
export interface DetectorContext {
  /**
   * Service-role client: a detector runs outside any person's session (the
   * event consumer, a cron), always for the one company below.
   */
  supabase: SupabaseClient
  companyId: string
  /**
   * The person the suggestion is staged for (pending_operations.user_id):
   * the user the event names, or the company's owner on a schedule.
   */
  userId: string
  now: Date
  log: Logger
  /** The company's resolved capabilities, read once per firing; null when they cannot be read. */
  capabilities(): Promise<CompanyCapabilities | null>
  /** A value read once per firing and shared by the subjects (a detector's own facts). */
  memo<T>(key: string, load: () => Promise<T>): Promise<T>
}

/**
 * A detector: an event type (or a schedule), a condition, and a proposed
 * operation. `subjects` says what one firing is about (the package an event
 * concerns, or every package on a schedule), `condition` reads the company's
 * current state for a subject, and `propose` turns a subject whose condition
 * holds into the proposal. A detector only proposes: staging is the
 * runner's (./run.ts), and nothing changes without a person's approval.
 */
export interface Detector<TSubject = unknown> {
  /** Stable, kebab-case: company_suggestions.detector. */
  readonly id: string
  readonly trigger: DetectorTrigger
  /** Switched on in this instance (an env flag); omitted means always. */
  readonly enabled?: () => boolean
  subjects(ctx: DetectorContext, event: CoreEvent | null): Promise<readonly TSubject[]> | readonly TSubject[]
  condition(ctx: DetectorContext, subject: TSubject): Promise<boolean>
  propose(subject: TSubject): SuggestionProposal
}

/** One open suggestion as Att göra and the agent briefing show it. */
export interface OpenSuggestion {
  suggestion_id: string
  pending_operation_id: string
  detector: string
  suggestion_key: string
  operation_type: string
  /** The package the switch concerns; null for an operation of another kind. */
  package_id: string | null
  title: string
  reason: string | null
  created_at: string
}
