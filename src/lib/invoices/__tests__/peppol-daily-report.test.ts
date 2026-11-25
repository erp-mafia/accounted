import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'

const emailMock = vi.hoisted(() => ({ isConfigured: vi.fn(), sendEmail: vi.fn() }))
vi.mock('@/lib/email/service', () => ({ getEmailService: () => emailMock }))
// Who pays has one definition (peppol-plan-rule.ts): company-5 pays, the rest do not.
const paidMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/entitlements/has-capability', () => ({
  getCompanyIdsWithCapability: (...args: unknown[]) => paidMock(...args),
}))

import {
  QVALIA_DASHBOARD_URL,
  buildPeppolDailyReport,
  getPeppolDailyReportRecipients,
  renderPeppolDailyReport,
  sendPeppolDailyReport,
} from '@/lib/invoices/peppol-daily-report'

const NOW = new Date('2026-10-19T05:00:00.000Z')

const sentDelivery = {
  id: 'delivery-1',
  company_id: 'company-1',
  status: 'submission_accepted',
  status_at: '2026-10-18T09:15:00.000Z',
  status_detail: null,
  submitted_at: '2026-10-18T09:15:00.000Z',
  provider_submission_id: 'qv-123',
  recipient_scheme: '0007',
  recipient_identifier: '5560000001',
  invoice: { invoice_number: 'F-1042', total: 12500, currency: 'SEK', customer: { name: 'Kund AB' } },
}

const failedDelivery = {
  ...sentDelivery,
  id: 'delivery-2',
  company_id: 'company-2',
  status: 'failed',
  status_at: '2026-10-18T11:00:00.000Z',
  status_detail: 'Validation error: BR-CO-15',
  submitted_at: null,
  provider_submission_id: null,
  invoice: { invoice_number: 'F-7', total: 100, currency: 'SEK', customer: null },
}

type ChainCall = { method: string; args: unknown[] }
const has = (calls: ChainCall[], method: string, first?: unknown) =>
  calls.some((c) => c.method === method && (first === undefined || c.args[0] === first))

function mockSupabase() {
  return createTableMockSupabase({
    peppol_deliveries: (calls: ChainCall[]) => {
      if (has(calls, 'in', 'status')) return { data: [failedDelivery] }
      if (has(calls, 'is', 'submitted_at')) return { data: [{ id: 'm-3', company_id: 'company-3' }] }
      if (has(calls, 'gte', 'submitted_at') && calls.find((c) => c.method === 'gte')?.args[1] === '2026-09-30T22:00:00.000Z') {
        return { data: [{ id: 'm-1', company_id: 'company-1' }, { id: 'm-2', company_id: 'company-1' }] }
      }
      return { data: [sentDelivery] }
    },
    peppol_access: {
      data: [
        { company_id: 'company-1', status: 'enabled', max_sends: 10, requested_at: null, enabled_at: '2026-10-01T08:00:00.000Z', enabled_by: 'anna', disabled_at: null },
        { company_id: 'company-3', status: 'enabled', max_sends: 1, requested_at: null, enabled_at: '2026-10-01T08:00:00.000Z', enabled_by: 'anna', disabled_at: null },
        { company_id: 'company-4', status: 'enabled', max_sends: 10, requested_at: null, enabled_at: '2026-10-01T08:00:00.000Z', enabled_by: 'anna', disabled_at: null },
        // Switched on by the plan rule last night; an older automatic one is not news.
        { company_id: 'company-8', status: 'enabled', max_sends: 10, requested_at: '2026-10-18T18:00:00.000Z', enabled_at: '2026-10-18T18:00:01.000Z', enabled_by: 'automatic: paid plan', disabled_at: null },
        { company_id: 'company-9', status: 'enabled', max_sends: 10, requested_at: '2026-10-02T18:00:00.000Z', enabled_at: '2026-10-02T18:00:01.000Z', enabled_by: 'automatic: paid plan', disabled_at: null },
        { company_id: 'company-5', status: 'requested', max_sends: null, requested_at: '2026-10-18T20:00:00.000Z', enabled_at: null, enabled_by: null, disabled_at: null },
        { company_id: 'company-6', status: 'requested', max_sends: null, requested_at: '2026-10-18T21:00:00.000Z', enabled_at: null, enabled_by: null, disabled_at: null },
        { company_id: 'company-7', status: 'requested', max_sends: null, requested_at: '2026-10-01T08:00:00.000Z', enabled_at: null, enabled_by: null, disabled_at: null },
        // Paused last night: the plan ended.
        { company_id: 'company-10', status: 'requested', max_sends: 10, requested_at: '2026-09-01T08:00:00.000Z', enabled_at: '2026-09-01T08:00:01.000Z', enabled_by: 'anna', disabled_at: '2026-10-19T02:00:00.000Z' },
      ],
    },
    peppol_inbound_documents: { data: null, count: 2 },
    company_settings: {
      data: [
        { company_id: 'company-1', company_name: 'Säljare AB' },
        { company_id: 'company-2', company_name: 'Felande AB' },
        { company_id: 'company-3', company_name: 'Gräns AB' },
        { company_id: 'company-5', company_name: 'Ny Betalande AB' },
        { company_id: 'company-6', company_name: 'Ny Gratis AB' },
        { company_id: 'company-8', company_name: 'Påslagen AB' },
        { company_id: 'company-10', company_name: 'Pausad AB' },
      ],
    },
  })
}

beforeEach(() => {
  paidMock.mockReset()
  paidMock.mockResolvedValue(new Set(['company-5']))
})

describe('getPeppolDailyReportRecipients', () => {
  afterEach(() => { delete process.env.PEPPOL_DAILY_REPORT_RECIPIENTS })

  it('reads a comma separated list and drops blanks', () => {
    process.env.PEPPOL_DAILY_REPORT_RECIPIENTS = ' a@example.test, ,b@example.test,notanaddress '
    expect(getPeppolDailyReportRecipients()).toEqual(['a@example.test', 'b@example.test'])
    delete process.env.PEPPOL_DAILY_REPORT_RECIPIENTS
    expect(getPeppolDailyReportRecipients()).toEqual([])
  })
})

describe('buildPeppolDailyReport', () => {
  it('collects the day, the month per company, what the plan rule did and the new requests with whether they pay', async () => {
    const mock = mockSupabase()
    const report = await buildPeppolDailyReport(mock.supabase as unknown as SupabaseClient, NOW)

    expect(report.since).toBe('2026-10-18T05:00:00.000Z')
    expect(report.sends).toEqual([sentDelivery])
    expect(report.failures).toEqual([failedDelivery])
    // Only companies that sent this month, busiest first; company-4 sent nothing.
    expect(report.month).toEqual([
      { companyId: 'company-1', sent: 2, max: 10 },
      { companyId: 'company-3', sent: 1, max: 1 },
    ])
    expect(report.switchedOn).toEqual(['company-8'])
    expect(report.paused).toEqual(['company-10'])
    // company-7 asked weeks ago: counted as open, not listed as new.
    expect(report.newRequests).toEqual([
      { companyId: 'company-5', requestedAt: '2026-10-18T20:00:00.000Z', paying: true },
      { companyId: 'company-6', requestedAt: '2026-10-18T21:00:00.000Z', paying: false },
    ])
    // Paying is the plan rule's answer: a paid grant, the seeded trial left out.
    expect(paidMock).toHaveBeenCalledWith(expect.anything(), ['company-5', 'company-6'], 'email_send', { excludeTrial: true })
    expect(report.openRequests).toBe(4)
    expect(report.inbound).toBe(2)
    expect(report.names.get('company-1')).toBe('Säljare AB')

    const sendsQuery = mock.calls.filter((c) => c.table === 'peppol_deliveries')
    expect(sendsQuery.some((c) => c.method === 'gte' && c.args[0] === 'submitted_at' && c.args[1] === '2026-10-18T05:00:00.000Z')).toBe(true)
    // The month starts on 1 October in Stockholm.
    expect(sendsQuery.some((c) => c.method === 'gte' && c.args[0] === 'submitted_at' && c.args[1] === '2026-09-30T22:00:00.000Z')).toBe(true)
    expect(sendsQuery.some((c) => c.method === 'gte' && c.args[0] === 'created_at' && c.args[1] === '2026-09-30T22:00:00.000Z')).toBe(true)
  })

  it('throws when a query fails, so the run is logged instead of mailing a wrong report', async () => {
    const mock = createTableMockSupabase({ peppol_deliveries: { data: null, error: { message: 'boom' } } })
    await expect(buildPeppolDailyReport(mock.supabase as unknown as SupabaseClient, NOW)).rejects.toThrow('sends: boom')
  })
})

describe('renderPeppolDailyReport', () => {
  it('lists every send with its Qvalia id and points to the Qvalia dashboard', async () => {
    const mock = mockSupabase()
    const report = await buildPeppolDailyReport(mock.supabase as unknown as SupabaseClient, NOW)
    const { subject, text, html } = renderPeppolDailyReport(report)

    expect(subject).toMatch(/Dagsrapport 19 okt\.?: 1 skickade, 1 fel$/)
    expect(text).toContain('11:15 Säljare AB, faktura F-1042 till Kund AB (0007:5560000001)')
    expect(text).toContain('Qvalia-id qv-123')
    expect(text).toContain('status failed: Validation error: BR-CO-15')
    expect(text).toContain('Säljare AB: 2 av 10')
    expect(text).toContain('Gräns AB: 1 av 1 (gränsen nådd)')
    expect(text).toContain('Påslagna automatiskt senaste dygnet (1)')
    expect(text).toContain('Påslagen AB (company-8)')
    expect(text).toContain('Pausade senaste dygnet, abonnemanget slutade (1)')
    expect(text).toContain('Pausad AB (company-10)')
    expect(text).toContain('Ny Betalande AB: betalar, slås på inom tio minuter')
    expect(text).toContain('Ny Gratis AB: betalar inte, väntar på ett betalt abonnemang')
    expect(text).toContain('Mottagna dokument: 2.')
    expect(text).toContain(QVALIA_DASHBOARD_URL)
    expect(html).toContain(`href="${QVALIA_DASHBOARD_URL}"`)
  })

  it('says so on a quiet day instead of leaving sections blank', () => {
    const { subject, text } = renderPeppolDailyReport({
      since: '2026-10-18T05:00:00.000Z',
      until: NOW.toISOString(),
      sends: [],
      failures: [],
      month: [],
      switchedOn: [],
      paused: [],
      newRequests: [],
      openRequests: 0,
      inbound: 0,
      names: new Map(),
    })
    expect(subject).toMatch(/0 skickade, 0 fel$/)
    expect(text).toContain('Inga Peppol-fakturor skickades.')
    expect(text).toContain('Inga fel.')
    expect(text).toContain('Inga nya förfrågningar som väntar.')
  })

  it('escapes company and buyer names in the html', () => {
    const { html } = renderPeppolDailyReport({
      since: '2026-10-18T05:00:00.000Z',
      until: NOW.toISOString(),
      sends: [{ ...sentDelivery, invoice: { ...sentDelivery.invoice, customer: { name: '<script>x</script>' } } }],
      failures: [],
      month: [],
      switchedOn: [],
      paused: [],
      newRequests: [],
      openRequests: 0,
      inbound: 0,
      names: new Map([['company-1', 'A & B']]),
    })
    expect(html).not.toContain('<script>')
    expect(html).toContain('A &amp; B')
  })
})

describe('sendPeppolDailyReport', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    emailMock.isConfigured.mockReturnValue(true)
    emailMock.sendEmail.mockResolvedValue({ success: true })
    process.env.PEPPOL_DAILY_REPORT_RECIPIENTS = 'a@example.test,b@example.test'
  })
  afterEach(() => { delete process.env.PEPPOL_DAILY_REPORT_RECIPIENTS })

  it('mails the recipients', async () => {
    const result = await sendPeppolDailyReport(mockSupabase().supabase as unknown as SupabaseClient, NOW)
    expect(result).toEqual({ sent: true, sends: 1, failures: 1, recipients: 2 })
    expect(emailMock.sendEmail).toHaveBeenCalledTimes(1)
    expect(emailMock.sendEmail.mock.calls[0][0].to).toEqual(['a@example.test', 'b@example.test'])
  })

  it('skips without recipients or without an e-mail service, before reading anything', async () => {
    delete process.env.PEPPOL_DAILY_REPORT_RECIPIENTS
    const mock = mockSupabase()
    expect(await sendPeppolDailyReport(mock.supabase as unknown as SupabaseClient, NOW)).toEqual({ sent: false, reason: 'no_recipients' })

    process.env.PEPPOL_DAILY_REPORT_RECIPIENTS = 'a@example.test'
    emailMock.isConfigured.mockReturnValue(false)
    expect(await sendPeppolDailyReport(mock.supabase as unknown as SupabaseClient, NOW)).toEqual({ sent: false, reason: 'email_not_configured' })
    expect(mock.calls).toHaveLength(0)
    expect(emailMock.sendEmail).not.toHaveBeenCalled()
  })

  it('reports a failed send', async () => {
    emailMock.sendEmail.mockResolvedValue({ success: false, error: 'rate limited' })
    expect(await sendPeppolDailyReport(mockSupabase().supabase as unknown as SupabaseClient, NOW))
      .toEqual({ sent: false, reason: 'send_failed', detail: 'rate limited' })
  })
})
