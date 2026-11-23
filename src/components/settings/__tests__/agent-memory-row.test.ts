import { describe, expect, it } from 'vitest'
import { memoryRowText } from '../agent-memory-row'

const QUESTION = 'Leverantören drog 4 990 kr den 3 november. Vad har ändrats?'

describe('memoryRowText', () => {
  it('reads a row that an answer saved as the question, quietly, over the answer', () => {
    expect(
      memoryRowText({
        content: `${QUESTION} Svar: Årsbetalning`,
        answered_question: { question: QUESTION, answer: 'Årsbetalning' },
      }),
    ).toEqual({ main: 'Årsbetalning', quiet: QUESTION })
  })

  it('reads the same for an answer saved in English, in the words the person wrote', () => {
    expect(
      memoryRowText({
        content: 'What changed? Answer: We moved to yearly billing.',
        answered_question: { question: 'What changed?', answer: 'We moved to yearly billing.' },
      }),
    ).toEqual({ main: 'We moved to yearly billing.', quiet: 'What changed?' })
  })

  it('reads a row without a question as its stored text', () => {
    expect(memoryRowText({ content: 'Räkenskapsår jan-dec' })).toEqual({ main: 'Räkenskapsår jan-dec', quiet: null })
    expect(memoryRowText({ content: 'Räkenskapsår jan-dec', answered_question: null })).toEqual({ main: 'Räkenskapsår jan-dec', quiet: null })
  })

  it('reads a row whose stored text was changed after the answer as the stored text', () => {
    const edited = `${QUESTION} Svar: Årsbetalning från 2027.`
    expect(memoryRowText({ content: edited, answered_question: { question: QUESTION, answer: 'Årsbetalning' } })).toEqual({
      main: edited,
      quiet: null,
    })
  })

  it('reads a fact worded another way as the stored text, though a question names it', () => {
    const fact = 'Leverantören tar betalt per år sedan november.'
    expect(memoryRowText({ content: fact, answered_question: { question: QUESTION, answer: 'Årsbetalning' } })).toEqual({
      main: fact,
      quiet: null,
    })
  })
})
