import { describe, expect, it } from 'vitest'
import { ANSWER_LOCALES, answerAsGiven, answerFactContent, isAnswerFactContent } from '../answer-fact'
import { answerFactContent as fromAppAnswer } from '../app-answer'

const QUESTION = 'Leverantören drog 4 990 kr den 3 november. Vad har ändrats?'
const OPTIONS = [
  { id: 'more', label: 'Fler licenser' },
  { id: 'annual', label: 'Årsbetalning' },
]

describe('answerFactContent', () => {
  it('is the question and the answer in one sentence, in the language of the answer', () => {
    expect(answerFactContent(` ${QUESTION} `, ' Årsbetalning ', 'sv')).toBe(`${QUESTION} Svar: Årsbetalning`)
    expect(answerFactContent('What changed?', 'Annual payment', 'en')).toBe('What changed? Answer: Annual payment')
  })

  it('is the one wording the answer doors save with', () => {
    expect(fromAppAnswer).toBe(answerFactContent)
    expect(ANSWER_LOCALES).toEqual(['sv', 'en'])
  })
})

describe('isAnswerFactContent', () => {
  it('knows the sentence an answer saved, in either language', () => {
    expect(isAnswerFactContent(`${QUESTION} Svar: Årsbetalning`, QUESTION, 'Årsbetalning')).toBe(true)
    expect(isAnswerFactContent(`${QUESTION} Answer: Årsbetalning`, QUESTION, 'Årsbetalning')).toBe(true)
    expect(isAnswerFactContent(` ${QUESTION} Svar: Årsbetalning\n`, QUESTION, ' Årsbetalning ')).toBe(true)
  })

  it('does not know a text that was changed, or one worded another way', () => {
    expect(isAnswerFactContent(`${QUESTION} Svar: Årsbetalning, från 2027.`, QUESTION, 'Årsbetalning')).toBe(false)
    expect(isAnswerFactContent('Leverantören tar betalt per år sedan november.', QUESTION, 'Årsbetalning')).toBe(false)
    expect(isAnswerFactContent(`${QUESTION} Svar: Fler licenser`, QUESTION, 'Årsbetalning')).toBe(false)
    expect(isAnswerFactContent('', QUESTION, 'Årsbetalning')).toBe(false)
  })
})

describe('answerAsGiven', () => {
  it('is the label of the option the person chose', () => {
    expect(answerAsGiven({ answer_option: 'annual', answer_text: null, options: OPTIONS })).toBe('Årsbetalning')
  })

  it('is the text the person wrote, trimmed', () => {
    expect(answerAsGiven({ answer_option: null, answer_text: ' Vi bytte abonnemang. ', options: OPTIONS })).toBe('Vi bytte abonnemang.')
  })

  it('falls back to the written text when the option is no longer on the question', () => {
    expect(answerAsGiven({ answer_option: 'gone', answer_text: 'Årsvis', options: OPTIONS })).toBe('Årsvis')
  })

  it('is nothing for a question answered by a saved fact alone', () => {
    expect(answerAsGiven({ answer_option: null, answer_text: null, options: OPTIONS })).toBeNull()
    expect(answerAsGiven({ answer_option: null, answer_text: '   ', options: [] })).toBeNull()
  })
})
