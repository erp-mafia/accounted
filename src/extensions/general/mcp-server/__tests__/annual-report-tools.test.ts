import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { buildCanonicalAnnualReport } from '@/lib/bokslut/arsredovisning/model'
import { listAnnualReportVersions } from '@/lib/bokslut/arsredovisning/version-service'
import { tools } from '../server'

vi.mock('@/lib/bokslut/arsredovisning/model', () => ({
  buildCanonicalAnnualReport: vi.fn(),
}))

vi.mock('@/lib/bokslut/arsredovisning/version-service', () => ({
  listAnnualReportVersions: vi.fn(),
}))

const annualReportToolNames = [
  'gnubok_preview_arsredovisning',
  'gnubok_validate_arsredovisning',
  'gnubok_list_arsredovisning_versions',
  'gnubok_get_arsredovisning_filing_status',
] as const

function tool(name: (typeof annualReportToolNames)[number]) {
  const found = tools.find((candidate) => candidate.name === name)
  if (!found) throw new Error(`Missing MCP tool ${name}`)
  return found
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('annual report MCP tools', () => {
  it('registers every annual report tool as read-only and scope protected', () => {
    for (const name of annualReportToolNames) {
      const registered = tool(name)
      expect(registered.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      })
      expect(TOOL_SCOPE_MAP[name]).toBe('reports:read')
    }
  })

  it('uses signing validation before a report version is locked', async () => {
    const { supabase } = createQueuedMockSupabase()
    vi.mocked(buildCanonicalAnnualReport).mockResolvedValue({
      report: { accounting_framework: 'k2' },
      profile: {},
      eligibility: { k2_eligible: true },
      validation: { ok: true, issues: [] },
    } as never)

    const result = await tool('gnubok_validate_arsredovisning').execute(
      { fiscal_period_id: 'period-1', stage: 'signing' },
      'company-1',
      'user-1',
      supabase as never,
    )

    expect(buildCanonicalAnnualReport).toHaveBeenCalledWith(
      supabase,
      'company-1',
      'period-1',
      { stage: 'signing', includeIxbrl: false },
    )
    expect(result).toMatchObject({ fiscal_period_id: 'period-1', framework: 'k2' })
  })

  it('lists immutable versions through the canonical version service', async () => {
    const { supabase } = createQueuedMockSupabase()
    vi.mocked(listAnnualReportVersions).mockResolvedValue([
      { id: 'version-1', version_number: 1, status: 'signed' },
    ] as never)

    const result = await tool('gnubok_list_arsredovisning_versions').execute(
      { fiscal_period_id: 'period-1' },
      'company-1',
      'user-1',
      supabase as never,
    )

    expect(listAnnualReportVersions).toHaveBeenCalledWith(
      supabase,
      'company-1',
      'period-1',
    )
    expect(result).toMatchObject({
      fiscal_period_id: 'period-1',
      versions: [{ id: 'version-1', status: 'signed' }],
    })
  })

  it('keeps Bolagsverket technical document ids out of filing-status output', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        {
          id: 'submission-1',
          status: 'uploaded',
          idnummer: 'technical-id',
          bolagsverket_url: 'https://example.test/sign',
        },
      ],
      error: null,
    })

    const result = await tool('gnubok_get_arsredovisning_filing_status').execute(
      { fiscal_period_id: 'period-1' },
      'company-1',
      'user-1',
      supabase as never,
    ) as { submissions: Array<Record<string, unknown>> }

    expect(result.submissions).toEqual([
      {
        id: 'submission-1',
        status: 'uploaded',
        bolagsverket_url: 'https://example.test/sign',
      },
    ])
  })
})
