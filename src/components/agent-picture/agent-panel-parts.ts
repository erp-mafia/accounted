/**
 * What an agent card's panel shows, worked out from what the card's route
 * answers (lib/agent-context/agent-work.ts): which parts have something, how
 * many more there are than the listed ones, and how a connection's line
 * reads. A proposal is written by the question list's own line
 * (components/questions/question-items.ts), never by a wording of its own.
 * Pure.
 */
import { operationLines, type OperationLine } from '@/components/questions/question-items'
import type { PictureAgent } from '@/lib/agent-context/agent-picture'
import type { AgentCardWork, AgentQuestionLine } from '@/lib/agent-context/agent-work'

/** Where the questions and the proposals are handled. */
export const QUESTIONS_HREF = '/questions'
export const PROPOSALS_HREF = '/pending'

export interface AgentPanelQuestions {
  waiting: AgentQuestionLine[]
  /** Waiting questions past the listed ones. */
  more: number
  answered: number
}

export interface AgentPanelProposals {
  /** One line per waiting proposal, each opening its own page under the proposals. */
  waiting: OperationLine[]
  /** Waiting proposals past the listed ones. */
  more: number
  approved: number
  rejected: number
}

export interface AgentPanelParts {
  /** null when the card has no question to show: none waits and none was answered, or the company has no question list. */
  questions: AgentPanelQuestions | null
  /** null when the card has no proposal to show: none waits and none was approved or rejected lately. */
  proposals: AgentPanelProposals | null
  /** Neither part has anything: one line says so. */
  nothing: boolean
  /** The company has the question list, so the line that says nothing was done names questions too. */
  questionList: boolean
}

export function agentPanelParts(work: AgentCardWork): AgentPanelParts {
  const asked = work.questions
  const questions =
    asked && (asked.waiting_total > 0 || asked.answered > 0)
      ? { waiting: asked.waiting, more: Math.max(0, asked.waiting_total - asked.waiting.length), answered: asked.answered }
      : null

  const prepared = work.proposals
  const lines = operationLines(prepared.waiting)
  const proposals =
    prepared.waiting_total > 0 || prepared.approved > 0 || prepared.rejected > 0
      ? { waiting: lines, more: Math.max(0, prepared.waiting_total - lines.length), approved: prepared.approved, rejected: prepared.rejected }
      : null

  return { questions, proposals, nothing: questions === null && proposals === null, questionList: asked !== null }
}

/** Who made a connection, as its line says it: a message of the picture, and the name it takes. */
export function connectedBy(connection: Pick<PictureAgent, 'is_own' | 'owner_name'>): { message: 'agent_connected_by_you' | 'agent_connected' } | { message: 'agent_connected_by'; name: string } {
  if (connection.is_own) return { message: 'agent_connected_by_you' }
  return connection.owner_name ? { message: 'agent_connected_by', name: connection.owner_name } : { message: 'agent_connected' }
}
