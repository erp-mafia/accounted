import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from '@/tests/pg/setup'
import { insertBalancedLines, insertDraftJournalEntry, seedCompany } from '@/tests/pg/fixtures'

/**
 * Covers 20261016005000_inline_rattelse_actor: an inline rättelse records WHO
 * relayed it, beside the acting user's uuid.
 *   - journal_entry_rattelse_log.actor_type / actor_label are written from the
 *     new p_actor_type / p_actor_label parameters of correct_entry_metadata
 *     and correct_entry_lines_inline;
 *   - the audit rows of the same rättelse name the same actor (the
 *     transaction-local GUCs write_audit_log reads);
 *   - a caller that passes no actor (an older deploy) still works and records
 *     NULL, with the audit rows falling back to 'user' as before;
 *   - a type outside the committed_actor_type list is refused, nothing written;
 *   - one signature per function, grants as before.
 */

async function seedPosted() {
  const { companyId, userId, fiscalPeriodId } = await seedCompany()
  const entryId = await insertDraftJournalEntry({ userId, companyId, fiscalPeriodId })
  await insertBalancedLines(entryId)
  await getPool().query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [entryId])
  // The replacement line's account must be in the chart (the RPC's chart check).
  await getPool().query(
    `INSERT INTO public.chart_of_accounts
       (user_id, company_id, account_number, account_name, account_class, account_type, normal_balance)
     VALUES ($1, $2, '3002', 'Försäljning 12 %', 3, 'revenue', 'credit')
     ON CONFLICT DO NOTHING`,
    [userId, companyId],
  )
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT id FROM public.journal_entry_lines WHERE journal_entry_id = $1 AND account_number = '3001'`,
    [entryId],
  )
  return { companyId, userId, entryId, revenueLineId: rows[0].id }
}

/** The struck 3001 credit, replaced by the same amount on 3002. */
const REPLACEMENT = JSON.stringify([{ account_number: '3002', debit_amount: 0, credit_amount: 1000 }])

async function logRows(entryId: string) {
  const { rows } = await getPool().query(
    `SELECT rattelse_type, actor, actor_type, actor_label
       FROM public.journal_entry_rattelse_log WHERE journal_entry_id = $1 ORDER BY created_at`,
    [entryId],
  )
  return rows
}

describe('correct_entry_metadata: actor on the rättelse log', () => {
  it('writes actor_type and actor_label, and the audit UPDATE row names the same actor', async () => {
    const { companyId, userId, entryId } = await seedPosted()

    await getPool().query(
      `SELECT public.correct_entry_metadata(
         p_company_id => $1::uuid, p_entry_id => $2::uuid, p_description => 'Rättad text',
         p_user_id => $3::uuid, p_actor_type => 'api_key', p_actor_label => 'Bokföringsagent')`,
      [companyId, entryId, userId],
    )

    expect(await logRows(entryId)).toEqual([
      { rattelse_type: 'metadata', actor: userId, actor_type: 'api_key', actor_label: 'Bokföringsagent' },
    ])
    const { rows: audit } = await getPool().query(
      `SELECT actor_type, actor_label FROM public.audit_log
        WHERE record_id = $1 AND table_name = 'journal_entries' AND action = 'UPDATE'`,
      [entryId],
    )
    expect(audit).toEqual([{ actor_type: 'api_key', actor_label: 'Bokföringsagent' }])
  })

  it('records the actor for a JWT caller too (the cookie-session door)', async () => {
    const { companyId, userId, entryId } = await seedPosted()

    await withUserContext(userId, async (client) => {
      await client.query(
        `SELECT public.correct_entry_metadata(
           p_company_id => $1::uuid, p_entry_id => $2::uuid, p_description => 'Rättad i appen',
           p_actor_type => 'user', p_actor_label => NULL)`,
        [companyId, entryId],
      )
      const { rows } = await client.query(
        `SELECT actor, actor_type, actor_label FROM public.journal_entry_rattelse_log WHERE journal_entry_id = $1`,
        [entryId],
      )
      expect(rows).toEqual([{ actor: userId, actor_type: 'user', actor_label: null }])
    })
  })

  it('keeps working for a caller that passes no actor: NULL on the log, audit falls back to user', async () => {
    const { companyId, userId, entryId } = await seedPosted()

    // The five-argument positional shape an older deploy sends.
    await getPool().query(`SELECT public.correct_entry_metadata($1::uuid, $2::uuid, 'Gammal anropsform', NULL, $3::uuid)`, [
      companyId,
      entryId,
      userId,
    ])

    expect(await logRows(entryId)).toEqual([
      { rattelse_type: 'metadata', actor: userId, actor_type: null, actor_label: null },
    ])
    const { rows: audit } = await getPool().query(
      `SELECT actor_type, actor_label FROM public.audit_log
        WHERE record_id = $1 AND table_name = 'journal_entries' AND action = 'UPDATE'`,
      [entryId],
    )
    expect(audit).toEqual([{ actor_type: 'user', actor_label: null }])
  })

  it('refuses an actor type outside the committed_actor_type list and writes nothing', async () => {
    const { companyId, userId, entryId } = await seedPosted()

    await expect(
      getPool().query(
        `SELECT public.correct_entry_metadata(
           p_company_id => $1::uuid, p_entry_id => $2::uuid, p_description => 'X',
           p_user_id => $3::uuid, p_actor_type => 'robot')`,
        [companyId, entryId, userId],
      ),
    ).rejects.toThrow(/actor_type_check/)

    expect(await logRows(entryId)).toEqual([])
    const { rows } = await getPool().query(`SELECT description FROM public.journal_entries WHERE id = $1`, [entryId])
    expect(rows[0].description).not.toBe('X')
  })
})

describe('correct_entry_lines_inline: actor on the rättelse log', () => {
  it('writes actor_type and actor_label, and the audit rows of the struck and added lines name the same actor', async () => {
    const { companyId, userId, entryId, revenueLineId } = await seedPosted()

    const { rows } = await getPool().query<{ result: { log_id: string } }>(
      `SELECT public.correct_entry_lines_inline(
         p_company_id => $1::uuid, p_entry_id => $2::uuid, p_strike_line_ids => ARRAY[$3::uuid],
         p_new_lines => $4::jsonb, p_user_id => $5::uuid,
         p_actor_type => 'mcp_oauth', p_actor_label => 'Claude') AS result`,
      [companyId, entryId, revenueLineId, REPLACEMENT, userId],
    )
    expect(rows[0].result.log_id).toBeTruthy()

    expect(await logRows(entryId)).toEqual([
      { rattelse_type: 'lines', actor: userId, actor_type: 'mcp_oauth', actor_label: 'Claude' },
    ])
    // The struck line's DELETE row and the replacement line's INSERT row.
    const { rows: audit } = await getPool().query(
      `SELECT action, actor_type, actor_label FROM public.audit_log
        WHERE table_name = 'journal_entry_lines'
          AND ((action = 'DELETE' AND record_id = $1)
            OR (action = 'INSERT' AND new_state->>'journal_entry_id' = $2 AND new_state->>'account_number' = '3002'))
        ORDER BY action`,
      [revenueLineId, entryId],
    )
    expect(audit).toEqual([
      { action: 'DELETE', actor_type: 'mcp_oauth', actor_label: 'Claude' },
      { action: 'INSERT', actor_type: 'mcp_oauth', actor_label: 'Claude' },
    ])
  })

  it('keeps working for a caller that passes no actor', async () => {
    const { companyId, userId, entryId, revenueLineId } = await seedPosted()

    await getPool().query(
      `SELECT public.correct_entry_lines_inline($1::uuid, $2::uuid, ARRAY[$3::uuid], $4::jsonb, $5::uuid)`,
      [companyId, entryId, revenueLineId, REPLACEMENT, userId],
    )

    expect(await logRows(entryId)).toEqual([
      { rattelse_type: 'lines', actor: userId, actor_type: null, actor_label: null },
    ])
  })

  it('never leaks the actor into a later transaction on the same connection', async () => {
    const { companyId, userId, entryId, revenueLineId } = await seedPosted()
    const client = await getPool().connect()
    try {
      await client.query(
        `SELECT public.correct_entry_lines_inline(
           p_company_id => $1::uuid, p_entry_id => $2::uuid, p_strike_line_ids => ARRAY[$3::uuid],
           p_new_lines => $4::jsonb, p_user_id => $5::uuid, p_actor_type => 'cron', p_actor_label => 'cron.test')`,
        [companyId, entryId, revenueLineId, REPLACEMENT, userId],
      )
      const { rows } = await client.query(
        `SELECT coalesce(current_setting('gnubok.actor_type', true), '') AS t,
                coalesce(current_setting('gnubok.actor_label', true), '') AS l`,
      )
      expect(rows[0]).toEqual({ t: '', l: '' })
    } finally {
      client.release()
    }
  })
})

describe('signatures and grants', () => {
  it.each(['correct_entry_metadata', 'correct_entry_lines_inline'])(
    '%s has exactly one signature, executable by authenticated and service_role only',
    async (name) => {
      const { rows } = await getPool().query<{ sig: string; anon: boolean; authenticated: boolean; service_role: boolean; public_exec: boolean }>(
        `SELECT p.oid::regprocedure::text AS sig,
                has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
                has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role,
                EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS public_exec
           FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = $1`,
        [name],
      )
      expect(rows).toHaveLength(1)
      expect(rows[0].sig).toMatch(/,text,text\)$/)
      expect(rows[0]).toMatchObject({ anon: false, authenticated: true, service_role: true, public_exec: false })
    },
  )
})
