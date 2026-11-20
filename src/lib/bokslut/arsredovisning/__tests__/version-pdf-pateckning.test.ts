/**
 * A locked version renders as it was signed (BFL 7 kap. 1 §): the
 * revisorspåteckning on a version's PDF comes from the version itself, never
 * from the profile as it stands today. A version without a revisor slot gets
 * no påteckning; a signed revisor slot shows what was frozen on it; only a
 * revisor slot still pending reads the profile.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { ArsredovisningData } from '../types'

const rendered = vi.hoisted(() => [] as Array<{ data: ArsredovisningData; mode: string }>)
vi.mock('@react-pdf/renderer', () => ({ renderToBuffer: vi.fn(async () => Buffer.from('%PDF-1.4')) }))
vi.mock('../arsredovisning-pdf', () => ({
  ArsredovisningPDF: (props: { data: ArsredovisningData; mode: string }) => {
    rendered.push(props)
    return null
  },
}))
vi.mock('../arsredovisning-k3-pdf', () => ({
  ArsredovisningK3PDF: (props: { data: ArsredovisningData; mode: string }) => {
    rendered.push(props)
    return null
  },
}))
vi.mock('../version-service', () => ({ getAnnualReportVersion: vi.fn() }))

import { getAnnualReportVersion } from '../version-service'
import { getArsredovisningESigningPdf, getArsredovisningPdfFile } from '../file-service'

const query = { fiscal_period_id: 'fp-1', version_id: 'v-1' }

function lockedVersion(status: string) {
  vi.mocked(getAnnualReportVersion).mockResolvedValue({
    summary: { id: 'v-1', status },
    report_data: {
      company: { name: 'Testbolaget AB', org_number: '556677-8899', entity_type: 'aktiebolag', registered_office: 'Stockholm' },
      fiscal_period: { id: 'fp-1', period_start: '2025-01-01', period_end: '2025-12-31' },
      accounting_framework: 'k2',
      signatures: [],
    },
  } as never)
}

function context() {
  const mock = createQueuedMockSupabase()
  return { mock, ctx: { supabase: mock.supabase, companyId: 'company-1', userId: 'user-1', log: { warn: vi.fn() } } as never }
}

const board = { role: 'Styrelseledamot', signer_name: 'Karl Karlsson', signed_at: '2026-02-20T10:00:00Z', pateckning_opinion: null, pateckning_firm_name: null }

beforeEach(() => {
  vi.clearAllMocks()
  rendered.length = 0
})

describe('the revisorspåteckning on a locked version', () => {
  it('prints none on a version without a revisor slot, and never reads the profile', async () => {
    lockedVersion('filed')
    const { mock, ctx } = context()
    mock.enqueue({ data: [board] })
    // Were the profile read, it would say a revisionsberättelse is required.
    mock.enqueue({ data: { auditor_report_required: true, auditor_firm_name: 'Revisionsbyrån AB', auditor_opinion: 'unmodified' } })

    const result = await getArsredovisningPdfFile(ctx, query, { leaseLiveRead: false })

    expect(result.ok).toBe(true)
    expect(rendered[0].data.auditor_pateckning).toBeUndefined()
    expect(mock.findCalls('annual_report_profiles', 'select')).toEqual([])
  })

  it('prints the påteckning frozen on the signed revisor slot, whatever the profile says now', async () => {
    lockedVersion('filed')
    const { mock, ctx } = context()
    mock.enqueue({
      data: [
        board,
        {
          role: 'Auktoriserad revisor',
          signer_name: 'Rita Revisor',
          signed_at: '2026-02-24T10:00:00Z',
          pateckning_opinion: 'avstyrkt_br',
          pateckning_firm_name: 'Revisionsbyrån AB',
        },
      ],
    })

    await getArsredovisningPdfFile(ctx, query, { leaseLiveRead: false })

    expect(rendered[0].mode).toBe('signing')
    expect(rendered[0].data.auditor_pateckning).toEqual({ required: true, firm_name: 'Revisionsbyrån AB', opinion: 'avstyrkt_br' })
    expect(mock.findCalls('annual_report_profiles', 'select')).toEqual([])
  })

  it('reads the profile while the revisor slot is still pending', async () => {
    lockedVersion('ready_for_signature')
    const { mock, ctx } = context()
    mock.enqueue({
      data: [board, { role: 'Godkänd revisor', signer_name: 'Rita Revisor', signed_at: null, pateckning_opinion: null, pateckning_firm_name: null }],
    })
    mock.enqueue({ data: { auditor_report_required: true, auditor_firm_name: null, auditor_opinion: 'modified' } })

    await getArsredovisningESigningPdf(ctx, query)

    expect(rendered[0].mode).toBe('e_signing')
    expect(rendered[0].data.auditor_pateckning).toEqual({ required: true, firm_name: null, opinion: 'modified' })
  })
})
