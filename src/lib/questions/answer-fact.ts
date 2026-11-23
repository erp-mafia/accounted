/**
 * A person's answer in words: the answer as they gave it, and the fact it
 * saves, the question and the answer in one sentence ("<question> Svar:
 * <answer>"). Pure and client-safe: the doors that save the sentence and the
 * views that read it back share this one wording.
 */
import type { CompanyQuestion } from './types'

/** The languages an answer is saved in. */
export const ANSWER_LOCALES = ['sv', 'en'] as const
export type AnswerLocale = (typeof ANSWER_LOCALES)[number]

/** The fact an answer becomes: the question and the answer in one sentence. */
export function answerFactContent(question: string, answer: string, locale: AnswerLocale): string {
  return `${question.trim()} ${locale === 'en' ? 'Answer' : 'Svar'}: ${answer.trim()}`
}

/**
 * Whether a stored fact text is the sentence that answer saved, in either
 * language. False for a text that was changed since, and for a fact worded
 * any other way.
 */
export function isAnswerFactContent(content: string, question: string, answer: string): boolean {
  const stored = content.trim()
  return ANSWER_LOCALES.some((locale) => stored === answerFactContent(question, answer, locale))
}

/** The answer as the person gave it: the chosen option's label, else the written text. */
export function answerAsGiven(question: Pick<CompanyQuestion, 'answer_option' | 'answer_text' | 'options'>): string | null {
  const option = question.answer_option ? question.options.find((entry) => entry.id === question.answer_option) : undefined
  if (option) return option.label
  const text = typeof question.answer_text === 'string' ? question.answer_text.trim() : ''
  return text || null
}
