import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * The public reminder action endpoint feeds /invoice-action/[token], an
 * unauthenticated page that tells a customer what to pay. The statutory
 * påminnelseavgift (Lag 1981:739) is a krona amount booked 1510/3990 in SEK, so
 * it must never be relabelled as the invoice currency nor summed into a
 * foreign-currency total.
 */

let queued: { data: unknown; error: unknown } = { data: null, error: null }

vi.mock('@supabase/ssr', () => {
  const buildChain = (): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) => resolve(queued)
          }
          return () => buildChain()
        },
      },
    )

  return {
    createServerClient: vi.fn(() => ({
      from: vi.fn(() => buildChain()),
    })),
  }
})

const resolveBrandForCompanyMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/branding/resolve', () => ({
  resolveBrandForCompany: resolveBrandForCompanyMock,
}))

import { GET } from '../route'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

interface ActionPayload {
  currency: string
  total: number
  interestAmount: number
  reminderFee: number
  reminderFeeCurrency: string
  totalDue: number
  feeDueSeparately: number
  brand: { appName: string; logoUrl: string | null; brandColor: string } | null
}

function makeReminderRow(currency: string, total: number) {
  return {
    id: 'reminder-1',
    company_id: 'company-1',
    reminder_level: 1,
    sent_at: '2026-05-20T08:00:00Z',
    response_type: null,
    action_token_used: false,
    interest_amount: 10,
    interest_rate: 0.105,
    interest_from_date: '2026-05-01',
    interest_days: 30,
    reminder_fee: 60,
    invoice: {
      id: 'invoice-1',
      invoice_number: 'F2026011',
      invoice_date: '2026-04-15',
      due_date: '2026-05-01',
      total,
      currency,
      status: 'overdue',
      customer: { name: 'Erik Andersson' },
    },
  }
}

async function callGet() {
  const response = await GET(
    createMockRequest('/api/invoices/reminders/action', {
      searchParams: { token: 'tok-1' },
    }),
  )
  return parseJsonResponse<ActionPayload>(response)
}

describe('GET /api/invoices/reminders/action', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resolveBrandForCompanyMock.mockResolvedValue(null)
  })

  it('returns 400 without a token', async () => {
    queued = { data: null, error: null }
    const response = await GET(createMockRequest('/api/invoices/reminders/action'))
    expect(response.status).toBe(400)
  })

  it('returns 404 for an unknown token', async () => {
    queued = { data: null, error: { message: 'not found' } }
    const { status } = await callGet()
    expect(status).toBe(404)
  })

  it('folds the fee into the total for a SEK invoice (unchanged behaviour)', async () => {
    queued = { data: makeReminderRow('SEK', 10_000), error: null }
    const { status, body } = await callGet()

    expect(status).toBe(200)
    expect(body.currency).toBe('SEK')
    expect(body.reminderFee).toBe(60)
    expect(body.reminderFeeCurrency).toBe('SEK')
    expect(body.totalDue).toBe(10_070)
    expect(body.feeDueSeparately).toBe(0)
  })

  it('never sums the SEK fee into a EUR total', async () => {
    queued = { data: makeReminderRow('EUR', 1_000), error: null }
    const { status, body } = await callGet()

    expect(status).toBe(200)
    expect(body.currency).toBe('EUR')
    // 1000 EUR + 10 EUR interest. The 60 kr fee stays out of the EUR figure:
    // 1070 here would demand roughly 690 kr too much on a public page.
    expect(body.totalDue).toBe(1_010)
    expect(body.feeDueSeparately).toBe(60)
    expect(body.reminderFeeCurrency).toBe('SEK')
  })

  it('always reports the fee currency as SEK so the page cannot label 60 as EUR', async () => {
    queued = { data: makeReminderRow('USD', 500), error: null }
    const { body } = await callGet()

    expect(body.reminderFeeCurrency).toBe('SEK')
    expect(body.reminderFee).toBe(60)
    expect(body.totalDue).toBe(510)
  })

  it('returns the company brand for the public page when one exists (WL-13)', async () => {
    resolveBrandForCompanyMock.mockResolvedValue({
      appName: 'Siffra',
      logoUrl: 'https://cdn.example/siffra.png',
      brandColor: '#123456',
      domain: 'app.siffra.se',
    })
    queued = { data: makeReminderRow('SEK', 10_000), error: null }
    const { body } = await callGet()

    expect(resolveBrandForCompanyMock).toHaveBeenCalledWith('company-1')
    expect(body.brand).toEqual({
      appName: 'Siffra',
      logoUrl: 'https://cdn.example/siffra.png',
      brandColor: '#123456',
    })
  })

  it('returns brand: null for a brandless company (page unchanged)', async () => {
    queued = { data: makeReminderRow('SEK', 10_000), error: null }
    const { body } = await callGet()
    expect(body.brand).toBeNull()
  })
})
