import { describe, expect, it } from 'vitest'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { commitRefusalAnswer } from '../refusal-answer'

const DOCUMENT_ANSWER = getErrorEntry('DOC_UPLOAD_PERIOD_LOCKED')!

describe('commitRefusalAnswer', () => {
  it('prefers the refusal\'s own sentences and next step when the commit result brings them', () => {
    expect(
      commitRefusalAnswer({
        error: DOCUMENT_ANSWER.message_sv,
        data: { journal_entry_id: 'je-1', message_en: DOCUMENT_ANSWER.message_en, remediation: DOCUMENT_ANSWER.remediation },
      }),
    ).toEqual({
      messageSv: DOCUMENT_ANSWER.message_sv,
      messageEn: DOCUMENT_ANSWER.message_en,
      remediation: DOCUMENT_ANSWER.remediation,
    })
  })

  it('gives nothing for a refusal that brings none, so the door answers the registry\'s for the code', () => {
    expect(commitRefusalAnswer({ error: 'Bokföringen är låst för denna period.' })).toEqual({})
    expect(commitRefusalAnswer({ error: 'Bokföringen är låst för denna period.', data: { journal_entry_id: 'je-1' } })).toEqual({})
  })

  it('never gives the English without its Swedish, or a Swedish error without its English', () => {
    expect(commitRefusalAnswer({ error: '', data: { message_en: DOCUMENT_ANSWER.message_en } })).toEqual({})
    expect(commitRefusalAnswer({ error: DOCUMENT_ANSWER.message_sv, data: { message_en: '  ' } })).toEqual({})
  })

  it('takes a next step alone, as the SIE executor brings it', () => {
    const remediation = { description: 'Read the import status first.', tool: 'gnubok_sie_import_status' }
    expect(commitRefusalAnswer({ error: 'Importen kunde inte startas.', data: { remediation } })).toEqual({ remediation })
  })

  it('ignores a remediation without a description', () => {
    expect(commitRefusalAnswer({ error: 'x', data: { remediation: { tool: 'gnubok_x' } } })).toEqual({})
    expect(commitRefusalAnswer({ error: 'x', data: { remediation: 'Do this.' } })).toEqual({})
  })
})
