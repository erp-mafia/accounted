/**
 * How one row of the memory panel reads, pure: the row's text.
 *
 * A row that a person's answer to a question saved holds the question and
 * the answer as one stored sentence. It reads as two lines instead: the
 * question as the quiet line and the answer as the main line, both taken
 * from the question itself (answered_question), never cut out of the stored
 * sentence. Every other row reads as its stored text.
 */
import { isAnswerFactContent } from '@/lib/questions/answer-fact'
import type { AnsweredQuestionOfFact } from '@/lib/questions/fact-questions'

export interface MemoryRowText {
  /** The row's main line: the answer, or the stored text. */
  main: string
  /** The quiet line over it: the question the answer was given to. Null on a row without one. */
  quiet: string | null
}

/**
 * The two lines of a row. The question and the answer are shown only while
 * the stored text is still the sentence that answer saved: a row whose text
 * was changed since, or was worded another way, shows the stored text, which
 * is what a connected agent is given.
 */
export function memoryRowText(row: { content: string; answered_question?: AnsweredQuestionOfFact | null }): MemoryRowText {
  const answered = row.answered_question
  if (answered && isAnswerFactContent(row.content, answered.question, answered.answer)) {
    return { main: answered.answer, quiet: answered.question }
  }
  return { main: row.content, quiet: null }
}
