/**
 * POST /items/bulk-book, Inkorgen's "Bokför valda": the door hands the
 * filed-momsperiod question to the batch core
 * (lib/transactions/categorize-core.ts, bulkBookMatchedInboxItems), with the
 * person's answer kept out of the booking. The core's holding and recording
 * are tested in lib/transactions/__tests__/categorize-core.bulk.test.ts, the
 * question itself in filed-vat-categorize.test.ts and its chain test; here
 * only the wiring.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const core = vi.hoisted(() => ({ bulkBookMatchedInboxItems: vi.fn() }))
vi.mock('@/lib/transactions/categorize-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/transactions/categorize-core')>()),
  bulkBookMatchedInboxItems: core.bulkBookMatchedInboxItems,
}))
const question = vi.hoisted(() => ({ filedPeriodCategorizeWarning: vi.fn() }))
vi.mock('@/lib/transactions/filed-vat-categorize', () => question)
const guard = vi.hoisted(() => ({ recordVoucherWarningsAcknowledged: vi.fn(), runVoucherWarningsGuard: vi.fn() }))
vi.mock('@/lib/bookkeeping/voucher-warnings-guard', () => guard)

import { invoiceInboxExtension } from '@/extensions/general/invoice-inbox'
import { createMockRequest, parseJsonResponse, testRoutes } from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'
import type { BulkBookInboxFiledVatQuestion } from '@/lib/transactions/categorize-core'

const route = testRoutes(invoiceInboxExtension).find((r) => r.method === 'POST' && r.path === '/items/bulk-book')!
const supabase = { marker: 'client' }
const ctx = {
  userId: 'user-1',
  companyId: 'company-1',
  extensionId: 'invoice-inbox',
  supabase,
  emit: vi.fn(),
  settings: { get: vi.fn(), set: vi.fn() },
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  services: {},
} as unknown as ExtensionContext

const ITEM = '11111111-1111-4111-8111-111111111111'
const WARNING = { code: 'VAT_PERIOD_ALREADY_FILED', message_sv: 'sv', message_en: 'en', details: {} }
const post = (body: Record<string, unknown>) =>
  route.handler(createMockRequest('/api/extensions/ext/invoice-inbox/items/bulk-book', { method: 'POST', body }), ctx)
/** The question the door handed the core on its latest call. */
const handed = () => (core.bulkBookMatchedInboxItems.mock.calls.at(-1)![4] as { filedVat: BulkBookInboxFiledVatQuestion }).filedVat

beforeEach(() => {
  vi.clearAllMocks()
  core.bulkBookMatchedInboxItems.mockResolvedValue({ booked: [], skipped: [] })
  question.filedPeriodCategorizeWarning.mockResolvedValue(WARNING)
})

describe('POST /items/bulk-book: the filed-momsperiod question', () => {
  it('hands the core the question, unconfirmed, and answers what the core held back', async () => {
    core.bulkBookMatchedInboxItems.mockResolvedValue({
      booked: [],
      skipped: [{ item_id: ITEM, reason: 'filed_vat_period', detail: 'sv', warning: WARNING }],
    })

    const { status, body } = await parseJsonResponse<{ data: { booked_count: number; skipped: unknown[] } }>(
      await post({ item_ids: [ITEM], category: 'expense_software' }),
    )

    expect(status).toBe(200)
    expect(body.data.booked_count).toBe(0)
    expect(body.data.skipped).toEqual([{ item_id: ITEM, reason: 'filed_vat_period', detail: 'sv', warning: WARNING }])
    expect(core.bulkBookMatchedInboxItems).toHaveBeenCalledWith(
      supabase,
      'user-1',
      'company-1',
      expect.objectContaining({ item_ids: [ITEM], category: 'expense_software' }),
      { filedVat: expect.objectContaining({ confirmed: false }) },
    )
  })

  it('hands the answer on as confirmed, and keeps the field out of the booking', async () => {
    await post({ item_ids: [ITEM], category: 'expense_software', confirm_filed_vat_period: true })

    expect(handed().confirmed).toBe(true)
    expect(core.bulkBookMatchedInboxItems.mock.calls[0][3]).not.toHaveProperty('confirm_filed_vat_period')
  })

  it('asks the categorize question with the booking options the core hands it, speaking of a booking', async () => {
    await post({ item_ids: [ITEM], category: 'expense_software' })
    const booking = { is_business: true, category: 'expense_software' } as never
    const options = { onBooked: 'refuse' as const, invoiceMatchIntercept: false, withoutReview: true }

    expect(await handed().ask('tx-1', booking, options)).toBe(WARNING)

    expect(question.filedPeriodCategorizeWarning).toHaveBeenCalledWith(
      supabase,
      'user-1',
      'company-1',
      'tx-1',
      booking,
      expect.objectContaining({ ...options, subject: 'booking', log: expect.anything() }),
    )
  })

  it('records a booking made past the warning on its verifikat, as this door', async () => {
    await post({ item_ids: [ITEM], category: 'expense_software', confirm_filed_vat_period: true })

    await handed().record('je-1', WARNING as never)

    expect(guard.recordVoucherWarningsAcknowledged).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: 'company-1',
        userId: 'user-1',
        journalEntryId: 'je-1',
        warnings: [WARNING],
        door: 'dashboard_inbox_bulk_book',
      }),
    )
  })
})
