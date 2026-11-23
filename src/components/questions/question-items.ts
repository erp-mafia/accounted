/**
 * The question list's page state, pure: what a block shows after an answer
 * or a close, read off what the routes answer, and how the staged operations
 * linked to a question read.
 */
import { formatVoucher, parseVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import type { AppOperation, AppQuestion } from '@/lib/questions/app-answer'
import type { EvidenceLine } from '@/lib/questions/evidence-lines'
import { formatCurrency } from '@/lib/utils'

/** The two ways the page closes a question without an answer. */
export type AppCloseChoice = 'dont_know' | 'not_relevant'

/**
 * How a question ended: on this page, with the saved fact or the reason it
 * was closed; answered before the page was read, with the answer as the
 * person gave it; or closed as settled before the page was read, with the
 * note and the records its close named.
 */
export type EndedState =
  | { kind: 'answered'; fact: string }
  | { kind: 'closed'; reason: AppCloseChoice }
  | { kind: 'answered_earlier'; answer: string | null }
  | { kind: 'settled'; note: string | null; evidence: EvidenceLine[] }

export interface QuestionItem {
  question: AppQuestion
  /** Null while the question is open. */
  ended: EndedState | null
  /** A write for this question is on its way. */
  busy: boolean
  /** Why the last write did not go through, in the reader's language. */
  error: string | null
}

function endedOf(question: AppQuestion): EndedState | null {
  if (question.settled) return { kind: 'settled', note: question.settled.close_note, evidence: question.settled.close_evidence }
  if (question.answered) return { kind: 'answered_earlier', answer: question.answered.answer }
  return null
}

/** An answered question and one closed as settled come in ended; every other one is open. */
export function listItems(questions: readonly AppQuestion[]): QuestionItem[] {
  return questions.map((question) => ({ question, ended: endedOf(question), busy: false, error: null }))
}

/** The page's two lists, each in the order the questions were listed. */
export interface QuestionSections {
  /**
   * The questions that were open when the page was read. One that is
   * answered or closed on the page stays here: its block keeps its place and
   * says what was saved, with Ångra.
   */
  waiting: QuestionItem[]
  /** The questions that had ended before the page was read: answered earlier, or closed as settled. */
  answered: QuestionItem[]
}

/** Whether a question had ended before the page was read. */
function endedEarlier(item: QuestionItem): boolean {
  return item.ended?.kind === 'answered_earlier' || item.ended?.kind === 'settled'
}

/**
 * The questions split into the ones that wait and the ones answered before.
 * The page says that none waits when `waiting` is empty, and lists
 * `answered` under its own label.
 */
export function questionSections(items: readonly QuestionItem[]): QuestionSections {
  return { waiting: items.filter((item) => !endedEarlier(item)), answered: items.filter(endedEarlier) }
}

/**
 * How a linked operation stands, as its line says it: prepared (it waits for
 * approval), booked (it was approved and carried out) or rejected (it was
 * not carried out).
 */
export type OperationLineState = 'prepared' | 'booked' | 'rejected'

/**
 * What a line says was done: a bank row booked, a document attached to a
 * bank row, a bank row linked to a verifikat that already books it, or any
 * other operation, which reads by the name of its type.
 */
export type OperationLineKind = 'booking' | 'document' | 'link' | 'other'

/** The operation types that have a sentence of their own. */
const LINE_KIND: ReadonlyMap<string, OperationLineKind> = new Map<string, OperationLineKind>([
  ['categorize_transaction', 'booking'],
  ['attach_document_to_transaction', 'document'],
  ['link_transaction_journal_entry', 'link'],
])

/** The bank row a line names: its text and its amount, signed as the bank states it. */
export interface OperationLineRow {
  label: string | null
  amount: number | null
  currency: string | null
}

/** One line of a question's linked operations. */
export interface OperationLine {
  operation_id: string
  state: OperationLineState
  kind: OperationLineKind
  /** The operation's type: a line of the kind `other` is named by it. */
  operation_type: string
  /** The bank row the operation acts on; null when it names none or the row could not be read. */
  row: OperationLineRow | null
  /** The file a `document` line attaches, by name. */
  document: string | null
  /** The verifikat a `link` line links to, as the app writes one ("A113"). */
  voucher: string | null
  /**
   * Where the line's link opens: the review of a prepared operation, the
   * verifikat of a booked one whose result names it. Null without a link.
   */
  href: string | null
}

/**
 * The line state of a pending operation's status, grouped as the review
 * list groups its tabs: an approval that is running still reads as
 * prepared, and an operation that failed or whose outcome is unknown reads
 * with the rejected ones. Null for a status this page does not know.
 */
function lineStateOf(status: string): OperationLineState | null {
  switch (status) {
    case 'pending':
    case 'committing':
      return 'prepared'
    case 'committed':
      return 'booked'
    case 'rejected':
    case 'failed_partial':
    case 'unknown':
      return 'rejected'
    default:
      return null
  }
}

/** A verifikat label as the app writes one: "A-12" as an operation's preview states it reads "A12". */
function voucherOf(label: string | null): string | null {
  if (!label) return null
  const parsed = parseVoucher(label)
  return parsed ? formatVoucher({ voucher_series: parsed.series, voucher_number: parsed.number }) : label
}

/** Everything a line shows, as one key: two lines with the same key read the same and open the same place. */
function shownKey(line: OperationLine): string {
  return JSON.stringify([line.state, line.operation_type, line.row?.label ?? null, line.row?.amount ?? null, line.row?.currency ?? null, line.document, line.voucher, line.href])
}

/**
 * The lines of a question's linked operations, in the order they were
 * linked. Each line is built from the operation's fields, never from its
 * title: its type, the bank row it names, the file and the verifikat label
 * its preview states, and the verifikat its result names.
 *
 * Operations that would read the same and open the same place are one line,
 * the first: two that ended in the same verifikat stay two lines when they
 * say different things (a row booked, a document attached to it).
 */
export function operationLines(operations: readonly AppOperation[] | undefined): OperationLine[] {
  const shown = new Set<string>()
  return (operations ?? []).flatMap((operation) => {
    const state = lineStateOf(operation.status)
    if (!state) return []
    const href =
      state === 'prepared'
        ? `/pending/${operation.operation_id}`
        : state === 'booked' && operation.journal_entry_id
          ? `/bookkeeping/${operation.journal_entry_id}`
          : null
    const kind = LINE_KIND.get(operation.operation_type) ?? 'other'
    const line: OperationLine = {
      operation_id: operation.operation_id,
      state,
      kind,
      operation_type: operation.operation_type,
      row: kind === 'other' ? null : (operation.bank_row ?? null),
      document: kind === 'document' ? (operation.document_name ?? null) : null,
      voucher: kind === 'link' ? voucherOf(operation.voucher_label ?? null) : null,
      href,
    }
    const key = shownKey(line)
    if (shown.has(key)) return []
    shown.add(key)
    return [line]
  })
}

/** A message of the questions namespace, with its values. */
export type QuestionMessages = (key: string, values?: Record<string, string | number>) => string

/**
 * What a line says, once: what was done, to which bank row, with the row's
 * amount as every amount in the app is written (formatCurrency). `t` reads
 * the questions namespace; `typeName` names an operation type as the review
 * list names it, for the kinds without a sentence of their own.
 *
 * A part the operation does not carry is said in general words (a bank row,
 * a file, an existing verifikat), so a sentence is never left with a gap.
 */
export function operationText(line: OperationLine, t: QuestionMessages, typeName: (operationType: string) => string): string {
  if (line.kind === 'other') {
    const what = typeName(line.operation_type)
    // Carried out without a verifikat to show is not "booked".
    if (line.state === 'booked') return t(line.href ? 'operation_booked' : 'operation_done', { what })
    return t(line.state === 'prepared' ? 'operation_prepared' : 'operation_rejected', { what })
  }
  const amount = line.row && line.row.amount !== null ? formatCurrency(line.row.amount, line.row.currency) : null
  const row = [line.row?.label, amount].filter(Boolean).join(', ') || t('operation_some_row')
  if (line.kind === 'booking') return t(`operation_booking_${line.state}`, { row })
  if (line.kind === 'document') {
    return t(`operation_document_${line.state}`, { row, document: line.document ?? t('operation_some_document') })
  }
  return t(`operation_link_${line.state}`, {
    row,
    voucher: line.voucher ? t('operation_voucher', { voucher: line.voucher }) : t('operation_some_voucher'),
  })
}

/** The block after an answer: the sentence the answer route says it saved. */
export function answeredState(data: unknown): EndedState {
  const fact = typeof data === 'object' && data !== null && 'fact' in data && typeof data.fact === 'string' ? data.fact : ''
  return { kind: 'answered', fact }
}

export function closedState(reason: AppCloseChoice): EndedState {
  return { kind: 'closed', reason }
}

/** The body of an answer in the person's own words; null while there is nothing to send. */
export function ownWordsBody(text: string): { text: string } | null {
  const trimmed = text.trim()
  return trimmed ? { text: trimmed } : null
}
