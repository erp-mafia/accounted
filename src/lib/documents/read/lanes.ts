/**
 * Arkiv phase 9f: the history lanes. A document that arrived this month is
 * read the way it always was. A document older than that, met for the first
 * time when a company joins Arkiv or imports its past, is read by what it
 * is worth reading for:
 *
 * - tied to a voucher: its text layer only (free); the scanned pages wait
 *   for a question, or for a daily page budget once a history pack exists;
 * - loose, untyped: one model page, enough to say what it is and title it;
 *   an acting type (an agreement, a registration, a decision) is then read
 *   in full, anything else keeps its one page until asked.
 *
 * Pure decisions; the store applies them, the runner and the cron ask.
 */
import type { AiTier } from '@/lib/ai/types'

export type ReadLane = 'live' | 'history_tied' | 'history_loose'

export const HISTORY_AGE_DAYS = 30

export interface LaneDocument {
  created_at?: string | null
  journal_entry_id?: string | null
  journal_entry_line_id?: string | null
}

export function readLaneFor(doc: LaneDocument, now = new Date()): ReadLane {
  if (!doc.created_at) return 'live'
  const age = now.getTime() - new Date(doc.created_at).getTime()
  if (!(age > HISTORY_AGE_DAYS * 86_400_000)) return 'live'
  return doc.journal_entry_id || doc.journal_entry_line_id ? 'history_tied' : 'history_loose'
}

const ACTING_PREFIXES = ['agreement.', 'registration.', 'filing.', 'decision.', 'minutes.']
const ACTING_TYPES = new Set(['share_subscription_list', 'annual_report'])

/** A type the company acts on later: worth every page. A receipt is not. */
export function isActingType(docType: string | null | undefined): boolean {
  if (!docType) return false
  return ACTING_TYPES.has(docType) || ACTING_PREFIXES.some((p) => docType.startsWith(p))
}

export interface ReadPlan {
  lane: ReadLane
  allowModel: boolean
  /** How many pages the model may transcribe in this pass; null is every page it has to. */
  maxModelPages: number | null
  /** The model tier that transcribes; absent for live documents (the extraction tier), the history reader for the rest. */
  tier?: AiTier
}

/**
 * The model that reads history. Benchmarked 2026-09-18 on the trial set (21
 * pages: six receipt and letter photos, fifteen scanned agreement pages):
 * Sonnet 4.6 recovered every one of 29 checked facts, Haiku 4.5 28 at a
 * third of the price, Nova 2 Lite 22 with organisation numbers dropped.
 * The founder chose accuracy first, so history reads with the extraction
 * tier like everything else; ARKIV_HISTORY_READER_TIER=cheap moves it to
 * Haiku when the volume makes that worth it.
 */
export function historyReaderTier(): AiTier {
  return process.env.ARKIV_HISTORY_READER_TIER === 'cheap' ? 'cheap' : 'extraction'
}

/** On a verifikat: booked, so read lazily (see PlanInput.tied). */
export const isBooked = (doc: { journal_entry_id?: string | null; journal_entry_line_id?: string | null }): boolean => !!(doc.journal_entry_id || doc.journal_entry_line_id)

export interface PlanInput {
  lane: ReadLane
  inRollout: boolean
  docType: string | null
  /** The document has been through a read pass before (pages_read_at is set). */
  pagesRead: boolean
  /**
   * It sits on a verifikat: already booked. Read lazily whatever its age (founder, 2026-09-25: the goal is agents
   * answering correctly when asked, and 88 % of background model reads were booked imports nobody opened). The
   * free text layer is read up front; the model reads the rest when someone opens it.
   */
  tied?: boolean
}

/** What to read now, or null when nothing more is read up front. */
export function readPlanFor(input: PlanInput): ReadPlan | null {
  const { lane, inRollout, docType, pagesRead, tied } = input
  if (lane === 'live') return { lane, allowModel: inRollout && !tied, maxModelPages: null }
  const tier = historyReaderTier()
  if (lane === 'history_tied') return pagesRead ? null : { lane, allowModel: false, maxModelPages: null, tier }
  if (!pagesRead) return { lane, allowModel: inRollout, maxModelPages: 1, tier }
  if (isActingType(docType)) return { lane, allowModel: inRollout, maxModelPages: null, tier }
  return null
}

/** The read stamps a question or a budget may finish: the model was never let at the pages, or only at some. */
export const ON_DEMAND_REASONS = ['ai_gated', 'partial:ai_gated', 'partial:budget', 'ai_unconfigured', 'partial:ai_unconfigured'] as const

/**
 * Failures a later reader cures: a photo over the model's 5 MB limit (read
 * before downscaling existed) and a HEIC stamped unsupported (read before it
 * was decoded). Stamped once, they were never tried again, so an agent asking
 * for the page got nothing (prod 2026-09-24: 5 photos on verifikat, 4 HEICs).
 */
export function isCuredFailure(doc: { read_error?: string | null; mime_type?: string | null }): boolean {
  const reason = doc.read_error ?? ''
  if (/exceeds 5 MB maximum/.test(reason)) return true
  return reason === 'unsupported_mime' && (doc.mime_type === 'image/heic' || doc.mime_type === 'image/heif')
}

export function needsReadOnDemand(doc: { pages_read_at?: string | null; read_error?: string | null; mime_type?: string | null }): boolean {
  return !doc.pages_read_at || (ON_DEMAND_REASONS as readonly string[]).includes(doc.read_error ?? '') || isCuredFailure(doc)
}
