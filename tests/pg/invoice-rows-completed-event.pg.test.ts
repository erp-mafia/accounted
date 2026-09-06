import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool } from './setup'
import { seedCompany } from './fixtures'

// pg-real coverage for 20260906210100_invoice_rows_completed_event: the
// behandlingshistorik event lib/invoices/complete-invoice-rows.ts writes for
// every migrated invoice whose rows complete_invoice_rows filled (#2312).
// The type must be in the catalog (the append is best-effort, so an
// unregistered type is a silently lost record) and the invoice must be an
// admitted aggregate (the CHECK did not know 'Invoice' before).

describe('migration 20260906210100: InvoiceRowsCompleted event', () => {
  it('registers InvoiceRowsCompleted in the processing history catalog', async () => {
    const { rows } = await getPool().query(
      `SELECT event_type
       FROM public.processing_event_types
       WHERE event_type = 'InvoiceRowsCompleted'`,
    )

    expect(rows).toEqual([{ event_type: 'InvoiceRowsCompleted' }])
  })

  it('accepts the event on the Invoice aggregate, shaped the way the emitter writes it', async () => {
    const { companyId } = await seedCompany()
    const invoiceId = randomUUID()
    const runId = randomUUID()
    const { rows } = await getPool().query<{ aggregate_type: string; event_type: string }>(
      `INSERT INTO public.processing_history
         (company_id, correlation_id, aggregate_type, aggregate_id, event_type, payload, actor, occurred_at)
       VALUES ($1, $2, 'Invoice', $3, 'InvoiceRowsCompleted',
               $4::jsonb, '{"type":"cron","id":"complete-invoice-lines"}', now())
       RETURNING aggregate_type, event_type`,
      [
        companyId,
        runId,
        invoiceId,
        JSON.stringify({
          source: 'complete-invoice-lines',
          provider: 'fortnox',
          consent_id: randomUUID(),
          rows: 2,
          header_updated: true,
          header_before: { subtotal: 1250, vat_amount: 0, vat_rate: 25, vat_treatment: 'standard_25' },
          header_after: { subtotal: 1000, vat_amount: 250, vat_rate: 25, vat_treatment: 'standard_25' },
        }),
      ],
    )

    expect(rows).toEqual([{ aggregate_type: 'Invoice', event_type: 'InvoiceRowsCompleted' }])
  })

  it('still refuses an aggregate the constraint does not name: the CHECK was widened, not dropped', async () => {
    const { companyId } = await seedCompany()
    const id = randomUUID()
    await expect(
      getPool().query(
        `INSERT INTO public.processing_history
           (company_id, correlation_id, aggregate_type, aggregate_id, event_type, payload, actor, occurred_at)
         VALUES ($1, $2, 'Kitten', $2, 'InvoiceRowsCompleted', '{}'::jsonb,
                 '{"type":"system","id":"invoice-rows-completed-test"}', now())`,
        [companyId, id],
      ),
    ).rejects.toMatchObject({ code: '23514' })
  })
})
