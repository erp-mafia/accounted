import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'

const sendAttestDecisionMail = vi.fn()
vi.mock('@/lib/email/send-attest-decision', () => ({ sendAttestDecisionMail: (...args: unknown[]) => sendAttestDecisionMail(...args) }))
vi.mock('@/lib/email/brand-sender', () => ({ getBaseUrlForCompany: async () => 'https://byra.accounted.se/' }))

import { createAttestDecisionBatch, decisionRecipients, notifyAttestDecisions, notifyAttestDecisionSafely } from '../attest-decision-notify'

const POLICY = { company_id: 'c1', enabled: true, threshold_amount: null, mode: 'any', attesters: ['kim'], preparer_may_attest: false, updated_by: null, updated_at: null }

const invoice = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  user_id: 'alex',
  // Attested: the approval completed the attest.
  approved_at: '2026-10-31T10:00:00Z',
  is_credit_note: false,
  currency: 'SEK',
  total: 29625,
  total_sek: null,
  exchange_rate: null,
  supplier_invoice_number: `F-${id}`,
  arrival_number: 7,
  due_date: '2026-09-15',
  supplier: { name: 'Möbelfirman AB' },
  ...overrides,
})

const service = createTableMockSupabase()

function seed(overrides: Record<string, unknown> = {}) {
  service.reset()
  const tables: Record<string, unknown> = {
    company_attest_policies: { data: POLICY },
    supplier_invoices: { data: [invoice('mf-1'), invoice('mf-2', { total: 24375 }), invoice('kb', { supplier: { name: 'Konsultbolaget AB' }, total: 11250, due_date: '2026-11-19', approved_at: null })] },
    company_settings: { data: { accounting_method: 'accrual' } },
    companies: { data: { name: 'Kundbolaget AB', team_id: 'team-1' } },
    company_members: {
      data: [
        { user_id: 'alex', role: 'owner' },
        { user_id: 'robin', role: 'admin' },
        { user_id: 'kim', role: 'admin' },
      ],
    },
    teams: { data: { kind: 'byra' } },
    team_members: { data: [{ user_id: 'alex' }, { user_id: 'robin' }] },
    profiles: {
      data: [
        { id: 'alex', email: 'alex@byra.example', full_name: 'Alex' },
        { id: 'robin', email: 'robin@byra.example', full_name: 'Robin' },
        { id: 'kim', email: 'kim@client.example', full_name: 'Kim' },
      ],
    },
    ...overrides,
  }
  for (const [key, value] of Object.entries(tables)) service.setTable(key, value as never)
}

const supabase = () => service.supabase as unknown as SupabaseClient

describe('notifyAttestDecisions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sendAttestDecisionMail.mockResolvedValue({ emailSent: true })
  })

  it('tells the registrant in ONE mail about every invoice the attester decided in one go', async () => {
    seed()
    const result = await notifyAttestDecisions(supabase(), 'c1', 'kim', [
      { invoiceId: 'mf-1', decision: 'approved', comment: null },
      { invoiceId: 'mf-2', decision: 'approved', comment: null },
      { invoiceId: 'kb', decision: 'rejected', comment: 'Inte beställt' },
    ])
    expect(result).toEqual({ mailed: 1, skipped_no_recipient: 0 })
    expect(sendAttestDecisionMail).toHaveBeenCalledTimes(1)
    const [{ email, data }] = sendAttestDecisionMail.mock.calls[0] as [{ email: string; data: Record<string, unknown> }]
    expect(email).toBe('alex@byra.example')
    expect(data).toMatchObject({ companyName: 'Kundbolaget AB', attesterName: 'Kim', reason: 'registrant' })
    expect(data.listUrl).toBe('https://byra.accounted.se/supplier-invoices?tab=to_pay')
    expect(data.invoices).toEqual([
      expect.objectContaining({ supplierName: 'Möbelfirman AB', total: 29625, decision: 'approved', comment: null }),
      expect.objectContaining({ supplierName: 'Möbelfirman AB', total: 24375, decision: 'approved' }),
      expect.objectContaining({ supplierName: 'Konsultbolaget AB', decision: 'rejected', comment: 'Inte beställt' }),
    ])
  })

  it('a rejection alone points at the invoices still waiting, not at Att betala', async () => {
    seed()
    await notifyAttestDecisions(supabase(), 'c1', 'kim', [{ invoiceId: 'kb', decision: 'rejected', comment: null }])
    const [{ data }] = sendAttestDecisionMail.mock.calls[0] as [{ data: { listUrl: string } }]
    expect(data.listUrl).toBe('https://byra.accounted.se/supplier-invoices?tab=registered')
  })

  it('tells nobody without a governing policy: off, kontantmetoden, a credit note', async () => {
    seed({ company_attest_policies: { data: { ...POLICY, enabled: false } } })
    expect(await notifyAttestDecisions(supabase(), 'c1', 'kim', [{ invoiceId: 'mf-1', decision: 'approved', comment: null }])).toEqual({ mailed: 0, skipped_no_recipient: 0 })
    seed({ company_settings: { data: { accounting_method: 'cash' } } })
    await notifyAttestDecisions(supabase(), 'c1', 'kim', [{ invoiceId: 'mf-1', decision: 'approved', comment: null }])
    seed({ supplier_invoices: { data: [invoice('mf-1', { is_credit_note: true })] } })
    await notifyAttestDecisions(supabase(), 'c1', 'kim', [{ invoiceId: 'mf-1', decision: 'approved', comment: null }])
    expect(sendAttestDecisionMail).not.toHaveBeenCalled()
  })

  it('tells nobody about their own decision', async () => {
    seed({ supplier_invoices: { data: [invoice('mf-1', { user_id: 'kim' })] } })
    expect(await notifyAttestDecisions(supabase(), 'c1', 'kim', [{ invoiceId: 'mf-1', decision: 'approved', comment: null }])).toEqual({ mailed: 0, skipped_no_recipient: 0 })
    expect(sendAttestDecisionMail).not.toHaveBeenCalled()
  })

  it('falls back to the byrå\'s owners and admins when the registrant has left the company', async () => {
    seed({ supplier_invoices: { data: [invoice('mf-1', { user_id: 'gone' })] } })
    expect(await notifyAttestDecisions(supabase(), 'c1', 'kim', [{ invoiceId: 'mf-1', decision: 'approved', comment: null }])).toMatchObject({ mailed: 2 })
    const emails = sendAttestDecisionMail.mock.calls.map(([call]) => (call as { email: string }).email).sort()
    // Kim is an admin too, but they decided: never told about their own answer.
    expect(emails).toEqual(['alex@byra.example', 'robin@byra.example'])
    expect((sendAttestDecisionMail.mock.calls[0][0] as { data: { reason: string } }).data.reason).toBe('fallback')
  })

  it('throws on a failed read, and the service\'s call swallows it', async () => {
    seed({ supplier_invoices: { error: { message: 'boom' } } })
    await expect(notifyAttestDecisions(supabase(), 'c1', 'kim', [{ invoiceId: 'mf-1', decision: 'approved', comment: null }])).rejects.toBeTruthy()
    await expect(notifyAttestDecisionSafely(supabase(), 'c1', 'kim', { invoiceId: 'mf-1', decision: 'approved', comment: null })).resolves.toBeUndefined()
  })

  it('sends nothing on any failed read: a settings read is no faktureringsmetoden, a team read no license to mail the client\'s owners', async () => {
    const approved = [{ invoiceId: 'mf-1', decision: 'approved' as const, comment: null }]
    for (const failing of ['company_settings', 'companies', 'teams', 'team_members']) {
      // The registrant has left, so the byrå team decides who hears it.
      seed({ supplier_invoices: { data: [invoice('mf-1', { user_id: 'gone' })] }, [failing]: { error: { message: `${failing} unavailable` } } })
      await expect(notifyAttestDecisions(supabase(), 'c1', 'kim', approved), failing).rejects.toBeTruthy()
      await notifyAttestDecisionSafely(supabase(), 'c1', 'kim', approved[0])
    }
    expect(sendAttestDecisionMail).not.toHaveBeenCalled()
  })

  it('tells nobody about an approval that did not complete the attest: the first of two attesters is no answer yet', async () => {
    seed({ supplier_invoices: { data: [invoice('mf-1', { approved_at: null })] } })
    expect(await notifyAttestDecisions(supabase(), 'c1', 'kim', [{ invoiceId: 'mf-1', decision: 'approved', comment: null }])).toEqual({ mailed: 0, skipped_no_recipient: 0 })
    expect(sendAttestDecisionMail).not.toHaveBeenCalled()
  })
})

describe('createAttestDecisionBatch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sendAttestDecisionMail.mockResolvedValue({ emailSent: true })
  })

  it('sends one mail per company and attester for every decision added, once', async () => {
    seed()
    const batch = createAttestDecisionBatch()
    batch.add('c1', 'kim', { invoiceId: 'mf-1', decision: 'approved', comment: null })
    batch.add('c1', 'kim', { invoiceId: 'mf-2', decision: 'approved', comment: null })
    batch.add('c1', 'kim', { invoiceId: 'kb', decision: 'rejected', comment: 'Inte beställt' })
    expect(batch.size).toBe(3)
    await batch.flush(supabase())
    expect(sendAttestDecisionMail).toHaveBeenCalledTimes(1)
    expect((sendAttestDecisionMail.mock.calls[0][0] as { data: { invoices: unknown[] } }).data.invoices).toHaveLength(3)
    // Flushed: a second flush sends nothing again.
    await batch.flush(supabase())
    expect(sendAttestDecisionMail).toHaveBeenCalledTimes(1)
    expect(batch.size).toBe(0)
  })

  it('keeps companies and attesters apart, and never throws', async () => {
    seed()
    const batch = createAttestDecisionBatch()
    batch.add('c1', 'kim', { invoiceId: 'mf-1', decision: 'approved', comment: null })
    batch.add('c2', 'kim', { invoiceId: 'mf-2', decision: 'approved', comment: null })
    batch.add('c1', 'robin', { invoiceId: 'kb', decision: 'rejected', comment: null })
    await batch.flush(supabase())
    expect(sendAttestDecisionMail).toHaveBeenCalledTimes(3)

    seed({ supplier_invoices: { error: { message: 'boom' } } })
    const failing = createAttestDecisionBatch()
    failing.add('c1', 'kim', { invoiceId: 'mf-1', decision: 'approved', comment: null })
    await expect(failing.flush(supabase())).resolves.toBeUndefined()
  })
})

describe('decisionRecipients', () => {
  const writers = new Map([
    ['alex', 'owner'],
    ['robin', 'admin'],
    ['anna', 'member'],
    ['kim', 'admin'],
  ])
  const reachable = new Set(['alex', 'robin', 'anna', 'kim'])

  it('is the registrant while they keep the books and have an address', () => {
    expect(decisionRecipients({ registrantId: 'anna', attesterId: 'kim', writers, reachable, byraTeam: new Set() })).toEqual({ ids: ['anna'], reason: 'registrant' })
  })

  it('falls back to owners and admins, the byrå team\'s when there is one, never the attester', () => {
    expect(decisionRecipients({ registrantId: 'gone', attesterId: 'kim', writers, reachable, byraTeam: new Set(['alex']) })).toEqual({ ids: ['alex'], reason: 'fallback' })
    expect(decisionRecipients({ registrantId: 'gone', attesterId: 'kim', writers, reachable, byraTeam: new Set() })).toEqual({ ids: ['alex', 'robin'], reason: 'fallback' })
    // A registrant without an address is no better than one who left.
    expect(decisionRecipients({ registrantId: 'anna', attesterId: 'kim', writers, reachable: new Set(['alex']), byraTeam: new Set() }).ids).toEqual(['alex'])
  })

  it('is nobody when the attester registered it', () => {
    expect(decisionRecipients({ registrantId: 'kim', attesterId: 'kim', writers, reachable, byraTeam: new Set() }).ids).toEqual([])
  })
})
