/**
 * The question list (company_questions): one row per question put to a
 * company, with the records it rests on and how it ended.
 */

export const QUESTION_STATUSES = ['open', 'answered', 'closed'] as const
export type QuestionStatus = (typeof QUESTION_STATUSES)[number]

/**
 * How a question ends without an answer: the person could not say
 * (dont_know) or does not want it asked (not_relevant), the books answered it
 * (settled), or the asker took it back (withdrawn).
 */
export const QUESTION_CLOSE_REASONS = ['dont_know', 'not_relevant', 'settled', 'withdrawn'] as const
export type QuestionCloseReason = (typeof QUESTION_CLOSE_REASONS)[number]

/**
 * The records a question may rest on. `fact` is a saved fact (agent_memory,
 * the fact_id in the briefing's memory); `account` is an account number of
 * the company's chart, read as its balance today.
 */
export const EVIDENCE_KINDS = ['transaction', 'journal_entry', 'document', 'invoice', 'supplier_invoice', 'fact', 'account'] as const
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number]

export interface EvidenceRef {
  kind: EvidenceKind
  id: string
}

export interface QuestionOption {
  id: string
  label: string
}

/** The limits a filed question is held to. */
export const QUESTION_LIMITS = {
  /** Open questions a company holds at once. */
  maxOpen: 5,
  /** Questions filed for a company in any 24 hours. */
  maxFiledPerDay: 3,
  /** Evidence references on one question. */
  maxEvidence: 8,
  /** Answer options on one question. */
  maxOptions: 3,
  /** Characters in an option's label. */
  maxOptionLabel: 20,
  /** Characters in an option's id. */
  maxOptionId: 40,
  /** Characters in the question, and in why. */
  maxText: 500,
  /** Characters in a written answer. */
  maxAnswerText: 2000,
  /** Characters in the note on a question closed as settled. */
  maxCloseNote: 300,
  /** Days an answered or closed question stays in the list. */
  recentDays: 90,
} as const

/** Who filed a question, as the credential is named in the records it writes. */
export interface QuestionActor {
  type?: string | null
  id?: string | null
  label?: string | null
  client?: string | null
}

export interface CompanyQuestion {
  question_id: string
  status: QuestionStatus
  close_reason: QuestionCloseReason | null
  /**
   * On a question closed as settled: where the answer is, when the close
   * said. Set on every question read from its row (toQuestion).
   */
  close_note?: string | null
  /**
   * On a question closed as settled: the records that hold the answer, when
   * the close cited any. Set on every question read from its row.
   */
  close_evidence?: EvidenceRef[]
  question: string
  why: string | null
  options: QuestionOption[]
  evidence: EvidenceRef[]
  /** The label of the credential that filed it, when one was recorded. */
  asked_by: string | null
  /** The MCP client label of the connection that filed it, when one was recorded. */
  client: string | null
  answer_option: string | null
  answer_text: string | null
  /** When it was answered or closed; null while it is open. */
  answered_at: string | null
  answered_via: string | null
  fact_id: string | null
  created_at: string
}
