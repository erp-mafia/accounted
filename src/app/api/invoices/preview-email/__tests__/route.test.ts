import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createMockRequest,
  createMockRouteParams,
  createQueuedMockSupabase,
  makeCompanySettings,
  makeCustomer,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
const requireAuthMock = vi.fn()
const resolveInvoiceSenderMock = vi.fn()

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

// The sender lookup reads company_sending_domains and the entitlements; its
// own tests live in lib/email/__tests__.
vi.mock('@/lib/email/invoice-sender', () => ({
  resolveInvoiceSender: (...args: unknown[]) => resolveInvoiceSenderMock(...args),
}))

vi.mock('@/lib/currency/riksbanken', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/currency/riksbanken')>()),
  fetchExchangeRate: vi.fn().mockResolvedValue(null),
}))

import { POST } from '../route'

const CUSTOMER_ID = '6f1c2a3e-0000-4000-8000-000000000011'

interface EmailPreview {
  subject: string
  html: string
  editable: { subject: string; body: string }
  from: { name: string; address: string | null }
  reply_to: string | null
  to: string[]
  cc: string[]
  missing: string[]
}

function previewRequest(body: unknown) {
  return POST(
    createMockRequest('/api/invoices/preview-email', { method: 'POST', body }),
    createMockRouteParams({}),
  )
}

describe('POST /api/invoices/preview-email', () => {
  const user = { id: 'user-1', email: 'owner@example.test' }
  const customer = makeCustomer({
    id: CUSTOMER_ID,
    name: 'Nordljus Arkitekter AB',
    contact_person: 'Karin Ek',
    email: 'faktura@nordljus.test',
    invoice_email_cc_addresses: ['ekonomi@nordljus.test'],
  })
  const company = makeCompanySettings({
    company_name: 'Ekholm Konsult AB',
    bankgiro: '5050-1055',
    invoice_email_cc_addresses: ['arkiv@ekholm.test'],
    invoice_email_reply_to: 'anna@ekholm.test',
  })
  const draft = {
    customer_id: CUSTOMER_ID,
    invoice_number: '1043',
    invoice_date: '2026-10-02',
    due_date: '2026-11-01',
    currency: 'SEK',
    items: [{ description: 'Workshop', quantity: 1, unit: 'st', unit_price: 8000, vat_rate: 25 }],
  }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user, supabase: mockSupabase, error: null })
    resolveInvoiceSenderMock.mockResolvedValue(undefined)
  })

  it('returns 401 when the caller is not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await previewRequest(draft)

    expect(response.status).toBe(401)
  })

  it.each([
    ['a subject over 200 characters', { ...draft, email_subject: 'x'.repeat(201) }],
    ['a message over 5000 characters', { ...draft, email_body: 'x'.repeat(5001) }],
    ['a malformed row', { ...draft, items: [{ ...draft.items[0], unit_price: '8000' }] }],
  ])('returns 400 for %s, before reading anything', async (_label, body) => {
    const response = await previewRequest(body)

    expect(response.status).toBe(400)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mockSupabase.from).not.toHaveBeenCalled()
  })

  it('returns 404 when the customer does not exist', async () => {
    enqueue({ data: company, error: null })
    enqueue({ data: null, error: { message: 'not found' } })

    const response = await previewRequest(draft)
    const body = await response.json()

    expect(response.status).toBe(404)
    expect(body.error.code).toBe('INVOICE_CUSTOMER_NOT_FOUND')
  })

  it('renders the email the draft would be sent with: texts, amount and recipients', async () => {
    enqueue({ data: company, error: null })
    enqueue({ data: customer, error: null })

    const response = await previewRequest(draft)
    const body = await response.json() as { data: EmailPreview }

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(body.data.subject).toBe('Faktura 1043 från Ekholm Konsult AB')
    expect(body.data.html).toContain('Hej Karin,')
    expect(body.data.html).toContain('Tack för ditt förtroende! Bifogat hittar du din faktura.')
    // The same "Att betala" as the PDF preview: 8 000 + 25 % moms.
    expect(body.data.html).toMatch(/10[\s ]000,00 SEK/)
    expect(body.data.html).toContain('5050-1055')
    expect(body.data).toMatchObject({
      from: { name: 'Ekholm Konsult AB', address: null },
      reply_to: 'anna@ekholm.test',
      to: ['faktura@nordljus.test'],
      cc: ['arkiv@ekholm.test', 'ekonomi@nordljus.test'],
      missing: [],
    })
    // The texts to edit keep their placeholders: the send fills in the number it allocates.
    expect(body.data.editable).toEqual({
      subject: 'Faktura {fakturanummer} från {företag}',
      body: 'Tack för ditt förtroende! Bifogat hittar du din faktura.',
    })
  })

  it('uses this send\'s own subject and message, with the placeholders filled in', async () => {
    enqueue({ data: company, error: null })
    enqueue({ data: customer, error: null })

    const response = await previewRequest({
      ...draft,
      email_subject: 'Faktura {fakturanummer}, {belopp}',
      email_body: 'Hej igen!\nHär är fakturan för workshopen <3',
    })
    const body = await response.json() as { data: EmailPreview }

    expect(response.status).toBe(200)
    expect(body.data.subject).toMatch(/^Faktura 1043, 10[\s ]000,00 SEK$/)
    // User text is escaped, and its line breaks kept.
    expect(body.data.html).toContain('Hej igen!<br>Här är fakturan för workshopen &lt;3')
    expect(body.data.html).not.toContain('Tack för ditt förtroende!')
    expect(body.data.editable).toEqual({
      subject: 'Faktura {fakturanummer}, {belopp}',
      body: 'Hej igen!\nHär är fakturan för workshopen <3',
    })
  })

  it('writes in the customer\'s language', async () => {
    enqueue({ data: company, error: null })
    enqueue({ data: { ...customer, language: 'en' }, error: null })

    const response = await previewRequest(draft)
    const body = await response.json() as { data: EmailPreview }

    expect(body.data.subject).toBe('Invoice 1043 from Ekholm Konsult AB')
    expect(body.data.html).toContain('Hi Karin,')
  })

  it('names the company\'s own sending domain as the sender', async () => {
    enqueue({ data: company, error: null })
    enqueue({ data: customer, error: null })
    resolveInvoiceSenderMock.mockResolvedValue({ name: 'Ekholm Konsult', address: 'faktura@ekholm.test' })

    const response = await previewRequest(draft)
    const body = await response.json() as { data: EmailPreview }

    expect(body.data.from).toEqual({ name: 'Ekholm Konsult', address: 'faktura@ekholm.test' })
  })

  it('previews a draft without a customer: no recipient, and the customer reported missing', async () => {
    enqueue({ data: { ...company, invoice_email_reply_to: null }, error: null })

    const response = await previewRequest({ ...draft, customer_id: null })
    const body = await response.json() as { data: EmailPreview }

    expect(response.status).toBe(200)
    expect(body.data.to).toEqual([])
    expect(body.data.cc).toEqual(['arkiv@ekholm.test'])
    expect(body.data.missing).toEqual(['customer'])
    // No configured reply address: the sending user's.
    expect(body.data.reply_to).toBe('owner@example.test')
  })
})
