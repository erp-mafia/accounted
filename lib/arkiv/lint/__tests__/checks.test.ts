import { describe, it, expect } from 'vitest'
import {
  accountingMethodFromText,
  agreementFindings,
  duplicateDocuments,
  fiscalYearStartMonth,
  momsPeriodFromText,
  settingsMismatches,
  stuckDocuments,
  type LiveFact,
  type SettingsSnapshot,
} from '../checks'

const settings: SettingsSnapshot = {
  company_name: 'Arcim Technology AB',
  org_number: '559538-6219',
  f_skatt: true,
  vat_registered: true,
  employer_registered: false,
  moms_period: 'quarterly',
  accounting_method: 'accrual',
  fiscal_year_start_month: 1,
}
const fact = (predicate: string, value_text: string, page = 2): LiveFact => ({ id: `f-${predicate}`, predicate, value_text, source_document_id: 'doc-1', sources: [{ page }] })

describe('wording to settings', () => {
  it('reads the VAT period, the accounting method and the fiscal year the way Skatteverket and Bolagsverket print them', () => {
    expect(momsPeriodFromText('helt beskattningsår')).toBe('yearly')
    expect(momsPeriodFromText('Kvartal')).toBe('quarterly')
    expect(momsPeriodFromText('varje månad')).toBe('monthly')
    expect(momsPeriodFromText('JANUARI 2026')).toBeUndefined()
    expect(accountingMethodFromText('Bokslutsmetoden')).toBe('cash')
    expect(accountingMethodFromText('faktureringsmetoden')).toBe('accrual')
    expect(accountingMethodFromText('okänd')).toBeUndefined()
    expect(fiscalYearStartMonth('0101 - 1231')).toBe(1)
    expect(fiscalYearStartMonth('0501-0430')).toBe(5)
    expect(fiscalYearStartMonth('kalenderår')).toBeUndefined()
  })
})

describe('settingsMismatches', () => {
  it('files one finding per setting a confirmed fact contradicts, with what to propose and where it was read', () => {
    const facts = [
      fact('vat_period', 'helt beskattningsår'),
      fact('employer_registered', 'yes', 1),
      fact('vat_method', 'faktureringsmetoden'),
      fact('f_skatt', 'approved'),
      fact('legal_name', 'ARCIM TECHNOLOGY AB'),
      fact('org_number', '5595386219'),
    ]
    const out = settingsMismatches(facts, settings)
    expect(out.map((f) => f.key)).toEqual(['settings_mismatch:employer_registered', 'settings_mismatch:moms_period'])
    expect(out[1]).toEqual({
      kind: 'settings_mismatch',
      key: 'settings_mismatch:moms_period',
      severity: 'warning',
      subjectKind: 'company',
      subjectId: null,
      detail: { field: 'moms_period', current: 'quarterly', proposed: 'yearly', fact_id: 'f-vat_period', fact_value: 'helt beskattningsår', source_document_id: 'doc-1', page: 2 },
    })
    expect(out[0].detail).toMatchObject({ field: 'employer_registered', current: false, proposed: true, page: 1 })
  })

  it('says nothing about a setting that is unset, a fact whose wording it cannot read, or a fact it has no rule for', () => {
    expect(settingsMismatches([fact('vat_period', 'JANUARI 2026'), fact('board', 'Wennberg')], settings)).toEqual([])
    expect(settingsMismatches([fact('vat_period', 'kvartal')], { ...settings, moms_period: null })).toEqual([])
  })
})

describe('agreementFindings', () => {
  const base = { status: 'active', ends_on: '2026-10-20', notice_months: null, counterparty_party_id: 'p-1', counterparty_name: 'Lokalen AB' }
  it('flags an active agreement ending within 60 days with an unknown notice period, and one without a counterparty', () => {
    const out = agreementFindings(
      [
        { id: 'a-1', title: 'Hyresavtal', ...base },
        { id: 'a-2', title: 'Abonnemang', ...base, notice_months: 3 },
        { id: 'a-3', title: 'Lån', ...base, ends_on: '2027-06-01', counterparty_party_id: null },
        { id: 'a-4', title: 'Gammalt', ...base, status: 'ended', counterparty_party_id: null },
      ],
      '2026-09-15',
    )
    expect(out.map((f) => f.key)).toEqual(['agreement_ending:a-1', 'agreement_no_counterparty:a-3'])
    expect(out[0].detail).toEqual({ title: 'Hyresavtal', ends_on: '2026-10-20', days: 35 })
    expect(out[1]).toMatchObject({ severity: 'info', subjectKind: 'agreement', subjectId: 'a-3', detail: { counterparty_name: 'Lokalen AB' } })
  })
})

describe('duplicateDocuments and stuckDocuments', () => {
  it('groups documents by content hash and keys the group by the hash', () => {
    const out = duplicateDocuments([
      { document_id: 'b', file_name: 'faktura (1).pdf', content_sha256: 'abc' },
      { document_id: 'a', file_name: 'faktura.pdf', content_sha256: 'abc' },
      { document_id: 'c', file_name: 'kvitto.jpg', content_sha256: 'def' },
      { document_id: 'd', file_name: 'tom.pdf', content_sha256: null },
    ])
    expect(out).toEqual([
      {
        kind: 'duplicate_document',
        key: 'duplicate_document:abc',
        severity: 'info',
        subjectKind: 'document',
        subjectId: 'a',
        detail: { document_ids: ['a', 'b'], file_names: ['faktura.pdf', 'faktura (1).pdf'] },
      },
    ])
  })

  it('files one finding per stuck document with the failed step and a trimmed error', () => {
    const out = stuckDocuments([
      { document_id: 'x', file_name: 'scan.pdf', kind: 'read', last_error: 'x'.repeat(300) },
      { document_id: 'x', file_name: 'scan.pdf', kind: 'classify', last_error: null },
    ])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ key: 'document_stuck:x', severity: 'warning', detail: { step: 'read', file_name: 'scan.pdf' } })
    expect((out[0].detail.last_error as string).length).toBe(200)
  })
})
