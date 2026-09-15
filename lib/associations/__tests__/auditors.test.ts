import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/associations/member-register', () => ({
  listContributions: vi.fn(),
  memberCapitalReconciliation: vi.fn(),
  memberRegisterExtract: vi.fn(),
}))
vi.mock('@/lib/bokslut/arsredovisning/profile-service', () => ({
  getAnnualReportProfile: vi.fn(),
}))

import {
  listContributions,
  memberCapitalReconciliation,
  memberRegisterExtract,
} from '@/lib/associations/member-register'
import { getAnnualReportProfile } from '@/lib/bokslut/arsredovisning/profile-service'
import { emptyAnnualReportProfile } from '@/lib/bokslut/arsredovisning/compliance-types'
import {
  auditBundleCsv,
  buildAuditBundle,
  requireCompanyDocument,
  updateAuditor,
  type AssociationAuditorRow,
} from '../auditors'

const { supabase, enqueue, reset } = createQueuedMockSupabase()
const client = supabase as unknown as Parameters<typeof updateAuditor>[0]

const serving: AssociationAuditorRow = {
  id: 'a1',
  company_id: 'company-1',
  name: 'Revisor Ett',
  kind: 'auktoriserad_revisor',
  registration_reference: 'RI 12345',
  appointed_on: '2024-05-20',
  term_ends_on: null,
  appointment_reference: 'Stämma 2024 § 12',
  ended_on: null,
  notes: null,
  created_at: '2024-05-20T00:00:00Z',
  updated_at: '2024-05-20T00:00:00Z',
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
})

describe('updateAuditor', () => {
  it('refuses an unknown revisor and a second end date', async () => {
    enqueue({ data: null, error: null })
    await expect(updateAuditor(client, 'company-1', 'nope', { ended_on: '2026-06-30' })).rejects.toMatchObject({
      code: 'ASSOCIATION_AUDITOR_NOT_FOUND',
    })
    enqueue({ data: { ...serving, ended_on: '2025-06-30' }, error: null })
    await expect(updateAuditor(client, 'company-1', 'a1', { ended_on: '2026-06-30' })).rejects.toMatchObject({
      code: 'ASSOCIATION_AUDITOR_ALREADY_ENDED',
    })
  })

  it('still lets an ended assignment have its references corrected', async () => {
    enqueue({ data: { ...serving, ended_on: '2025-06-30' }, error: null })
    enqueue({ data: { ...serving, ended_on: '2025-06-30', appointment_reference: 'Stämma 2024 § 13' }, error: null })
    const row = await updateAuditor(client, 'company-1', 'a1', { appointment_reference: 'Stämma 2024 § 13' })
    expect(row.appointment_reference).toBe('Stämma 2024 § 13')
  })

  it('ends a serving assignment with a date', async () => {
    enqueue({ data: serving, error: null })
    enqueue({ data: { ...serving, ended_on: '2026-06-30' }, error: null })
    const row = await updateAuditor(client, 'company-1', 'a1', { ended_on: '2026-06-30' })
    expect(row.ended_on).toBe('2026-06-30')
  })
})

describe('requireCompanyDocument', () => {
  it('accepts a document in the company archive and refuses any other id', async () => {
    enqueue({ data: { id: 'doc-1' }, error: null })
    await expect(requireCompanyDocument(client, 'company-1', 'doc-1')).resolves.toBeUndefined()
    enqueue({ data: null, error: null })
    await expect(requireCompanyDocument(client, 'company-1', 'doc-2')).rejects.toMatchObject({
      code: 'ASSOCIATION_AUDIT_DOCUMENT_NOT_FOUND',
    })
  })
})

describe('buildAuditBundle and auditBundleCsv', () => {
  it('collects roster, audit facts, both registers and the reconciliation, then renders one sectioned CSV', async () => {
    // listAuditors (fetchAllRows): one page, then the members lookup.
    enqueue({ data: [serving, { ...serving, id: 'a0', name: 'Gammal Revisor', kind: 'lekmannarevisor', ended_on: '2024-05-20', appointed_on: '2022-05-20' }], error: null })
    enqueue({ data: [{ id: 'm1', member_number: '1', name: 'Anna' }], error: null })
    vi.mocked(getAnnualReportProfile).mockResolvedValue({
      ...emptyAnnualReportProfile('company-1', 'period-1'),
      auditor_report_required: true,
      auditor_report_included: true,
      auditor_report_signed_on: '2026-03-10',
      auditor_report_opinion: 'unmodified',
    })
    vi.mocked(memberRegisterExtract).mockResolvedValue([
      { member_number: '1', name: 'Anna', postal_address: 'Storgatan 1', admitted_on: '2020-01-01', exited_on: null, contribution_units: 2, contribution_amount: 1000, forlagsinsats_amount: 5000 },
    ])
    vi.mocked(listContributions).mockResolvedValue([
      { id: 'c1', company_id: 'company-1', member_id: 'm1', kind: 'obligatory', units: 2, amount: '1000', status: 'paid', paid_on: '2020-01-01', settled_on: null, journal_entry_id: null, settlement_journal_entry_id: null, notes: null, created_at: '', updated_at: '' },
      { id: 'c2', company_id: 'company-1', member_id: 'm1', kind: 'forlags', units: 1, amount: '5000', status: 'paid', paid_on: '2023-04-01', settled_on: null, journal_entry_id: null, settlement_journal_entry_id: null, notes: null, created_at: '', updated_at: '' },
    ])
    vi.mocked(memberCapitalReconciliation).mockResolvedValue({
      fiscal_period_id: 'period-1',
      lines: [{ label: 'Förlagsinsatser (2084)', accounts: ['2084'], register_amount: 5000, ledger_balance: 5000, difference: 0 }],
      is_reconciled: true,
    })

    const bundle = await buildAuditBundle(client, 'company-1', 'period-1', '2025-12-31')
    expect(bundle.auditors.all).toHaveLength(2)
    expect(bundle.auditors.active_on_period_end.map((a) => a.id)).toEqual(['a1'])
    expect(bundle.audit_facts.auditor_report_opinion).toBe('unmodified')
    expect(bundle.forlagsinsats_register).toEqual([
      expect.objectContaining({ contribution_id: 'c2', member_number: '1', holder_name: 'Anna', amount: 5000 }),
    ])
    expect(bundle.member_capital_reconciliation.is_reconciled).toBe(true)

    const csv = auditBundleCsv(bundle)
    expect(csv).toContain('# Revisorer\nNamn;Slag;')
    expect(csv).toContain('Revisor Ett;auktoriserad_revisor;RI 12345;2024-05-20;;;Stämma 2024 § 12')
    expect(csv).toContain('# Revisionsberättelse\n')
    expect(csv).toContain('true;true;2026-03-10;unmodified;;')
    expect(csv).toContain('# Förteckning över förlagsinsatser\n')
    expect(csv).toContain('1;Anna;1;5000;2023-04-01;paid;')
    expect(csv).toContain('# Avstämning medlemskapital\n')
    expect(csv).toContain('Förlagsinsatser (2084);2084;5000;5000;0')
  })
})
