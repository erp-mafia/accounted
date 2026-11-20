/**
 * The Bankgiro Lookup tools generated from src/lib/operations/bankgiro-lookup.ts:
 * two reads, search-only (no cost to the tools/list budget), gated by the
 * operation scopes, and dark while OPENPAYMENTS_BANKGIRO_LOOKUP is off.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/connect/instance/connector-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/connect/instance/connector-fetch')>()),
  callConnectorOperation: vi.fn(),
}))

import { callConnectorOperation } from '@/lib/connect/instance/connector-fetch'
import { TOOL_SCOPE_MAP } from '@/lib/auth/scope-catalog'
import { resetBankgiroLookupCache } from '@/lib/payments/bankgiro-lookup'
import { isDefaultCatalogTool, tools } from '../server'

const call = vi.mocked(callConnectorOperation)
const COMPANY_ID = '11111111-1111-4111-8111-111111111111'
const USER_ID = '22222222-2222-4222-8222-222222222222'

const tool = (name: string) => {
  const found = tools.find((t) => t.name === name)
  if (!found) throw new Error(`tool ${name} not registered`)
  return found
}

beforeEach(() => {
  vi.clearAllMocks()
  resetBankgiroLookupCache()
})
afterEach(() => vi.unstubAllEnvs())

describe('Bankgiro Lookup tools', () => {
  it('registers two read-only, search-only tools under the operation scopes', () => {
    const creditor = tool('gnubok_lookup_bankgiro_creditor')
    const giros = tool('gnubok_list_company_giro_numbers')
    for (const t of [creditor, giros]) {
      expect(isDefaultCatalogTool(t)).toBe(false)
      expect(t.annotations.readOnlyHint).toBe(true)
      expect(t.description.length).toBeLessThanOrEqual(280)
      expect((t.inputSchema as { additionalProperties?: boolean }).additionalProperties).toBe(false)
    }
    expect(TOOL_SCOPE_MAP.gnubok_lookup_bankgiro_creditor).toBe('suppliers:read')
    expect(TOOL_SCOPE_MAP.gnubok_list_company_giro_numbers).toBe('companies:read')
  })

  it('takes the giro, its type and an optional OCR or invoice reference', () => {
    const schema = tool('gnubok_lookup_bankgiro_creditor').inputSchema as { properties: Record<string, unknown>; required?: string[] }
    expect(Object.keys(schema.properties).sort()).toEqual(['giro', 'invoice_ref', 'ocr', 'type'])
    expect([...(schema.required ?? [])].sort()).toEqual(['giro', 'type'])
    const out = tool('gnubok_lookup_bankgiro_creditor').outputSchema as { properties: Record<string, unknown> }
    expect(Object.keys(out.properties).sort()).toEqual(['available', 'creditor_name', 'enabled', 'ocr_valid', 'reason', 'warnings'])
  })

  it('answers enabled false and asks nothing while the flag is off', async () => {
    vi.stubEnv('OPENPAYMENTS_BANKGIRO_LOOKUP', '')
    const creditor = await tool('gnubok_lookup_bankgiro_creditor').execute({ giro: '5050-1055', type: 'bankgiro' }, COMPANY_ID, USER_ID, {} as never)
    expect(creditor).toEqual({ enabled: false, available: false, reason: null, creditor_name: null, ocr_valid: null, warnings: [] })
    const giros = await tool('gnubok_list_company_giro_numbers').execute({}, COMPANY_ID, USER_ID, {} as never)
    expect(giros).toEqual({ enabled: false, available: false, reason: null, giro_numbers: [] })
    expect(call).not.toHaveBeenCalled()
  })

  it('refuses an argument outside the contract before anything is asked', async () => {
    vi.stubEnv('OPENPAYMENTS_BANKGIRO_LOOKUP', 'true')
    await expect(tool('gnubok_lookup_bankgiro_creditor').execute({ giro: '5050-1055', type: 'iban' }, COMPANY_ID, USER_ID, {} as never)).rejects.toThrow()
    expect(call).not.toHaveBeenCalled()
  })
})
