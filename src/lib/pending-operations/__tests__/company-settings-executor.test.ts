import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingOperation } from '@/types'
import { createQueuedMockSupabase } from '@/tests/helpers'

// The payee write-through is its own unit (lib/cash-accounts/__tests__/invoice-payee.test.ts);
// here it must not consume the queued company_settings results.
vi.mock('@/lib/cash-accounts/invoice-payee', () => ({
  propagateLegacyPayeeWrite: vi.fn().mockResolvedValue(['SEK']),
}))

import { commitPendingOperation } from '../commit'
import { propagateLegacyPayeeWrite } from '@/lib/cash-accounts/invoice-payee'

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

/**
 * update_company_settings is the settings.update operation's pending type
 * (src/lib/operations/company-settings.ts): approval runs the operation, which
 * runs lib/company/settings-service.ts. Rows staged by the old hand-written
 * tool carry `{ changes: {...} }` and still commit.
 */
const OWNER = { data: { role: 'owner' } }

describe('commitPendingOperation: update_company_settings', () => {
  it('commits a row staged in the legacy { changes } shape', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-settings-1' } }) // CAS claim
    enqueue({ data: { company_id: 'company-1', entity_type: 'aktiebolag' } }) // stored row
    enqueue(OWNER) // role check
    enqueue({
      data: {
        company_id: 'company-1',
        bank_name: 'Testbanken',
        bankgiro: '5050-1055',
        default_our_reference: 'Test Contact',
      },
    }) // update ... returning
    enqueue({ data: null, count: 5 }) // system deadlines exist: no self-heal
    enqueue({ data: null }) // finalize

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
    expect(findCall('company_settings', 'update')?.[0]).toEqual({
      bank_name: 'Testbanken',
      bankgiro: '5050-1055',
      default_our_reference: 'Test Contact',
    })
    expect(propagateLegacyPayeeWrite).toHaveBeenCalledTimes(1)
  })

  it('commits the flat operation input: contact details and invoice email texts', async () => {
    const emailTexts = {
      sv: { subject: 'Faktura {fakturanummer}', body: 'Tack for fortroendet.' },
      en: { greeting: 'Hi {förnamn},' },
    }
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-settings-1' } })
    enqueue({ data: { company_id: 'company-1' } })
    enqueue(OWNER)
    enqueue({
      data: {
        email: 'faktura@example.se',
        phone: '08-123 456 78',
        website: 'https://example.se',
        invoice_email_texts: emailTexts,
      },
    })
    enqueue({ data: null, count: 5 })
    enqueue({ data: null })

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({
        email: 'faktura@example.se',
        phone: '08-123 456 78',
        website: 'https://example.se',
        invoice_email_texts: emailTexts,
      }),
    )

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({
      company_id: 'company-1',
      email: 'faktura@example.se',
      invoice_email_texts: emailTexts,
    })
    // No payment field in the change: nothing written through to cash accounts.
    expect(propagateLegacyPayeeWrite).not.toHaveBeenCalled()
  })

  it('refuses, and keeps the row pending, when the approver is not an owner or admin', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-settings-1' } })
    enqueue({ data: { company_id: 'company-1' } })
    enqueue({ data: { role: 'member' } })
    enqueue({ data: null })

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({ phone: '08-1' }),
    )

    // A role refusal releases the claim: an owner or admin can still approve it.
    expect(result.status).toBe('failed')
    expect(result.code).toBe('FORBIDDEN')
    expect(result.http_status).toBe(403)
    expect(result.operation_status).toBe('pending')
    expect(findCall('company_settings', 'update')).toBeUndefined()
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
