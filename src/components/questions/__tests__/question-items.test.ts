import { describe, expect, it } from 'vitest'
import { createTranslator } from 'next-intl'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import { operationLabel } from '@/components/pending-operations/vocabulary'
import type { AppOperation, AppQuestion } from '@/lib/questions/app-answer'
import { formatCurrency } from '@/lib/utils'
import {
  answeredState,
  closedState,
  listItems,
  operationLines,
  operationText,
  ownWordsBody,
  questionSections,
  type OperationLine,
  type QuestionMessages,
} from '../question-items'

const question: AppQuestion = {
  question_id: 'e0000000-0000-4000-8000-000000000001',
  question: 'Vad har ändrats?',
  why: null,
  options: [],
  evidence: [],
  asked_at: '2026-11-19T08:00:00.000Z',
}

describe('the question list page state', () => {
  it('starts every question open, idle and without an error', () => {
    expect(listItems([question])).toEqual([{ question, ended: null, busy: false, error: null }])
    expect(listItems([])).toEqual([])
  })

  it('shows the sentence the answer route says it saved', () => {
    expect(answeredState({ question_id: question.question_id, fact_id: 'f', fact: 'Vad har ändrats? Svar: Årsbetalning' })).toEqual({
      kind: 'answered',
      fact: 'Vad har ändrats? Svar: Årsbetalning',
    })
    // An answer without the sentence still ends the block.
    for (const data of [undefined, null, {}, { fact: 7 }, 'text']) expect(answeredState(data)).toEqual({ kind: 'answered', fact: '' })
  })

  it('remembers the reason a question was closed with', () => {
    expect(closedState('dont_know')).toEqual({ kind: 'closed', reason: 'dont_know' })
    expect(closedState('not_relevant')).toEqual({ kind: 'closed', reason: 'not_relevant' })
  })

  it('sends an answer in own words trimmed, and nothing for an empty one', () => {
    expect(ownWordsBody('  Vi bytte till årsbetalning. ')).toEqual({ text: 'Vi bytte till årsbetalning.' })
    expect(ownWordsBody('   ')).toBeNull()
    expect(ownWordsBody('')).toBeNull()
  })
})

describe('a question closed as settled in the page state', () => {
  const line = {
    kind: 'transaction' as const,
    id: '10000000-0000-4000-8000-000000000001',
    found: true,
    date: '2026-11-03',
    label: 'Leverantören AB',
    detail: null,
    amount: -4990,
    currency: 'SEK',
    href: '/transactions?highlight=10000000-0000-4000-8000-000000000001',
  }
  const settled: AppQuestion = {
    ...question,
    question_id: 'e0000000-0000-4000-8000-000000000002',
    settled: { close_note: 'Betalningen är bokförd mot fakturan.', close_evidence: [line], closed_at: '2026-11-20T09:00:00.000Z' },
  }

  it('comes in ended, with the note and the records of its close, after the open ones as listed', () => {
    expect(listItems([question, settled])).toEqual([
      { question, ended: null, busy: false, error: null },
      {
        question: settled,
        ended: { kind: 'settled', note: 'Betalningen är bokförd mot fakturan.', evidence: [line] },
        busy: false,
        error: null,
      },
    ])
  })

  it('comes in ended with nothing more when its close said nothing', () => {
    const bare: AppQuestion = { ...settled, settled: { close_note: null, close_evidence: [], closed_at: null } }
    expect(listItems([bare])[0].ended).toEqual({ kind: 'settled', note: null, evidence: [] })
  })
})

describe('a question answered before the page was read, in the page state', () => {
  const answered: AppQuestion = {
    ...question,
    question_id: 'e0000000-0000-4000-8000-000000000003',
    answered: { answer: 'Årsbetalning', answered_at: '2026-11-22T09:00:00.000Z' },
    operations: [],
  }

  it('comes in ended, with the answer as the person gave it, after the open ones as listed', () => {
    expect(listItems([question, answered])).toEqual([
      { question, ended: null, busy: false, error: null },
      { question: answered, ended: { kind: 'answered_earlier', answer: 'Årsbetalning' }, busy: false, error: null },
    ])
  })

  it('comes in ended without an answer when the question records none', () => {
    const bare: AppQuestion = { ...answered, answered: { answer: null, answered_at: null } }
    expect(listItems([bare])[0].ended).toEqual({ kind: 'answered_earlier', answer: null })
  })
})

describe('the questions that wait and the ones answered before, as the page splits them', () => {
  const id = (n: number) => `e0000000-0000-4000-8000-00000000001${n}`
  const open: AppQuestion = { ...question, question_id: id(1) }
  const second: AppQuestion = { ...question, question_id: id(2) }
  const answered: AppQuestion = { ...question, question_id: id(3), answered: { answer: 'Årsbetalning', answered_at: '2026-11-22T09:00:00.000Z' }, operations: [] }
  const settled: AppQuestion = { ...question, question_id: id(4), settled: { close_note: null, close_evidence: [], closed_at: null }, operations: [] }
  const ids = (items: ReturnType<typeof listItems>) => items.map((item) => item.question.question_id)

  it('puts the open questions among the waiting and the answered and settled ones among the answered, each in the order listed', () => {
    const sections = questionSections(listItems([open, second, answered, settled]))
    expect(ids(sections.waiting)).toEqual([id(1), id(2)])
    expect(ids(sections.answered)).toEqual([id(3), id(4)])
  })

  it('has nothing waiting when every question had ended before the page was read', () => {
    const sections = questionSections(listItems([answered, settled]))
    expect(sections.waiting).toEqual([])
    expect(ids(sections.answered)).toEqual([id(3), id(4)])
  })

  it('has nothing answered when every question is open', () => {
    const sections = questionSections(listItems([open, second]))
    expect(ids(sections.waiting)).toEqual([id(1), id(2)])
    expect(sections.answered).toEqual([])
  })

  it('keeps a question that is answered or closed on the page among the waiting, where its block says what was saved', () => {
    const [first, other] = listItems([open, second])
    const sections = questionSections([
      { ...first, ended: answeredState({ fact: 'Vad har ändrats? Svar: Årsbetalning' }) },
      { ...other, ended: closedState('dont_know') },
      ...listItems([answered]),
    ])
    expect(ids(sections.waiting)).toEqual([id(1), id(2)])
    expect(ids(sections.answered)).toEqual([id(3)])
  })

  it('is two empty lists for no questions', () => {
    expect(questionSections([])).toEqual({ waiting: [], answered: [] })
  })
})

const ENTRY = '50000000-0000-4000-8000-000000000001'
const OTHER_ENTRY = '50000000-0000-4000-8000-000000000002'
const idOf = (n: number) => `0b000000-0000-4000-8000-00000000000${n}`

/** An operation as the page gets it: one that names no bank row, file or verifikat unless the test says so. */
const operation = (n: number, status: string, overrides: Partial<AppOperation> = {}): AppOperation => ({
  operation_id: idOf(n),
  operation_number: 100 + n,
  operation_type: 'create_customer',
  title: `Förslag ${n}`,
  status,
  journal_entry_id: null,
  bank_row: null,
  document_name: null,
  voucher_label: null,
  ...overrides,
})

/** A bank row paid to a supplier, and one the bank gave no name. */
const SUPPLIER_ROW = { label: 'Leverantören AB', amount: -4990.5, currency: 'SEK' }
const UNNAMED_ROW = { label: 'Okänd transaktion', amount: -25000, currency: 'SEK' }

const booking = (n: number, status: string, overrides: Partial<AppOperation> = {}) =>
  operation(n, status, { operation_type: 'categorize_transaction', bank_row: SUPPLIER_ROW, ...overrides })
const attachment = (n: number, status: string, overrides: Partial<AppOperation> = {}) =>
  operation(n, status, { operation_type: 'attach_document_to_transaction', bank_row: SUPPLIER_ROW, document_name: 'faktura-12.pdf', ...overrides })
const linking = (n: number, status: string, overrides: Partial<AppOperation> = {}) =>
  operation(n, status, { operation_type: 'link_transaction_journal_entry', bank_row: SUPPLIER_ROW, voucher_label: 'A-113', ...overrides })

describe('the lines of the operations linked to a question', () => {
  it('reads a waiting operation as prepared, with the link to its review', () => {
    expect(operationLines([operation(1, 'pending')])).toEqual([
      { operation_id: idOf(1), state: 'prepared', kind: 'other', operation_type: 'create_customer', row: null, document: null, voucher: null, href: `/pending/${idOf(1)}` },
    ])
  })

  it('reads a committed operation as booked, with the link to its verifikat when its result names one', () => {
    expect(operationLines([operation(1, 'committed', { journal_entry_id: ENTRY }), operation(2, 'committed')]).map((line) => [line.state, line.href])).toEqual([
      ['booked', `/bookkeeping/${ENTRY}`],
      ['booked', null],
    ])
  })

  it('reads a rejected operation as rejected, without a link', () => {
    expect(operationLines([operation(1, 'rejected', { journal_entry_id: ENTRY })]).map((line) => [line.state, line.href])).toEqual([['rejected', null]])
  })

  it('reads an approval that is running as prepared, and a failed or unknown outcome with the rejected ones', () => {
    const lines = operationLines([
      operation(1, 'committing'),
      booking(2, 'failed_partial', { journal_entry_id: ENTRY }),
      attachment(3, 'unknown'),
    ])
    expect(lines.map((line) => [line.state, line.href])).toEqual([
      ['prepared', `/pending/${idOf(1)}`],
      ['rejected', null],
      ['rejected', null],
    ])
  })

  it('keeps the order the operations were linked in, and leaves out a status it does not know', () => {
    expect(operationLines([operation(3, 'rejected'), operation(1, 'pending'), operation(2, 'archived')]).map((line) => line.operation_id)).toEqual([idOf(3), idOf(1)])
  })

  it('is empty for a question without operations', () => {
    expect(operationLines([])).toEqual([])
    expect(operationLines(undefined)).toEqual([])
  })

  it('builds a line from the fields of the operation: its type, the bank row, the file and the verifikat', () => {
    expect(operationLines([booking(1, 'committed', { journal_entry_id: ENTRY }), attachment(2, 'pending'), linking(3, 'rejected')])).toEqual([
      { operation_id: idOf(1), state: 'booked', kind: 'booking', operation_type: 'categorize_transaction', row: SUPPLIER_ROW, document: null, voucher: null, href: `/bookkeeping/${ENTRY}` },
      {
        operation_id: idOf(2),
        state: 'prepared',
        kind: 'document',
        operation_type: 'attach_document_to_transaction',
        row: SUPPLIER_ROW,
        document: 'faktura-12.pdf',
        voucher: null,
        href: `/pending/${idOf(2)}`,
      },
      // The verifikat as the app writes one, whichever form the preview stated it in.
      { operation_id: idOf(3), state: 'rejected', kind: 'link', operation_type: 'link_transaction_journal_entry', row: SUPPLIER_ROW, document: null, voucher: 'A113', href: null },
    ])
  })

  it('never reads the title: two operations that differ only in their title are the same line', () => {
    const lines = operationLines([
      booking(1, 'committed', { journal_entry_id: ENTRY, title: 'Kategorisera: Leverantören AB -4990.5 SEK' }),
      booking(2, 'committed', { journal_entry_id: ENTRY, title: 'Något helt annat' }),
    ])
    expect(lines).toHaveLength(1)
    expect(JSON.stringify(lines)).not.toContain('Kategorisera')
  })

  it('takes a file or a verifikat label only on the kind that names one', () => {
    const [line] = operationLines([booking(1, 'pending', { document_name: 'kvitto.pdf', voucher_label: 'A-7' })])
    expect(line).toMatchObject({ kind: 'booking', document: null, voucher: null })
    const [other] = operationLines([operation(2, 'pending', { bank_row: SUPPLIER_ROW, document_name: 'kvitto.pdf' })])
    expect(other).toMatchObject({ kind: 'other', row: null, document: null })
  })

  it('keeps a verifikat label it cannot read as it was stated', () => {
    expect(operationLines([linking(1, 'pending', { voucher_label: 'AB 2026/7' })])[0].voucher).toBe('AB 2026/7')
    expect(operationLines([linking(1, 'pending', { voucher_label: null })])[0].voucher).toBeNull()
  })
})

describe('operations that ended in the same verifikat', () => {
  it('stay two lines when they say different things: the row booked, and a document attached to it', () => {
    const lines = operationLines([booking(1, 'committed', { journal_entry_id: ENTRY }), attachment(2, 'committed', { journal_entry_id: ENTRY })])
    expect(lines.map((line) => [line.kind, line.href])).toEqual([
      ['booking', `/bookkeeping/${ENTRY}`],
      ['document', `/bookkeeping/${ENTRY}`],
    ])
  })

  it('are one line, the first, when they would read the same', () => {
    const lines = operationLines([
      attachment(1, 'committed', { journal_entry_id: ENTRY }),
      booking(2, 'committed', { journal_entry_id: ENTRY }),
      attachment(3, 'committed', { journal_entry_id: ENTRY }),
      booking(4, 'committed', { journal_entry_id: ENTRY }),
    ])
    expect(lines.map((line) => line.operation_id)).toEqual([idOf(1), idOf(2)])
  })

  it('stay two lines when the same words are about two verifikat, two bank rows or two files', () => {
    expect(operationLines([booking(1, 'committed', { journal_entry_id: ENTRY }), booking(2, 'committed', { journal_entry_id: OTHER_ENTRY })])).toHaveLength(2)
    expect(operationLines([booking(1, 'committed', { journal_entry_id: ENTRY }), booking(2, 'committed', { journal_entry_id: ENTRY, bank_row: UNNAMED_ROW })])).toHaveLength(2)
    expect(
      operationLines([attachment(1, 'committed', { journal_entry_id: ENTRY }), attachment(2, 'committed', { journal_entry_id: ENTRY, document_name: 'kvitto.pdf' })]),
    ).toHaveLength(2)
  })

  it('stay two lines when one was carried out and the other was not', () => {
    const lines = operationLines([booking(1, 'rejected'), booking(2, 'committed', { journal_entry_id: ENTRY })])
    expect(lines.map((line) => line.state)).toEqual(['rejected', 'booked'])
  })

  it('keeps every waiting operation: each opens its own review', () => {
    expect(operationLines([booking(1, 'pending'), booking(2, 'pending')]).map((line) => line.href)).toEqual([`/pending/${idOf(1)}`, `/pending/${idOf(2)}`])
  })
})

describe('what a line says, with the real messages', () => {
  type Language = 'sv' | 'en'
  const MESSAGES = { sv, en }
  const translator = (language: Language, namespace: 'questions' | 'pending') =>
    createTranslator({
      locale: language,
      messages: MESSAGES[language] as never,
      namespace: namespace as never,
      // Strict: a missing key or a broken ICU message throws instead of rendering the key path.
      onError: (error) => {
        throw error
      },
    }) as unknown as QuestionMessages
  /** The line as the page writes it: the questions messages, and a type named as the review list names it. */
  const say = (language: Language, line: OperationLine) =>
    operationText(line, translator(language, 'questions'), (type) => operationLabel(type, translator(language, 'pending')))
  const lineOf = (entry: AppOperation) => operationLines([entry])[0]

  // Amounts as formatCurrency writes them: a no-break space in the thousands and before the unit, the real minus sign.
  const PAID = '\u22124\u00a0990,50\u00a0kr'
  const WHOLE = '\u221225\u00a0000\u00a0kr'

  it('writes the amount as the app writes every amount, never a bare number with a currency code', () => {
    expect(PAID).toBe(formatCurrency(-4990.5, 'SEK'))
    expect(WHOLE).toBe(formatCurrency(-25000, 'SEK'))
    const text = say('sv', lineOf(booking(1, 'committed', { journal_entry_id: ENTRY })))
    expect(text).toContain(PAID)
    expect(text).not.toMatch(/-4990\.5|SEK/)
  })

  it('says a bank row was booked, once', () => {
    const line = lineOf(booking(1, 'committed', { journal_entry_id: ENTRY }))
    expect(say('sv', line)).toBe(`Bokfört: Leverantören AB, ${PAID}`)
    expect(say('en', line)).toBe(`Booked: Leverantören AB, ${PAID}`)
    expect(say('sv', lineOf(booking(1, 'committed', { journal_entry_id: ENTRY, bank_row: UNNAMED_ROW })))).toBe(`Bokfört: Okänd transaktion, ${WHOLE}`)
  })

  it('says a booking that waits, and one that was not carried out', () => {
    expect(say('sv', lineOf(booking(1, 'pending')))).toBe(`Förberett: bokföring av Leverantören AB, ${PAID}`)
    expect(say('en', lineOf(booking(1, 'pending')))).toBe(`Prepared: booking of Leverantören AB, ${PAID}`)
    expect(say('sv', lineOf(booking(1, 'rejected')))).toBe(`Avvisat: bokföring av Leverantören AB, ${PAID}`)
    expect(say('en', lineOf(booking(1, 'rejected')))).toBe(`Rejected: booking of Leverantören AB, ${PAID}`)
  })

  it('says a document was attached to a bank row', () => {
    const line = lineOf(attachment(1, 'committed', { journal_entry_id: ENTRY }))
    expect(say('sv', line)).toBe(`Underlag kopplat: faktura-12.pdf till Leverantören AB, ${PAID}`)
    expect(say('en', line)).toBe(`Document attached: faktura-12.pdf to Leverantören AB, ${PAID}`)
    expect(say('sv', lineOf(attachment(1, 'pending')))).toBe(`Förberett: faktura-12.pdf som underlag till Leverantören AB, ${PAID}`)
    expect(say('en', lineOf(attachment(1, 'pending')))).toBe(`Prepared: faktura-12.pdf as the document for Leverantören AB, ${PAID}`)
    expect(say('sv', lineOf(attachment(1, 'rejected')))).toBe(`Avvisat: faktura-12.pdf som underlag till Leverantören AB, ${PAID}`)
    expect(say('en', lineOf(attachment(1, 'rejected')))).toBe(`Rejected: faktura-12.pdf as the document for Leverantören AB, ${PAID}`)
  })

  it('says a bank row was linked to a verifikat that already books it', () => {
    const line = lineOf(linking(1, 'committed', { journal_entry_id: ENTRY }))
    expect(say('sv', line)).toBe(`Kopplat till verifikat A113: Leverantören AB, ${PAID}`)
    expect(say('en', line)).toBe(`Linked to voucher A113: Leverantören AB, ${PAID}`)
    expect(say('sv', lineOf(linking(1, 'pending')))).toBe(`Förberett: koppling till verifikat A113 av Leverantören AB, ${PAID}`)
    expect(say('en', lineOf(linking(1, 'pending')))).toBe(`Prepared: link to voucher A113 for Leverantören AB, ${PAID}`)
    expect(say('sv', lineOf(linking(1, 'rejected')))).toBe(`Avvisat: koppling till verifikat A113 av Leverantören AB, ${PAID}`)
    expect(say('en', lineOf(linking(1, 'rejected')))).toBe(`Rejected: link to voucher A113 for Leverantören AB, ${PAID}`)
  })

  it('writes an amount in another currency with that currency', () => {
    const euro = { label: 'Cloud Provider Ltd', amount: -49.5, currency: 'EUR' }
    expect(say('sv', lineOf(booking(1, 'committed', { journal_entry_id: ENTRY, bank_row: euro })))).toBe(`Bokfört: Cloud Provider Ltd, ${formatCurrency(-49.5, 'EUR')}`)
    expect(formatCurrency(-49.5, 'EUR')).toBe('\u221249,50\u00a0\u20ac')
  })

  it('says a part the operation does not carry in general words, never a gap', () => {
    expect(say('sv', lineOf(booking(1, 'committed', { bank_row: null })))).toBe('Bokfört: en bankrad')
    expect(say('en', lineOf(booking(1, 'committed', { bank_row: null })))).toBe('Booked: a bank row')
    expect(say('sv', lineOf(booking(1, 'committed', { bank_row: { label: null, amount: -250, currency: 'SEK' } })))).toBe(`Bokfört: ${formatCurrency(-250, 'SEK')}`)
    expect(say('sv', lineOf(booking(1, 'committed', { bank_row: { label: 'Leverantören AB', amount: null, currency: null } })))).toBe('Bokfört: Leverantören AB')
    expect(say('sv', lineOf(attachment(1, 'committed', { document_name: null, bank_row: null })))).toBe('Underlag kopplat: en fil till en bankrad')
    expect(say('en', lineOf(attachment(1, 'committed', { document_name: null, bank_row: null })))).toBe('Document attached: a file to a bank row')
    expect(say('sv', lineOf(linking(1, 'committed', { voucher_label: null })))).toBe(`Kopplat till ett befintligt verifikat: Leverantören AB, ${PAID}`)
    expect(say('en', lineOf(linking(1, 'committed', { voucher_label: null })))).toBe(`Linked to an existing voucher: Leverantören AB, ${PAID}`)
  })

  it('names every other operation by its type, as the review list names it', () => {
    const voucher = (status: string, overrides: Partial<AppOperation> = {}) => lineOf(operation(1, status, { operation_type: 'create_voucher', ...overrides }))
    expect(say('sv', voucher('committed', { journal_entry_id: ENTRY }))).toBe('Bokfört: Ny verifikation')
    expect(say('en', voucher('committed', { journal_entry_id: ENTRY }))).toBe('Booked: New journal entry')
    expect(say('sv', voucher('pending'))).toBe('Förberett: Ny verifikation')
    expect(say('en', voucher('pending'))).toBe('Prepared: New journal entry')
    expect(say('sv', voucher('rejected'))).toBe('Avvisat: Ny verifikation')
    expect(say('en', voucher('rejected'))).toBe('Rejected: New journal entry')
  })

  it('does not call an operation booked when it was carried out without a verifikat', () => {
    const customer = lineOf(operation(1, 'committed'))
    expect(say('sv', customer)).toBe(`Genomfört: ${sv.pending.type_create_customer}`)
    expect(say('en', customer)).toBe(`Done: ${en.pending.type_create_customer}`)
  })

  it('says what was done once: no state word twice and no tool verb in front of the row', () => {
    const lines = [booking(1, 'committed', { journal_entry_id: ENTRY }), attachment(2, 'committed'), linking(3, 'committed'), booking(4, 'pending'), attachment(5, 'rejected')].map(lineOf)
    for (const language of ['sv', 'en'] as const) {
      for (const line of lines) {
        const text = say(language, line)
        expect(text.split(': ').length, text).toBe(2)
        expect(text, text).not.toMatch(/Kategorisera|Koppla bilaga|Länka|Categorize/)
      }
    }
  })
})
