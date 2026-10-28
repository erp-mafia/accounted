/**
 * The tax payment file pays from the same account as the salary and supplier
 * files (crm#1483): the primary bank account, the one the salary verifikat
 * credits, never the IBAN SEK invoices print. The real batch debtor and
 * paying-account rule run behind the route; tables answer by name.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  createMockRouteParams,
  createTableMockSupabase,
  makePayingCashAccount,
  payingCashAccountsTable,
} from '@/tests/helpers'

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('@/lib/skatteverket/skattekonto-ocr', () => ({
  resolveSkattekontoOcr: vi.fn().mockResolvedValue('1655954700217'),
  SKATTEKONTO_BANKGIRO: '5050-1055',
}))

import { GET } from '../route'

const IBAN_1930 = 'SE4550000000058398257466'
const IBAN_1931 = 'SE7150000000058391234567'
const SEB = { bank_name: 'SEB', bic: 'ESSESESS' }

describe('GET /api/skatteverket/tax-payments/[period]/payment-file: the paying account', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('pays the tax from the primary bank account, not the savings account invoices print', async () => {
    const { supabase } = createTableMockSupabase({
      agi_declarations: { data: { id: 'agi-1', total_tax: 1000, total_avgifter: 500 } },
      companies: { data: { name: 'Test AB', org_number: '5566778899', entity_type: 'aktiebolag' } },
      // No company bankgiro: the bankgiro payee is then debited from the IBAN.
      company_settings: {
        data: { company_name: 'Test AB', org_number: '5566778899', city: 'Stockholm', iban: IBAN_1931, bic: 'ESSESESS', bankgiro: null },
      },
      cash_accounts: payingCashAccountsTable([
        makePayingCashAccount({ name: 'Företagskonto', bank_connection_id: 'bc-1', iban: IBAN_1930, bank_connection: SEB }),
        makePayingCashAccount({
          id: 'ca-1931',
          name: 'Sparkonto',
          ledger_account: '1931',
          is_primary: false,
          bank_connection_id: 'bc-1',
          iban: IBAN_1931,
          payee_iban: IBAN_1931,
          bank_connection: SEB,
        }),
      ]),
    })
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })

    const response = await GET(
      createMockRequest('/api/skatteverket/tax-payments/2026-04/payment-file', { searchParams: { format: 'pain001' } }),
      createMockRouteParams({ period: '2026-04' }),
    )

    expect(response.status).toBe(200)
    const xml = await response.text()
    expect(xml.match(/<DbtrAcct>[\s\S]*?<IBAN>([^<]+)<\/IBAN>/)?.[1]).toBe(IBAN_1930)
    expect(xml).not.toContain(IBAN_1931)
  })
})
