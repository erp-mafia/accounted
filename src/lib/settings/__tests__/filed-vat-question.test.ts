import { describe, expect, it } from 'vitest'
import { filedVatPeriodsInRefusal } from '../filed-vat-question'

/** The 409 the settings page door answers (app/api/settings/route.ts). */
const refusal = (filed_periods: unknown) => ({
  error: {
    code: 'BOOKKEEPING_LOCK_REOPENS_FILED_VAT',
    message: 'Låsdatumet skulle öppna momsperioder som redan är deklarerade (2026-Q2).',
    message_en: 'The lock date would reopen VAT periods already filed with Skatteverket.',
    details: { filed_periods, acknowledge_with: 'acknowledge_filed_vat_periods' },
  },
})

describe('filedVatPeriodsInRefusal', () => {
  it('reads the labels of the filed periods, in the order the server names them', () => {
    const body = refusal([
      { tax_period: '2026-Q2', period_start: '2026-04-01', period_end: '2026-06-30', filed_on: '2026-08-12' },
      { tax_period: '2026-Q3', period_start: '2026-07-01', period_end: '2026-09-30', filed_on: '2026-11-12' },
    ])

    expect(filedVatPeriodsInRefusal(body)).toEqual(['2026-Q2', '2026-Q3'])
  })

  it('is null for every other refusal, so that one is shown as it is', () => {
    expect(filedVatPeriodsInRefusal({ error: 'Påminnelsedagarna måste öka.' })).toBeNull()
    expect(filedVatPeriodsInRefusal({ error: { code: 'FORBIDDEN', message: 'Nej.' } })).toBeNull()
    expect(filedVatPeriodsInRefusal({ type: 'validation_error', errors: [] })).toBeNull()
    expect(filedVatPeriodsInRefusal(null)).toBeNull()
  })

  it('never asks blind: the refusal without a readable period is null too', () => {
    expect(filedVatPeriodsInRefusal(refusal([]))).toBeNull()
    expect(filedVatPeriodsInRefusal(refusal([{ period_start: '2026-04-01' }, null]))).toBeNull()
    expect(filedVatPeriodsInRefusal(refusal(undefined))).toBeNull()
  })
})
