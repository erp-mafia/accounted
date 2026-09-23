import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'

vi.mock('@/lib/company/context', () => ({
  getUserCompanies: vi.fn(),
}))

import { getUserCompanies } from '@/lib/company/context'
import { tools } from '../server'

const DEFAULT_COMPANY_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_COMPANY_ID = '22222222-2222-4222-8222-222222222222'
const ARCHIVED_COMPANY_ID = '33333333-3333-4333-8333-333333333333'
const listCompaniesTool = tools.find((tool) => tool.name === 'gnubok_list_companies')!

describe('gnubok_list_companies', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('is a read-only companies:read discovery tool', () => {
    expect(listCompaniesTool).toBeDefined()
    expect(TOOL_SCOPE_MAP.gnubok_list_companies).toBe('companies:read')
    expect(listCompaniesTool.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    })
  })

  it('lists every non-archived membership with role and marks the default', async () => {
    vi.mocked(getUserCompanies).mockResolvedValue([
      {
        company_id: DEFAULT_COMPANY_ID,
        role: 'owner',
        joined_at: '2026-01-01',
        companies: {
          id: DEFAULT_COMPANY_ID,
          name: 'Legal Default AB',
          org_number: '559000-0001',
          entity_type: 'AB',
          archived_at: null,
          created_at: '2026-01-01',
        },
      },
      {
        company_id: OTHER_COMPANY_ID,
        role: 'viewer',
        joined_at: '2026-02-01',
        companies: {
          id: OTHER_COMPANY_ID,
          name: 'Other Legal Name',
          org_number: null,
          entity_type: 'EF',
          archived_at: null,
          created_at: '2026-02-01',
        },
      },
      {
        company_id: ARCHIVED_COMPANY_ID,
        role: 'admin',
        joined_at: '2026-03-01',
        companies: {
          id: ARCHIVED_COMPANY_ID,
          name: 'Archived AB',
          org_number: '559000-0003',
          entity_type: 'AB',
          archived_at: '2026-06-01',
          created_at: '2026-03-01',
        },
      },
    ] as never)

    const rangeMock = vi.fn().mockResolvedValue({
      data: [{ company_id: DEFAULT_COMPANY_ID, company_name: 'Configured Default AB' }],
      error: null,
    })
    const orderMock = vi.fn(() => ({ range: rangeMock }))
    const inMock = vi.fn(() => ({ order: orderMock }))
    const supabase = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({ in: inMock })),
      })),
    }

    const result = (await listCompaniesTool.execute(
      {},
      DEFAULT_COMPANY_ID,
      'user-1',
      supabase as never,
      { type: 'api_key' }
    )) as Record<string, unknown>

    expect(getUserCompanies).toHaveBeenCalledWith(supabase, 'user-1')
    expect(inMock).toHaveBeenCalledWith('company_id', [DEFAULT_COMPANY_ID, OTHER_COMPANY_ID])
    expect(orderMock).toHaveBeenCalledWith('company_id', { ascending: true })
    expect(rangeMock).toHaveBeenCalledWith(0, 999)
    expect(result).toEqual({
      companies: [
        {
          company_id: DEFAULT_COMPANY_ID,
          name: 'Configured Default AB',
          org_number: '559000-0001',
          entity_type: 'AB',
          role: 'owner',
          is_default: true,
        },
        {
          company_id: OTHER_COMPANY_ID,
          name: 'Other Legal Name',
          org_number: null,
          entity_type: 'EF',
          role: 'viewer',
          is_default: false,
        },
      ],
      count: 2,
      default_company_id: DEFAULT_COMPANY_ID,
    })
  })
})
