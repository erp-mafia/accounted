import { isSaneDateString } from '@/lib/invariants/iso-date'
import { listAiTasks, type AiTask, type AiTaskCategory } from '@/lib/worklist/ai-task'
import type { WorklistCounts } from '@/lib/worklist/types'

/** A company this young (in days) still opens Hem on one first thing. */
export const FIRST_THING_MAX_COMPANY_AGE_DAYS = 30

/** The most entries the "after" list shows. */
export const FIRST_THING_MAX_AFTER = 3

/** `import_bank_file` stands where `connect_bank` would when the deployment offers no bank connection. */
export type FirstThingKind = 'connect_bank' | 'import_bank_file' | 'book_bank_rows' | 'find_receipts' | 'go_through_documents'

/** What is in, for the lead line. */
export type FirstThingLead = 'books_and_bank' | 'bank' | 'books' | 'nothing'

export interface FirstThingInput {
  inRollout: boolean
  counts: WorklistCounts['counts']
  /** An active bank connection, or bank rows already in the company. */
  hasBankFeed: boolean
  hasImportedBooks: boolean
  hasTransactions: boolean
  /** ISO timestamp or date the company was created. */
  companyCreatedAt: string | null
  /** Today's date, YYYY-MM-DD. */
  today: string
  /** The person closed the block for this company. */
  closed: boolean
  /** The person may write in the company. A read-only member keeps the usual Hem: none of the first things is theirs to do. */
  canWrite: boolean
  /** The company is the demo company a visitor tries the app in: it shows the usual Hem, which is what the demo is of. */
  demoCompany: boolean
  /** The deployment offers a bank connection. Without one the first thing for a company with no bank rows is importing a statement. */
  bankConnectOffered: boolean
  /**
   * The first day (YYYY-MM-DD) a company may have been created on to get the
   * block; a company created before it keeps the usual Hem. Null: no such day.
   */
  createdFrom: string | null
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
  // A day that does not exist (02-31) is unreadable, never the day it would roll over to.
  if (!m || !isSaneDateString(m[0])) return null
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

/** Whether the company was created on `from` (YYYY-MM-DD) or later, by the UTC day of its creation time. An unreadable date answers false. */
export function createdOnOrAfter(createdAt: string | null, from: string): boolean {
  if (!createdAt) return false
  const created = dayNumber(createdAt)
  const first = dayNumber(from)
  return created !== null && first !== null && created >= first
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
  if (!input.inRollout || input.closed || !input.canWrite || input.demoCompany) return null
  if (!isNewCompany(input.companyCreatedAt, input.today)) return null
  if (input.createdFrom && !createdOnOrAfter(input.companyCreatedAt, input.createdFrom)) return null

  // Bank rows reach the company through a bank connection or as rows already in it.
  const hasBankRows = input.hasBankFeed || input.hasTransactions
  const count = (category: AiTaskCategory) => input.counts[category] ?? 0

  // A deadline that needs attention is what Hem is for that day: the usual Hem names it.
  if (count('deadline_action') > 0) return null

  let kind: FirstThingKind | null = null
  if (!hasBankRows) kind = input.bankConnectOffered ? 'connect_bank' : 'import_bank_file'
  else if (count('book_transaction') > 0) kind = 'book_bank_rows'
  else if (count('verifikat_missing_document') > 0) kind = 'find_receipts'
  else if (count('inbox_document') > 0) kind = 'go_through_documents'
  if (!kind) return null

  const chosen = KIND_CATEGORY[kind]
  const after = listAiTasks(input.counts)
    .filter((task) => task.category !== chosen)
    .slice(0, FIRST_THING_MAX_AFTER)

  return { kind, lead: leadOf(input), after }
}
