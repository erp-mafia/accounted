import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingOperation } from '@/types'
import { createQueuedMockSupabase } from '@/tests/helpers'

// The payee write-through is its own unit (lib/cash-accounts/__tests__/invoice-payee.test.ts);
// here it must not consume the queued company_settings results.
vi.mock('@/lib/cash-accounts/invoice-payee', () => ({
  propagateLegacyPayeeWrite: vi.fn().mockResolvedValue(['SEK']),
}))

import { commitPendingOperation } from '../commit'

function makePendingOp(params: Record<string, unknown>): PendingOperation {
  return {
    id: 'op-settings-1',
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type: 'update_company_settings',
    status: 'pending',
    title: 'Update company settings',
    params,
    preview_data: {},
    result_data: null,
    actor_type: 'api_key',
    actor_id: 'key-1',
    actor_label: 'Test key',
    risk_level: 'medium',
    agent_metadata: null,
    rejection_category: null,
    rejection_reason: null,
    created_at: '2026-07-21T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-07-21T00:00:00Z',
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('commitPendingOperation: update_company_settings', () => {
  it('updates only validated settings for the selected company', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-settings-1' } })
    enqueue({
      data: {
        bank_name: 'Testbanken',
        clearing_number: '1234',
        account_number: '1234567',
        bankgiro: '5050-1055',
        plusgiro: null,
        swish: null,
        iban: null,
        bic: null,
        default_our_reference: 'Test Contact',
      },
    })
    enqueue({ data: null })

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({
        changes: {
          bank_name: 'Testbanken',
          bankgiro: '5050-1055',
          default_our_reference: 'Test Contact',
        },
      }),
    )

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({
      company_id: 'company-1',
      bankgiro: '5050-1055',
      contact_person: 'Test Contact',
    })
    expect(supabase.from).toHaveBeenNthCalledWith(2, 'company_settings')
  })

  it('updates contact details and invoice email texts', async () => {
    const emailTexts = {
      sv: { subject: 'Faktura {fakturanummer}', body: 'Tack for fortroendet.' },
      en: { greeting: 'Hi {förnamn},' },
    }
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-settings-1' } })
    enqueue({
      data: {
        bank_name: null,
        clearing_number: null,
        account_number: null,
        bankgiro: null,
        plusgiro: null,
        swish: null,
        iban: null,
        bic: null,
        default_our_reference: null,
        email: 'faktura@example.se',
        phone: '08-123 456 78',
        website: 'https://example.se',
        invoice_email_texts: emailTexts,
      },
    })
    enqueue({ data: null })

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({
        changes: {
          email: 'faktura@example.se',
          phone: '08-123 456 78',
          website: 'https://example.se',
          invoice_email_texts: emailTexts,
        },
      }),
    )

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({
      company_id: 'company-1',
      email: 'faktura@example.se',
      phone: '08-123 456 78',
      website: 'https://example.se',
      invoice_email_texts: emailTexts,
    })
    expect(supabase.from).toHaveBeenNthCalledWith(2, 'company_settings')
  })

  it('rejects an unknown invoice email placeholder at the commit boundary', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-settings-1' } })
    enqueue({ data: null })

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({
        changes: {
          invoice_email_texts: { sv: { body: 'Betala med OCR {ocr}.' } },
        },
      }),
    )

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.error).toMatch(/placeholder/i)
    expect(supabase.from).toHaveBeenCalledTimes(2)
  })

  it('rejects tampered staged fields at the commit boundary', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-settings-1' } })
    enqueue({ data: null })

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({
        changes: {
          company_id: 'other-company',
          bankgiro: '5050-1055',
        },
      }),
    )

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.error).toMatch(/unrecognized key/i)
    expect(supabase.from).toHaveBeenCalledTimes(2)
  })
})
