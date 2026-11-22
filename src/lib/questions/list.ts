/**
 * A company's question list: the open questions first (the oldest first),
 * then those answered or closed in the last 90 days (the latest first).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { dbError } from '@/lib/errors/db-error'
import { isCompanyQuestionsEnabled } from '@/lib/env/company-questions-switch'
import { createLogger } from '@/lib/logger'
import { assertCompanyQuestionsOn, toQuestion, type QuestionRow } from './rows'
import { QUESTION_LIMITS, type CompanyQuestion, type QuestionStatus } from './types'

const log = createLogger('questions')

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const DAY_MS = 24 * 60 * 60 * 1000

export interface ListQuestionsOptions {
  /** Only questions with this status. */
  status?: QuestionStatus
  /** At most this many, counted over the whole list. Default 50, at most 200. */
  limit?: number
}

function limitOf(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_LIMIT
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)))
}

async function openQuestions(supabase: SupabaseClient, companyId: string, limit: number): Promise<CompanyQuestion[]> {
  const { data, error } = await supabase
    .from('company_questions')
    .select(
      'id, status, close_reason, question, why, options, evidence, actor_label, client, answer_option, answer_text, answered_at, answered_via, fact_id, created_at',
    )
    .eq('company_id', companyId)
    .eq('status', 'open')
    .order('created_at', { ascending: true })
    .limit(limit)
  if (error) throw dbError(error)
  return ((data ?? []) as QuestionRow[]).map(toQuestion)
}

async function endedQuestions(
  supabase: SupabaseClient,
  companyId: string,
  statuses: QuestionStatus[],
  limit: number,
): Promise<CompanyQuestion[]> {
  const since = new Date(Date.now() - QUESTION_LIMITS.recentDays * DAY_MS).toISOString()
  const { data, error } = await supabase
    .from('company_questions')
    .select(
      'id, status, close_reason, question, why, options, evidence, actor_label, client, answer_option, answer_text, answered_at, answered_via, fact_id, created_at',
    )
    .eq('company_id', companyId)
    .in('status', statuses)
    .gte('answered_at', since)
    .order('answered_at', { ascending: false })
    .limit(limit)
  if (error) throw dbError(error)
  return ((data ?? []) as QuestionRow[]).map(toQuestion)
}

/** The company's questions. Refuses when the list is not switched on; throws when a read fails. */
export async function listQuestions(
  supabase: SupabaseClient,
  companyId: string,
  options: ListQuestionsOptions = {},
): Promise<CompanyQuestion[]> {
  assertCompanyQuestionsOn(companyId)
  const limit = limitOf(options.limit)
  if (options.status === 'open') return openQuestions(supabase, companyId, limit)
  if (options.status) return endedQuestions(supabase, companyId, [options.status], limit)
  const open = await openQuestions(supabase, companyId, limit)
  if (open.length >= limit) return open
  const ended = await endedQuestions(supabase, companyId, ['answered', 'closed'], limit - open.length)
  return [...open, ...ended]
}

/**
 * The open questions an agent is handed when it opens the company: at most
 * the number a company may hold open. Best-effort: nothing when the list is
 * not switched on, and nothing (with a log line) when the read fails.
 */
export async function listOpenQuestionsForBriefing(supabase: SupabaseClient, companyId: string): Promise<CompanyQuestion[]> {
  if (!isCompanyQuestionsEnabled(companyId)) return []
  try {
    return await openQuestions(supabase, companyId, QUESTION_LIMITS.maxOpen)
  } catch (error) {
    log.warn('open questions could not be read', { companyId, error: error instanceof Error ? error.message : String(error) })
    return []
  }
}
