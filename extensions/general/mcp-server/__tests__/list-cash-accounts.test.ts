import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'

vi.mock('@/lib/cash-accounts/service', async () => {
  const actual = await vi.importActual<typeof import('@/lib/cash-accounts/service')>('@/lib/cash-accounts/service')
  return { ...actual, listForCompany: vi.fn() }
})

import { listForCompany } from '@/lib/cash-accounts/service'
import { tools, isDefaultCatalogTool } from '../server'

const tool = tools.find((t) => t.name === 'gnubok_list_cash_accounts')!

describe('gnubok_list_cash_accounts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('is a read-only, search-only transactions:read discovery tool', () => {
    expect(tool).toBeDefined()
    expect(TOOL_SCOPE_MAP.gnubok_list_cash_accounts).toBe('transactions:read')
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true })
    expect(tool.catalogVisibility).toBe('search')
    expect(isDefaultCatalogTool(tool)).toBe(false)
  })

  it('maps cash_accounts rows to the qualified wire shape, primary first', async () => {
    vi.mocked(listForCompany).mockResolvedValue([
      { id: 'ca-1', company_id: 'company-1', ledger_account: '1930', name: 'Företagskonto', currency: 'SEK', iban: 'SE4550000000058398257466', is_primary: true, enabled: true, source: 'enable_banking' },
      { id: 'ca-2', company_id: 'company-1', ledger_account: '1940', name: null, currency: 'SEK', iban: null, is_primary: false, enabled: false, source: 'manual' },
    ] as never)

    const result = (await tool.execute({}, 'company-1', 'user-1', {} as never)) as {
      cash_accounts: Array<Record<string, unknown>>
      count: number
    }

    expect(listForCompany).toHaveBeenCalledWith({}, 'company-1', { enabledOnly: false })
    expect(result.count).toBe(2)
    expect(result.cash_accounts[0]).toEqual({
      cash_account_id: 'ca-1',
      ledger_account: '1930',
      name: 'Företagskonto',
      currency: 'SEK',
      iban: 'SE4550000000058398257466',
      is_primary: true,
      enabled: true,
      source: 'enable_banking',
    })
    expect(result.cash_accounts[1]).toMatchObject({ cash_account_id: 'ca-2', name: null, iban: null, enabled: false, source: 'manual' })
    // No bare `id` leaks onto the wire (qualified-ids convention).
    expect(result.cash_accounts[0]).not.toHaveProperty('id')
  })

  it('passes enabled_only through', async () => {
    vi.mocked(listForCompany).mockResolvedValue([])
    await tool.execute({ enabled_only: true }, 'company-1', 'user-1', {} as never)
    expect(listForCompany).toHaveBeenCalledWith({}, 'company-1', { enabledOnly: true })
  })
})
