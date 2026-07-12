import { describe, it, expect } from 'vitest'
import { getPool, withUserContext } from './setup'
import {
  seedCompany,
  insertDraftJournalEntry,
  insertBalancedLines,
} from './fixtures'

/**
 * Covers the Stripe integration migrations:
 *   20260712100000_stripe_connections
 *   20260712100200_invoice_stripe_payment_link
 *   20260712100300_stripe_payment_events
 *   20260712100400_stripe_payouts
 *   20260712100500_journal_source_type_stripe_payout
 *
 * Verified here (real Postgres, migrations replayed):
 *   1. source_type accepts 'stripe_payout' and still rejects unknown values,
 *      and exactly one source_type CHECK survives the constraint swap.
 *   2. stripe_connections RLS: members read + write their own company's rows,
 *      non-members see nothing.
 *   3. stripe_payment_events / stripe_payouts RLS: members can read, but the
 *      ledgers are service-role write-only (member INSERT is rejected).
 *   4. invoices.payment_link_auto defaults TRUE (the automation is opt-out).
 */

async function postWithSourceType(sourceType: string): Promise<string> {
  const { userId, companyId, fiscalPeriodId } = await seedCompany()
  const entryId = await insertDraftJournalEntry({ userId, companyId, fiscalPeriodId })
  await insertBalancedLines(entryId)
  await getPool().query(
    `UPDATE public.journal_entries SET source_type = $2 WHERE id = $1`,
    [entryId, sourceType],
  )
  return entryId
}

describe('journal_entries.source_type: stripe_payout', () => {
  it('accepts source_type=stripe_payout', async () => {
    const entryId = await postWithSourceType('stripe_payout')
    const { rows } = await getPool().query(
      `SELECT source_type FROM public.journal_entries WHERE id = $1`,
      [entryId],
    )
    expect(rows[0]).toEqual({ source_type: 'stripe_payout' })
  })

  it('still rejects values outside the CHECK list', async () => {
    await expect(postWithSourceType('paypal_payout')).rejects.toMatchObject({
      code: '23514', // check_violation
    })
  })

  it('exactly one source_type CHECK constraint exists, under the canonical name', async () => {
    const { rows } = await getPool().query(
      `SELECT conname
         FROM pg_constraint
        WHERE conrelid = 'public.journal_entries'::regclass
          AND conname LIKE '%source_type%'`,
    )
    expect(rows.map((r) => r.conname)).toEqual(['journal_entries_source_type_check'])
  })
})

describe('stripe_connections RLS', () => {
  it('a member can insert and read their company connection', async () => {
    const { userId, companyId } = await seedCompany()
    await withUserContext(userId, async (client) => {
      const inserted = await client.query(
        `INSERT INTO public.stripe_connections (company_id, user_id, status, oauth_state)
         VALUES ($1, $2, 'pending', gen_random_uuid()) RETURNING id`,
        [companyId, userId],
      )
      expect(inserted.rows).toHaveLength(1)

      const read = await client.query(
        `SELECT id, status FROM public.stripe_connections WHERE company_id = $1`,
        [companyId],
      )
      expect(read.rows).toHaveLength(1)
      expect(read.rows[0].status).toBe('pending')
    })
  })

  it('a non-member sees nothing and cannot insert for a foreign company', async () => {
    const { userId: ownerId, companyId } = await seedCompany()
    await getPool().query(
      `INSERT INTO public.stripe_connections (company_id, user_id, status)
       VALUES ($1, $2, 'active')`,
      [companyId, ownerId],
    )
    const { userId: outsiderId } = await seedCompany() // member of a DIFFERENT company

    await withUserContext(outsiderId, async (client) => {
      const read = await client.query(
        `SELECT id FROM public.stripe_connections WHERE company_id = $1`,
        [companyId],
      )
      expect(read.rows).toHaveLength(0)

      await expect(
        client.query(
          `INSERT INTO public.stripe_connections (company_id, user_id, status)
           VALUES ($1, $2, 'pending')`,
          [companyId, outsiderId],
        ),
      ).rejects.toThrow(/row-level security/i)
    })
  })

  it('only one ACTIVE connection per company is allowed', async () => {
    const { userId, companyId } = await seedCompany()
    await getPool().query(
      `INSERT INTO public.stripe_connections (company_id, user_id, status, stripe_account_id)
       VALUES ($1, $2, 'active', 'acct_pg_one')`,
      [companyId, userId],
    )
    await expect(
      getPool().query(
        `INSERT INTO public.stripe_connections (company_id, user_id, status, stripe_account_id)
         VALUES ($1, $2, 'active', 'acct_pg_two')`,
        [companyId, userId],
      ),
    ).rejects.toMatchObject({ code: '23505' }) // unique_violation
  })
})

describe('stripe event/payout ledgers: member-read, service-write', () => {
  it('members read their company rows but cannot insert', async () => {
    const { userId, companyId } = await seedCompany()
    const { rows: connRows } = await getPool().query(
      `INSERT INTO public.stripe_connections (company_id, user_id, status)
       VALUES ($1, $2, 'active') RETURNING id`,
      [companyId, userId],
    )
    const connectionId = connRows[0].id

    // Service role (pool) writes a ledger row in each table.
    await getPool().query(
      `INSERT INTO public.stripe_payment_events
         (company_id, connection_id, stripe_event_id, status, reason)
       VALUES ($1, $2, 'evt_pg_1', 'needs_review', 'amount_mismatch')`,
      [companyId, connectionId],
    )
    await getPool().query(
      `INSERT INTO public.stripe_payouts
         (company_id, connection_id, payout_id, status)
       VALUES ($1, $2, 'po_pg_1', 'booked')`,
      [companyId, connectionId],
    )

    await withUserContext(userId, async (client) => {
      const events = await client.query(
        `SELECT reason FROM public.stripe_payment_events WHERE company_id = $1`,
        [companyId],
      )
      expect(events.rows).toEqual([{ reason: 'amount_mismatch' }])

      const payouts = await client.query(
        `SELECT payout_id FROM public.stripe_payouts WHERE company_id = $1`,
        [companyId],
      )
      expect(payouts.rows).toEqual([{ payout_id: 'po_pg_1' }])

      // Writes are service-role only: no INSERT policy for authenticated.
      // One expected failure per context: an RLS rejection aborts the whole
      // transaction, so a second statement would only see "current
      // transaction is aborted" instead of the RLS error.
      await expect(
        client.query(
          `INSERT INTO public.stripe_payment_events
             (company_id, connection_id, stripe_event_id, status)
           VALUES ($1, $2, 'evt_pg_member', 'ignored')`,
          [companyId, connectionId],
        ),
      ).rejects.toThrow(/row-level security/i)
    })

    await withUserContext(userId, async (client) => {
      await expect(
        client.query(
          `INSERT INTO public.stripe_payouts (company_id, connection_id, payout_id, status)
           VALUES ($1, $2, 'po_pg_member', 'booked')`,
          [companyId, connectionId],
        ),
      ).rejects.toThrow(/row-level security/i)
    })
  })

  it('duplicate event and payout claims are rejected (idempotency keys)', async () => {
    const { userId, companyId } = await seedCompany()
    const { rows: connRows } = await getPool().query(
      `INSERT INTO public.stripe_connections (company_id, user_id, status)
       VALUES ($1, $2, 'active') RETURNING id`,
      [companyId, userId],
    )
    const connectionId = connRows[0].id

    await getPool().query(
      `INSERT INTO public.stripe_payment_events
         (company_id, connection_id, stripe_event_id, status)
       VALUES ($1, $2, 'evt_dup', 'processing')`,
      [companyId, connectionId],
    )
    await expect(
      getPool().query(
        `INSERT INTO public.stripe_payment_events
           (company_id, connection_id, stripe_event_id, status)
         VALUES ($1, $2, 'evt_dup', 'processing')`,
        [companyId, connectionId],
      ),
    ).rejects.toMatchObject({ code: '23505' })

    await getPool().query(
      `INSERT INTO public.stripe_payouts (company_id, connection_id, payout_id, status)
       VALUES ($1, $2, 'po_dup', 'processing')`,
      [companyId, connectionId],
    )
    await expect(
      getPool().query(
        `INSERT INTO public.stripe_payouts (company_id, connection_id, payout_id, status)
         VALUES ($1, $2, 'po_dup', 'processing')`,
        [companyId, connectionId],
      ),
    ).rejects.toMatchObject({ code: '23505' })
  })
})

describe('invoices.payment_link_auto', () => {
  it('defaults to TRUE (automation is opt-out)', async () => {
    const { userId, companyId } = await seedCompany()
    const { rows: customerRows } = await getPool().query(
      `INSERT INTO public.customers (company_id, user_id, name)
       VALUES ($1, $2, 'PG Test AB') RETURNING id`,
      [companyId, userId],
    )
    const { rows } = await getPool().query(
      `INSERT INTO public.invoices
         (company_id, user_id, customer_id, invoice_date, due_date, subtotal, vat_amount, total, status)
       VALUES ($1, $2, $3, '2026-07-01', '2026-07-31', 100, 25, 125, 'draft')
       RETURNING payment_link_auto, stripe_payment_link_id`,
      [companyId, userId, customerRows[0].id],
    )
    expect(rows[0]).toEqual({ payment_link_auto: true, stripe_payment_link_id: null })
  })
})
