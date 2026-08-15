import { describe, expect, it } from 'vitest'
import { seedCompany, insertTransaction } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'

/**
 * pg-real coverage for the payment_match_log action CHECK
 * (20260323120000_payment_match_log.sql +
 * 20260813210000_payment_match_log_linked_to_existing_voucher.sql).
 *
 * Locks in Gap F: the code has emitted action = 'linked_to_existing_voucher'
 * since the existing-voucher link paths shipped, but the original CHECK never
 * included the value, and because logMatchEvent is fire-and-forget the
 * constraint violation was swallowed: every existing-voucher link went
 * unlogged. This suite asserts the widened CHECK accepts the value, so a
 * future rewrite of the constraint that forgets it fails here instead of
 * silently reopening the audit-trail gap.
 */

async function insertLogRow(params: {
  userId: string
  transactionId: string
  action: string
}): Promise<void> {
  await getPool().query(
    `INSERT INTO public.payment_match_log (user_id, transaction_id, action)
     VALUES ($1, $2, $3)`,
    [params.userId, params.transactionId, params.action],
  )
}

describe('payment_match_log.action CHECK', () => {
  it('accepts every action the code emits, including linked_to_existing_voucher', async () => {
    const { userId, companyId } = await seedCompany()
    const txId = await insertTransaction({ companyId, userId })

    // The full MatchAction union from lib/invoices/match-log.ts. If a new
    // action is added there, this list (and the CHECK) must grow with it.
    const actions = [
      'matched',
      'unmatched',
      'auto_suggested',
      'suggestion_cleared',
      'storno_conflict_resolved',
      'linked_to_existing_voucher',
    ]
    for (const action of actions) {
      await expect(insertLogRow({ userId, transactionId: txId, action })).resolves.not.toThrow()
    }

    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM public.payment_match_log WHERE transaction_id = $1`,
      [txId],
    )
    expect(rows[0].n).toBe(actions.length)
  })

  it('still rejects unknown actions', async () => {
    const { userId, companyId } = await seedCompany()
    const txId = await insertTransaction({ companyId, userId })

    await expect(
      insertLogRow({ userId, transactionId: txId, action: 'not_a_real_action' }),
    ).rejects.toThrow(/payment_match_log_action_check/)
  })
})
