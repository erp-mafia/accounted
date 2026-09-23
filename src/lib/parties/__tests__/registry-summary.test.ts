import { describe, it, expect } from 'vitest'
import { addressRowsFromRegistry, contactFill, fromRegistry, registrySummary } from '../registry-summary'

const scb = (field: string, value: unknown, fetchedAt = '2026-09-05T10:00:00Z') => ({ field, value, source: 'registry_scb', fetchedAt })

const WEBHALLEN = [
  scb('legal_name', 'WEBHALLEN SVERIGE AB'),
  scb('legal_form', { code: '49', label: 'Övriga aktiebolag' }),
  scb('company_status', { code: '1', label: 'Verksamt' }),
  scb('bolagsverket_status', { code: '0', label: 'Normalläge', warning: false }),
  scb('f_tax', { code: '1', label: 'Godkänd för F-skatt' }),
  scb('vat_registration', { code: '1', label: 'Momsregistrerad' }),
  scb('employer_registration', { code: '1', label: 'Registrerad som arbetsgivare' }),
  scb('industry', { code: '47410', label: 'Detaljhandel med datorer, programvara, data- och tv-spel' }),
  scb('seat', { municipality: 'Stockholm', county: 'Stockholm' }),
  scb('employees_band', { code: '6', label: '100-199 anställda' }),
  scb('turnover_band', { code: '10', label: '1 000 000 - 4 999 999 tkr', year: '2025' }),
  scb('workplaces', 15),
  scb('registered_at', '1999-02-19'),
  scb('postal_address', { co: null, street: 'TELEGRAFGATAN 4', postal_code: '169 72', city: 'SOLNA' }),
  scb('phone', '086736000'),
  scb('email', 'info@webhallen.com'),
  scb('vat_number', 'SE556558822401', '2026-09-05T11:00:00Z'),
  { field: 'voucher_text', value: ['x'], source: 'ledger', fetchedAt: null },
]

describe('registrySummary', () => {
  it('reads the coded facts into one summary', () => {
    const s = registrySummary(WEBHALLEN)!
    expect(s.legal_name).toBe('WEBHALLEN SVERIGE AB')
    expect(s.legal_form).toBe('Övriga aktiebolag')
    expect(s.status).toEqual({ label: 'Verksamt', active: true })
    expect(s.warning).toBeNull()
    expect(s.registrations).toEqual({ f_tax: true, vat: true, employer: true })
    expect(s.industry?.label).toContain('Detaljhandel')
    expect(s.seat).toBe('Stockholm')
    expect(s.employees_band).toBe('100-199 anställda')
    expect(s.turnover).toEqual({ band: '1 000 000 - 4 999 999 tkr', year: '2025' })
    expect(s.workplaces).toBe(15)
    expect(s.contact).toEqual({ email: 'info@webhallen.com', phone: '086736000', address: { co: null, street: 'TELEGRAFGATAN 4', postal_code: '169 72', city: 'SOLNA' } })
    expect(s.vat_number).toBe('SE556558822401')
    expect(s.fetched_at).toBe('2026-09-05T11:00:00Z')
  })

  it('surfaces a Bolagsverket warning and an inactive status, and is null without registry facts', () => {
    const s = registrySummary([
      scb('company_status', { code: '9', label: 'Ej verksamt' }),
      scb('bolagsverket_status', { code: '31', label: 'Konkurs inledd', warning: true }),
      scb('f_tax', { code: '9', label: 'Avregistrerad för F-skatt' }),
    ])!
    expect(s.status).toEqual({ label: 'Ej verksamt', active: false })
    expect(s.warning).toBe('Konkurs inledd')
    expect(s.registrations.f_tax).toBe(false)
    expect(s.registrations.vat).toBeNull()
    expect(registrySummary([{ field: 'country', value: 'NL', source: 'ledger' }])).toBeNull()
  })
})

describe('contactFill', () => {
  const now = { email: 'info@webhallen.com', phone: '086736000', address: { co: null, street: 'Telegrafgatan 4', postal_code: '169 72', city: 'Solna' } }
  const empty = { email: null, phone: null, address_line1: null, address_line2: null, postal_code: null, city: null }

  it('fills empty fields and never a value a person typed', () => {
    expect(contactFill(empty, now, null)).toEqual({ email: 'info@webhallen.com', phone: '086736000', address_line1: 'Telegrafgatan 4', address_line2: null, postal_code: '169 72', city: 'Solna' })
    const typed = { ...empty, email: 'faktura@webhallen.com', address_line1: 'Box 12', postal_code: '101 20', city: 'Stockholm' }
    expect(contactFill(typed, now, null)).toEqual({ phone: '086736000' })
  })

  it('replaces what the register said last time when the register changed, and nothing when it did not', () => {
    const before = { email: 'old@webhallen.com', phone: '086736000', address: { co: null, street: 'Gamla gatan 1', postal_code: '111 11', city: 'Stockholm' } }
    const row = { email: 'old@webhallen.com', phone: '086736000', address_line1: 'Gamla gatan 1', address_line2: null, postal_code: '111 11', city: 'Stockholm' }
    expect(contactFill(row, now, before)).toEqual({ email: 'info@webhallen.com', address_line1: 'Telegrafgatan 4', address_line2: null, postal_code: '169 72', city: 'Solna' })
    expect(contactFill(row, before, before)).toEqual({})
  })

  it('puts a c/o line first and knows what came from the register', () => {
    expect(addressRowsFromRegistry({ co: 'c/o Ekonomi AB', street: 'Storgatan 1', postal_code: '111 22', city: 'Stockholm' })).toEqual({ address_line1: 'c/o Ekonomi AB', address_line2: 'Storgatan 1', postal_code: '111 22', city: 'Stockholm' })
    expect(fromRegistry('info@webhallen.com', 'INFO@webhallen.com')).toBe(true)
    expect(fromRegistry('', 'x')).toBe(false)
    expect(fromRegistry('a', null)).toBe(false)
  })
})
