import { describe, expect, it } from 'vitest'
import {
  describeImportResponseFailure,
  describeSIEJobFailure,
  formatImportFailure,
  formatImportFailureReference,
} from '../import-failure'
import type { SIEJob } from '../sie-job-contract'

const job = (overrides: Partial<SIEJob>): Pick<SIEJob, 'id' | 'job_state' | 'error_message' | 'job_result'> => ({
  id: '11111111-1111-4111-8111-111111111111',
  job_state: 'failed',
  error_message: null,
  job_result: null,
  ...overrides,
})

describe('describeImportResponseFailure', () => {
  it('keeps the envelope sentence and carries code, request and voucher details', () => {
    const failure = describeImportResponseFailure({
      status: 400,
      body: { error: {
        code: 'VALIDATION_ERROR',
        message: 'SIE-verifikation LESSLIE2 (2025-01-02) ligger utanför räkenskapsåret.',
        requestId: 'req-42',
        details: { errors: ['Verifikation A 12 balanserar inte (differens: 1.00 kr)'] },
      } },
    })
    expect(failure).toEqual({
      message: 'SIE-verifikation LESSLIE2 (2025-01-02) ligger utanför räkenskapsåret.',
      code: 'VALIDATION_ERROR',
      requestId: 'req-42',
      importId: null,
      details: ['Verifikation A 12 balanserar inte (differens: 1.00 kr)'],
    })
  })

  it('surfaces a Swedish details.reason a fallback code wrapped, never a technical one', () => {
    const wrapped = (reason: string) => describeImportResponseFailure({
      status: 500,
      body: { error: {
        code: 'SIE_IMPORT_UNEXPECTED',
        message: 'Importens resultat kunde inte bekräftas. Kontrollera importhistoriken innan du försöker igen.',
        details: { reason, classified: 'unclassified' },
      } },
    })
    expect(wrapped('SIE-filen innehåller 2 tolkningsfel. Rad 40: Ogiltigt belopp').details)
      .toEqual(['SIE-filen innehåller 2 tolkningsfel. Rad 40: Ogiltigt belopp'])
    expect(wrapped('TypeError: Cannot read properties of undefined (reading "id")').details).toEqual([])
    expect(wrapped('statement timeout').details).toEqual([])
  })

  it('names unmapped accounts from the structured and the legacy shape', () => {
    const structured = describeImportResponseFailure({
      status: 400,
      body: { error: {
        code: 'SIE_IMPORT_UNMAPPED_ACCOUNTS',
        message: 'Vissa konton saknar mappning. Gå tillbaka till kontomappningssteget och koppla alla konton.',
        details: { unmappedAccounts: [{ account: '4545', name: 'Import av varor 25 %' }, { account: '2617' }] },
      } },
    })
    expect(structured.details).toEqual([
      'Konto 4545 (Import av varor 25 %) saknar målkonto',
      'Konto 2617 saknar målkonto',
    ])
    const legacy = describeImportResponseFailure({
      status: 400,
      body: { error: 'validation', message: '1 account(s) are not mapped', unmappedAccounts: [{ account: '4545', name: 'Import' }] },
    })
    expect(legacy.code).toBe('validation')
    expect(legacy.message).not.toBe('1 account(s) are not mapped')
    expect(legacy.details).toEqual(['Konto 4545 (Import) saknar målkonto'])
  })

  it('leaves VALIDATION_ERROR issues to the sentence getErrorMessage renders, and reads issue objects elsewhere', () => {
    const validation = describeImportResponseFailure({
      status: 400,
      body: { error: {
        code: 'VALIDATION_ERROR',
        message: 'Förfrågan innehåller ogiltiga uppgifter.',
        details: { issues: [
          { field: '0.targetAccount', message: 'Målkontot måste ha exakt fyra siffror.', sourceAccount: '999' },
          { field: '1.targetAccount', message: 'Målkontot måste ha exakt fyra siffror.', sourceAccount: '193000' },
        ] },
      } },
    })
    expect(validation.message).toContain('0.targetAccount: Målkontot måste ha exakt fyra siffror.')
    expect(validation.message).toContain('1.targetAccount: Målkontot måste ha exakt fyra siffror.')
    expect(validation.details).toEqual([])

    const other = describeImportResponseFailure({
      status: 400,
      body: { error: {
        code: 'SIE_PARSE_VALIDATION_FAILED',
        message: 'SIE-filen innehåller valideringsfel som måste åtgärdas innan import.',
        details: { issues: [
          { field: 'rad 40', message: 'Ogiltigt belopp' },
          { field: 'rad 40', message: 'Ogiltigt belopp' },
          { message: 'Verifikation A 12 balanserar inte (differens: 1.00 kr)', sourceAccount: '1930' },
        ] },
      } },
    })
    expect(other.details).toEqual([
      'rad 40: Ogiltigt belopp',
      'Källkonto 1930: Verifikation A 12 balanserar inte (differens: 1.00 kr)',
    ])
  })

  it('falls back to the status text for an empty body and never throws', () => {
    const failure = describeImportResponseFailure({ status: 502, body: null })
    expect(failure.message.length).toBeGreaterThan(0)
    expect(failure.code).toBeNull()
    expect(failure.details).toEqual([])
    expect(describeImportResponseFailure({ body: 'nonsense' }).details).toEqual([])
  })
})

describe('describeSIEJobFailure', () => {
  it('uses the row reason and the result errors, keyed by the import id', () => {
    const failure = describeSIEJobFailure(job({
      error_message: 'SIE execution disappeared',
      job_result: { errors: ['Verifikation B 7 balanserar inte (differens: 0.50 kr)', 'SIE execution disappeared'] },
    }))
    expect(failure.message).toBe('SIE execution disappeared')
    expect(failure.details).toEqual(['Verifikation B 7 balanserar inte (differens: 0.50 kr)'])
    expect(failure.importId).toBe('11111111-1111-4111-8111-111111111111')
    expect(failure.code).toBeNull()
  })

  it('says so when a failed row carries no reason, and names a paused one', () => {
    expect(describeSIEJobFailure(job({})).message).toBe('Importen misslyckades utan felmeddelande.')
    expect(describeSIEJobFailure(job({ job_state: 'paused' })).message).toBe('Importen behöver granskas.')
    expect(describeSIEJobFailure(job({ job_state: 'undone' })).message).toBe('Importen är ångrad.')
  })
})

describe('formatImportFailure', () => {
  it('prints the sentence, one bullet per detail and the reference last', () => {
    const text = formatImportFailure({
      message: 'Förfrågan innehåller ogiltiga uppgifter.',
      code: 'VALIDATION_ERROR',
      requestId: 'req-42',
      importId: 'imp-1',
      details: ['Konto 4545 saknar målkonto'],
    })
    expect(text).toBe(
      'Förfrågan innehåller ogiltiga uppgifter.\n• Konto 4545 saknar målkonto\nReferens: kod VALIDATION_ERROR, ärende req-42, import imp-1',
    )
  })

  it('omits the reference line when nothing is known', () => {
    const failure = { message: 'Något gick fel. Försök igen.', code: null, requestId: null, importId: null, details: [] }
    expect(formatImportFailureReference(failure)).toBeNull()
    expect(formatImportFailure(failure)).toBe('Något gick fel. Försök igen.')
  })
})
