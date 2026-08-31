import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool } from './setup'
import { seedCompany } from './fixtures'

describe('migration 20260828154800: InboxUnderlagReconciled event type', () => {
  it('registers InboxUnderlagReconciled in the processing history catalog', async () => {
    // reconcileStrandedInboxUnderlag() swallows an append failure (the
    // repair is already done), so an unregistered type would be invisible
    // outside the logs: this is what happened to the script's previous
    // 'InboxUnderlagBackfilled' type.
    const { rows } = await getPool().query(
      `SELECT event_type
       FROM public.processing_event_types
       WHERE event_type = 'InboxUnderlagReconciled'`,
    )

    expect(rows).toEqual([{ event_type: 'InboxUnderlagReconciled' }])
  })

  it('accepts an InboxUnderlagReconciled row through the event_type FK', async () => {
    const { companyId } = await seedCompany()
    const txId = randomUUID()
    const { rows } = await getPool().query<{ event_type: string }>(
      `INSERT INTO public.processing_history
         (company_id, correlation_id, aggregate_type, aggregate_id, event_type, payload, actor, occurred_at)
       VALUES ($1, $2, 'BankTransaction', $2, 'InboxUnderlagReconciled',
               $3::jsonb, '{"type":"system","id":"inbox-underlag-reconcile"}', now())
       RETURNING event_type`,
      [
        companyId,
        txId,
        JSON.stringify({ transaction_id: txId, inbox_item_ids: [], source: 'inbox-underlag-reconcile' }),
      ],
    )

    expect(rows).toEqual([{ event_type: 'InboxUnderlagReconciled' }])
  })
})
