import { describe, it, expect } from 'vitest'
import {
  accountingMethodFromText,
  agreementFindings,
  expectedDocuments,
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
  const base = {
    kind: 'rental',
    status: 'active',
    starts_on: '2026-01-01',
    ends_on: '2026-10-20',
    amount: 12000,
    principal: null,
    notice_months: null,
    counterparty_party_id: 'p-1',
    counterparty_name: 'Lokalen AB',
  }
  it('flags an active agreement ending within 60 days with an unknown notice period, and one without a counterparty', () => {
    const out = agreementFindings(
      [
        { id: 'a-1', title: 'Hyresavtal', ...base },
        { id: 'a-2', title: 'Abonnemang', ...base, kind: 'subscription', amount: 990, notice_months: 3 },
        { id: 'a-3', title: 'Lån', ...base, ends_on: '2027-06-01', counterparty_party_id: null },
        { id: 'a-4', title: 'Gammalt', ...base, status: 'ended', counterparty_party_id: null },
      ],
      '2026-09-15',
    )
    expect(out.map((f) => f.key)).toEqual(['agreement_ending:a-1', 'agreement_no_counterparty:a-3'])
    expect(out[0].detail).toEqual({ title: 'Hyresavtal', ends_on: '2026-10-20', days: 35 })
    expect(out[1]).toMatchObject({ severity: 'info', subjectKind: 'agreement', subjectId: 'a-3', detail: { counterparty_name: 'Lokalen AB' } })
  })

  it('never asks for a counterparty on a shareholders agreement or an employment contract', () => {
    const out = agreementFindings(
      [
        { id: 'a-5', title: 'Aktieägaravtal', ...base, kind: 'shareholder', ends_on: null, counterparty_party_id: null, counterparty_name: null },
        { id: 'a-6', title: 'Anställningsavtal Alice', ...base, kind: 'employment', ends_on: null, counterparty_party_id: null, counterparty_name: 'Alice' },
      ],
      '2026-09-15',
    )
    expect(out).toEqual([])
  })

  it('files the same agreement read from two files as one duplicate finding', () => {
    const out = agreementFindings(
      [
        { id: 'b-2', title: 'Lån 500050956', ...base, kind: 'loan', ends_on: null, amount: 10417, principal: 500000, starts_on: '2026-02-02', counterparty_party_id: 'p-almi' },
        { id: 'b-1', title: 'Lån 500050956', ...base, kind: 'loan', ends_on: null, amount: 10417, principal: 500000, starts_on: '2026-02-02', counterparty_party_id: 'p-almi' },
        { id: 'b-3', title: 'Lån Propel', ...base, kind: 'loan', ends_on: null, amount: 400000, principal: 400000, starts_on: '2025-10-13', counterparty_party_id: 'p-propel' },
        {
          id: 'b-4',
          title: 'Gammalt lån',
          ...base,
          kind: 'loan',
          status: 'ended',
          ends_on: null,
          amount: 10417,
          principal: 500000,
          starts_on: '2026-02-02',
          counterparty_party_id: 'p-almi',
        },
      ],
      '2026-09-15',
    )
    expect(out).toEqual([
      {
        kind: 'agreement_duplicate',
        key: 'agreement_duplicate:b-1+b-2',
        severity: 'info',
        subjectKind: 'agreement',
        subjectId: 'b-1',
        detail: { agreement_ids: ['b-1', 'b-2'], titles: ['Lån 500050956', 'Lån 500050956'] },
      },
    ])
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

describe('expectedDocuments', () => {
  const line = (account_number: string, entry_date: string, debit = 4625, credit = 0) => ({ account_number, entry_date, debit, credit })
  const loanAgreement = { id: 'a-1', kind: 'loan', title: 'Låneavtal Almi', status: 'active', starts_on: '2026-01-01', ends_on: null, amount: null, principal: 500000, notice_months: null, counterparty_party_id: null, counterparty_name: 'Almi' }

  it('asks for a loan agreement after three months of interest and stays quiet once one is on file', () => {
    const lines = [line('8410', '2026-07-31'), line('8410', '2026-08-31'), line('8410', '2026-09-30')]
    const drafts = expectedDocuments(lines, [], '2026-10-01')
    expect(drafts).toEqual([
      expect.objectContaining({ kind: 'document_expected', key: 'document_expected:loan', subjectKind: 'company', severity: 'info' }),
    ])
    expect(drafts[0].detail).toMatchObject({ rule: 'loan', expected_type: 'agreement.loan', evidence: { cost_months: 3, cost_total: 13875, accounts: ['8410'] } })
    expect(expectedDocuments(lines, [loanAgreement as never], '2026-10-01')).toEqual([])
  })

  it('needs months of evidence, not one transaction, and ignores what is older than six months', () => {
    expect(expectedDocuments([line('8410', '2026-09-30')], [], '2026-10-01')).toEqual([])
    expect(expectedDocuments([line('8410', '2025-09-30'), line('8410', '2025-10-31'), line('8410', '2025-11-30')], [], '2026-10-01')).toEqual([])
  })

  it('reads a standing loan balance as evidence even when nothing moved this half-year, and not a balance that went back to zero', () => {
    // Paid out a year ago, no amortisation yet: the first rollout company's Almi loan.
    const drafts = expectedDocuments([line('2359', '2025-10-01', 0, 500000)], [], '2026-10-01')
    expect(drafts.map((d) => d.key)).toEqual(['document_expected:loan'])
    expect(drafts[0].detail.evidence).toMatchObject({ balance_months: 6, cost_months: 0, accounts: ['2359'] })
    // On the 31st a date minus a month overflows: the six months must still be the six calendar months.
    const marchEnd = expectedDocuments([line('2359', '2025-10-01', 0, 500000)], [], '2026-03-31')
    expect(marchEnd[0].detail.evidence).toMatchObject({ balance_months: 6 })
    // Two months of balance is not yet evidence.
    expect(expectedDocuments([line('2359', '2026-02-15', 0, 500000)], [], '2026-03-31')).toEqual([])
    // Repaid in full before the window: no loan to document.
    expect(expectedDocuments([line('2359', '2025-10-01', 0, 500000), line('2359', '2026-03-15', 500000, 0)], [], '2026-10-01')).toEqual([])
  })

  it('reads a moving loan balance as evidence too, and asks for a rental agreement from recurring rent', () => {
    const amortisation = [line('2350', '2026-07-31', 10417), line('2350', '2026-08-31', 10417), line('2350', '2026-09-30', 10417)]
    expect(expectedDocuments(amortisation, [], '2026-10-01').map((d) => d.key)).toEqual(['document_expected:loan'])
    const rent = [line('5010', '2026-07-25', 12500), line('5010', '2026-08-25', 12500), line('5010', '2026-09-25', 12500)]
    expect(expectedDocuments(rent, [], '2026-10-01').map((d) => d.key)).toEqual(['document_expected:rent'])
  })
})
