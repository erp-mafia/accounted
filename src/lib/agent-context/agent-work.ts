/**
 * What one card of the agent picture did for the company: the questions its
 * connections asked that wait for an answer, with how many were answered,
 * and the proposals they prepared that wait for approval, with how many were
 * approved and rejected lately.
 *
 * A question or a proposal is the card's when its row names one of the
 * card's connections by id (actor_id), or carries a label and no id
 * (actor_label) that the card alone writes (agent-cards.ts). A row that
 * names a connection no card has is nobody's here.
 *
 * Every read goes through the caller's client with the company filter, so a
 * reader gets the questions and the proposals their own access gives them.
 * The cards themselves are the connections that reader may list
 * (agent-picture.ts loadAgentCards).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { dbError } from '@/lib/errors/db-error'
import { isCompanyQuestionsEnabled } from '@/lib/env/company-questions-switch'
import { operationsOfRows, type QuestionOperation, type StagedRow } from '@/lib/questions/operations'
import { QUESTION_LIMITS } from '@/lib/questions/types'
import { AGENT_RESOLVED_DAYS, AGENT_WORK_SHOWN, cardOwnsRow, type StagerRef } from './agent-cards'
import { CONNECTION_ACTOR_TYPES, loadAgentCards, type PictureAgentCard } from './agent-picture'

const DAY_MS = 24 * 60 * 60 * 1000
/** Open questions read at most: a company holds far fewer open at once (QUESTION_LIMITS.maxOpen). */
const OPEN_QUESTIONS_READ = 200
/** Ended questions read at most: what a company can file in the days counted stays under it (QUESTION_LIMITS). */
const ENDED_QUESTIONS_READ = 1000

/** The statuses the review list shows as rejected (app/api/pending-operations): a failed approval and an unknown outcome read with them. */
const REJECTED_STATUSES = ['rejected', 'failed_partial', 'unknown']

/** A question as the card's list shows it: its text, linking to the question list. */
export interface AgentQuestionLine {
  question_id: string
  question: string
  asked_at: string
}

export interface AgentCardQuestions {
  /** The questions the card asked that wait for an answer, the oldest first, at most AGENT_WORK_SHOWN. */
  waiting: AgentQuestionLine[]
  /** How many wait in all. */
  waiting_total: number
  /** How many of the card's questions were answered, or closed as settled, in the days the question list keeps them. */
  answered: number
}

export interface AgentCardProposals {
  /** The proposals the card prepared that wait for approval, the newest first, at most AGENT_WORK_SHOWN, each as a question's list shows an operation. */
  waiting: QuestionOperation[]
  /** How many wait in all. */
  waiting_total: number
  /** How many were approved in the last AGENT_RESOLVED_DAYS days. */
  approved: number
  /** How many were rejected in those days. One a newer proposal replaced is not counted. */
  rejected: number
}

export interface AgentCardWork {
  /** The card's id. */
  card: string
  /** null for a company without the question list. */
  questions: AgentCardQuestions | null
  proposals: AgentCardProposals
}

type OpenQuestionRow = StagerRef & { id: string; question: string; created_at: string }

async function cardQuestions(supabase: SupabaseClient, companyId: string, card: PictureAgentCard, now: Date): Promise<AgentCardQuestions> {
  const since = new Date(now.getTime() - QUESTION_LIMITS.recentDays * DAY_MS).toISOString()
  const [open, ended] = await Promise.all([
    supabase
      .from('company_questions')
      .select('id, question, created_at, actor_id, actor_label')
      .eq('company_id', companyId)
      .eq('status', 'open')
      .order('created_at', { ascending: true })
      .limit(OPEN_QUESTIONS_READ),
    // Answered, or closed as settled: what the question list shows as answered.
    supabase
      .from('company_questions')
      .select('actor_id, actor_label')
      .eq('company_id', companyId)
      .or('status.eq.answered,close_reason.eq.settled')
      .gte('answered_at', since)
      .limit(ENDED_QUESTIONS_READ),
  ])
  if (open.error) throw dbError(open.error)
  if (ended.error) throw dbError(ended.error)

  const waiting = ((open.data ?? []) as OpenQuestionRow[]).filter((row) => cardOwnsRow(card, row))
  return {
    waiting: waiting.slice(0, AGENT_WORK_SHOWN).map((row) => ({ question_id: row.id, question: row.question, asked_at: row.created_at })),
    waiting_total: waiting.length,
    answered: ((ended.data ?? []) as StagerRef[]).filter((row) => cardOwnsRow(card, row)).length,
  }
}

/** How a card's rows are found: by the ids of its connections, or by the labels it alone writes on rows with no id. */
type Stager = { ids: string[] } | { labels: string[] }

type WaitingRow = StagedRow & { created_at: string }

interface StagerProposals {
  waiting: WaitingRow[]
  waiting_total: number
  approved: number
  rejected: number
}

async function stagerProposals(supabase: SupabaseClient, companyId: string, stager: Stager, since: string): Promise<StagerProposals> {
  // A row with a label and no id is a connection's only when a connection staged it.
  const types = [...CONNECTION_ACTOR_TYPES]

  // The operation's number is not read: the line does not show it.
  let waiting = supabase
    .from('pending_operations')
    .select(
      'id, operation_type, title, status, result_data, created_at, transaction_id:params->>transaction_id, document_name:preview_data->>document_file_name, voucher_label:preview_data->>voucher_label',
      { count: 'exact' },
    )
    .eq('company_id', companyId)
    .eq('status', 'pending')
  waiting = 'ids' in stager ? waiting.in('actor_id', stager.ids) : waiting.is('actor_id', null).in('actor_label', stager.labels).in('actor_type', types)

  let approved = supabase
    .from('pending_operations')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('status', 'committed')
    .gte('resolved_at', since)
  approved = 'ids' in stager ? approved.in('actor_id', stager.ids) : approved.is('actor_id', null).in('actor_label', stager.labels).in('actor_type', types)

  let rejected = supabase
    .from('pending_operations')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .in('status', REJECTED_STATUSES)
    .gte('resolved_at', since)
    // Replaced by a newer proposal: the newer one is the work, and it is counted where it stands.
    .or('rejection_category.is.null,rejection_category.neq.superseded')
  rejected = 'ids' in stager ? rejected.in('actor_id', stager.ids) : rejected.is('actor_id', null).in('actor_label', stager.labels).in('actor_type', types)

  const [waitingRead, approvedRead, rejectedRead] = await Promise.all([
    waiting.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(AGENT_WORK_SHOWN),
    approved,
    rejected,
  ])
  if (waitingRead.error) throw dbError(waitingRead.error)
  if (approvedRead.error) throw dbError(approvedRead.error)
  if (rejectedRead.error) throw dbError(rejectedRead.error)

  const rows = (waitingRead.data ?? []) as unknown as WaitingRow[]
  return {
    waiting: rows,
    waiting_total: waitingRead.count ?? rows.length,
    approved: approvedRead.count ?? 0,
    rejected: rejectedRead.count ?? 0,
  }
}

async function cardProposals(supabase: SupabaseClient, companyId: string, card: PictureAgentCard, now: Date): Promise<AgentCardProposals> {
  const since = new Date(now.getTime() - AGENT_RESOLVED_DAYS * DAY_MS).toISOString()
  const stagers: Stager[] = [{ ids: card.connections.map((connection) => connection.id) }]
  if (card.labels.length > 0) stagers.push({ labels: card.labels })
  const parts = await Promise.all(stagers.map((stager) => stagerProposals(supabase, companyId, stager, since)))

  // The newest first across both ways a row can be the card's.
  const newest = parts
    .flatMap((part) => part.waiting)
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))
    .slice(0, AGENT_WORK_SHOWN)
  const total = (pick: (part: StagerProposals) => number) => parts.reduce((sum, part) => sum + pick(part), 0)
  return {
    waiting: await operationsOfRows(supabase, companyId, newest),
    waiting_total: total((part) => part.waiting_total),
    approved: total((part) => part.approved),
    rejected: total((part) => part.rejected),
  }
}

/**
 * What the card with this id did for the company, for the signed-in person.
 * Null when the person can list no card with that id. Throws when a read
 * fails.
 */
export async function loadAgentCardWork(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  cardId: string,
  now: Date = new Date(),
): Promise<AgentCardWork | null> {
  const card = (await loadAgentCards(supabase, companyId, userId)).find((candidate) => candidate.id === cardId)
  if (!card) return null
  const [questions, proposals] = await Promise.all([
    isCompanyQuestionsEnabled(companyId) ? cardQuestions(supabase, companyId, card, now) : null,
    cardProposals(supabase, companyId, card, now),
  ])
  return { card: card.id, questions, proposals }
}
