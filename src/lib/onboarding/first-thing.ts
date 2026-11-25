import { listAiTasks, type AiTask, type AiTaskCategory } from '@/lib/worklist/ai-task'
import type { WorklistCounts } from '@/lib/worklist/types'

/** A company this young (in days) still opens Hem on one first thing. */
export const FIRST_THING_MAX_COMPANY_AGE_DAYS = 30

/** The most entries the "after" list shows. */
export const FIRST_THING_MAX_AFTER = 3

export type FirstThingKind = 'connect_bank' | 'book_bank_rows' | 'find_receipts' | 'go_through_documents'

/** What is in, for the lead line. */
export type FirstThingLead = 'books_and_bank' | 'bank' | 'books' | 'nothing'

export interface FirstThingInput {
  inRollout: boolean
  counts: WorklistCounts['counts']
  /** An active bank connection, or bank rows already in the company. */
  hasBankFeed: boolean
  hasImportedBooks: boolean
  hasTransactions: boolean
  /** Whether the company holds the AI capability (the inbox row is listed only then). */
  hasAi: boolean
  /** ISO timestamp or date the company was created. */
  companyCreatedAt: string | null
  /** Today's date, YYYY-MM-DD. */
  today: string
  /** The person closed the block for this company. */
  closed: boolean
}

export interface FirstThing {
  kind: FirstThingKind
  lead: FirstThingLead
  /** What comes after, in the order of the agent-able rows, never the first thing, at most three. */
  after: AiTask[]
}

const KIND_CATEGORY: Partial<Record<FirstThingKind, AiTaskCategory>> = {
  book_bank_rows: 'book_transaction',
  find_receipts: 'verifikat_missing_document',
  go_through_documents: 'inbox_document',
}

function dayNumber(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (!m) return null
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000
}

/** Whether the company was created no more than FIRST_THING_MAX_COMPANY_AGE_DAYS before `today`. */
export function isNewCompany(createdAt: string | null, today: string): boolean {
  if (!createdAt) return false
  const created = dayNumber(createdAt)
  const now = dayNumber(today)
  if (created === null || now === null) return false
  return now - created <= FIRST_THING_MAX_COMPANY_AGE_DAYS
}

function leadOf(input: Pick<FirstThingInput, 'hasBankFeed' | 'hasImportedBooks' | 'hasTransactions'>): FirstThingLead {
  const bank = input.hasBankFeed || input.hasTransactions
  if (input.hasImportedBooks && bank) return 'books_and_bank'
  if (bank) return 'bank'
  if (input.hasImportedBooks) return 'books'
  return 'nothing'
}

/**
 * The one first thing Hem opens on, or null for Hem as usual. Pure: it reads
 * the counts Hem already has and orders them, it judges no bookkeeping.
 */
export function pickFirstThing(input: FirstThingInput): FirstThing | null {
  if (!input.inRollout || input.closed) return null
  if (!isNewCompany(input.companyCreatedAt, input.today)) return null

  // Bank rows reach the company through a bank connection or as rows already in it.
  const hasBankRows = input.hasBankFeed || input.hasTransactions
  const count = (category: AiTaskCategory) => input.counts[category] ?? 0

  let kind: FirstThingKind | null = null
  if (!hasBankRows) kind = 'connect_bank'
  else if (count('book_transaction') > 0) kind = 'book_bank_rows'
  else if (count('verifikat_missing_document') > 0) kind = 'find_receipts'
  else if (input.hasAi && count('inbox_document') > 0) kind = 'go_through_documents'
  if (!kind) return null

  const chosen = KIND_CATEGORY[kind]
  const after = listAiTasks(input.counts, { hasAi: input.hasAi })
    .filter((task) => task.category !== chosen)
    .slice(0, FIRST_THING_MAX_AFTER)

  return { kind, lead: leadOf(input), after }
}
