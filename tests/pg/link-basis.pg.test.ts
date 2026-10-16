import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { LINK_BASES, resolveLinkBasis, type DoorLinkBasis } from '@/lib/links/link-basis'
import { getPool, runAsServiceRole, withUserContext } from './setup'
import { insertPostedJournalEntry, insertTransaction, seedCompany } from './fixtures'

/**
 * Covers 20261016160000_link_basis_columns,
 * 20261016160100_transactions_link_basis_follows_link,
 * 20261016160200_validate_link_basis_checks and
 * 20261016180100_resolve_link_basis.
 *
 * Six link tables gain nullable link_basis / link_evidence. The CHECKs hold
 * the vocabulary of src/lib/links/link-basis.ts and are validated; rows
 * written without a basis stay NULL. On transactions the basis describes the
 * current verifikat link only: it is cleared when journal_entry_id changes
 * without a new basis, and kept when the link moves between a verifikat and
 * its correction.
 *
 * resolve_link_basis is the SQL writers' twin of linkBasisColumns: the same
 * answer as resolveLinkBasis without a pending operation, for every door and
 * every actor, whether the actor is passed or read from gnubok.actor_type,
 * and it never raises. The writers that call it are covered in
 * link-basis-sql-writers.pg.test.ts.
 */

const LINK_TABLES = [
  'transactions',
  'transaction_voucher_links',
  'invoice_payments',
  'supplier_invoice_payments',
  'document_attachments',
  'account_reconciliation_settlements',
]

type Owner = Awaited<ReturnType<typeof seedCompany>>

/** A posted verifikat that books +1000 on 1930, optionally the correction of another. */
async function postedEntry(owner: Owner, correctionOf?: string): Promise<string> {
  if (!correctionOf) {
    return insertPostedJournalEntry({ ...owner, entryDate: '2026-06-01' })
  }
  const id = randomUUID()
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, status, correction_of_id)
       VALUES ($1, $2, $3, $4, 0, 'A', '2026-06-02', 'Rättelse', 'manual', 'draft', $5)`,
      [id, owner.userId, owner.companyId, owner.fiscalPeriodId, correctionOf],
    )
    await client.query(
      `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount, currency, sort_order)
       VALUES ($1, '1930', 1000, 0, 'SEK', 0), ($1, '3001', 0, 1000, 'SEK', 1)`,
      [id],
    )
    await client.query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [id])
    await client.query('COMMIT')
    return id
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

async function basisOf(transactionId: string): Promise<{ link_basis: string | null; link_evidence: unknown }> {
  const { rows } = await getPool().query(`SELECT link_basis, link_evidence FROM public.transactions WHERE id = $1`, [transactionId])
  return rows[0]
}

async function linkedTransaction(owner: Owner, entryId: string, basis = 'user_confirmed', evidence: unknown = { score: 0.9 }): Promise<string> {
  const tx = await insertTransaction({ ...owner, amount: 1000, date: '2026-06-01' })
  await getPool().query(
    `UPDATE public.transactions SET journal_entry_id = $2, link_basis = $3, link_evidence = $4::jsonb WHERE id = $1`,
    [tx, entryId, basis, evidence === null ? null : JSON.stringify(evidence)],
  )
  return tx
}

describe('link basis columns', () => {
  it('every link table has nullable link_basis text and link_evidence jsonb', async () => {
    const { rows } = await getPool().query<{ table_name: string; column_name: string; data_type: string; is_nullable: string }>(
      `SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name IN ('link_basis', 'link_evidence') AND table_name = ANY($1)
        ORDER BY table_name, column_name`,
      [LINK_TABLES],
    )
    expect(rows).toHaveLength(LINK_TABLES.length * 2)
    for (const r of rows) {
      expect(r.is_nullable, `${r.table_name}.${r.column_name}`).toBe('YES')
      expect(r.data_type).toBe(r.column_name === 'link_basis' ? 'text' : 'jsonb')
    }
  })

  it('the CHECKs are validated and hold exactly the vocabulary in code', async () => {
    const { rows } = await getPool().query<{ table_name: string; conname: string; convalidated: boolean; def: string }>(
      `SELECT c.conrelid::regclass::text AS table_name, c.conname, c.convalidated, pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c
        WHERE c.conname LIKE '%\\_link\\_basis\\_check' OR c.conname LIKE '%\\_link\\_evidence\\_check'`,
    )
    const byName = new Map(rows.map((r) => [r.conname, r]))
    for (const table of LINK_TABLES) {
      const basis = byName.get(`${table}_link_basis_check`)
      const evidence = byName.get(`${table}_link_evidence_check`)
      expect(basis?.convalidated, `${table} basis`).toBe(true)
      expect(evidence?.convalidated, `${table} evidence`).toBe(true)
      const values = [...(basis?.def ?? '').matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1])
      expect(values, table).toEqual([...LINK_BASES])
    }
  })

  it('refuses a basis outside the vocabulary, and evidence that is not a small object', async () => {
    const owner = await seedCompany()
    const tx = await insertTransaction({ ...owner })
    await expect(getPool().query(`UPDATE public.transactions SET link_basis = 'guessed' WHERE id = $1`, [tx])).rejects.toThrow(
      /transactions_link_basis_check/,
    )
    await expect(getPool().query(`UPDATE public.transactions SET link_evidence = '["x"]'::jsonb WHERE id = $1`, [tx])).rejects.toThrow(
      /transactions_link_evidence_check/,
    )
    await expect(
      getPool().query(`UPDATE public.transactions SET link_evidence = jsonb_build_object('reference', repeat('x', 2100)) WHERE id = $1`, [tx]),
    ).rejects.toThrow(/transactions_link_evidence_check/)
    for (const basis of LINK_BASES) {
      await getPool().query(`UPDATE public.transactions SET link_basis = $2 WHERE id = $1`, [tx, basis])
    }
  })

  it('a row written without a basis stays NULL: not recorded, never guessed', async () => {
    const owner = await seedCompany()
    const entry = await postedEntry(owner)
    const tx = await insertTransaction({ ...owner, amount: 1000, date: '2026-06-01' })
    await getPool().query(`UPDATE public.transactions SET journal_entry_id = $2 WHERE id = $1`, [tx, entry])
    expect(await basisOf(tx)).toEqual({ link_basis: null, link_evidence: null })
  })
})

describe('transactions: the basis follows the link it describes', () => {
  it('keeps the basis a link was stamped with, and an update of another column leaves it alone', async () => {
    const owner = await seedCompany()
    const entry = await postedEntry(owner)
    const tx = await linkedTransaction(owner, entry)
    expect(await basisOf(tx)).toEqual({ link_basis: 'user_confirmed', link_evidence: { score: 0.9 } })
    await getPool().query(`UPDATE public.transactions SET description = 'Ny text' WHERE id = $1`, [tx])
    expect((await basisOf(tx)).link_basis).toBe('user_confirmed')
  })

  it('clears the basis when the link is removed', async () => {
    const owner = await seedCompany()
    const entry = await postedEntry(owner)
    const tx = await linkedTransaction(owner, entry)
    await getPool().query(`UPDATE public.transactions SET journal_entry_id = NULL WHERE id = $1`, [tx])
    expect(await basisOf(tx)).toEqual({ link_basis: null, link_evidence: null })
  })

  it('clears the basis when the link moves to an unrelated verifikat without a new basis, keeps a new one', async () => {
    const owner = await seedCompany()
    const first = await postedEntry(owner)
    const other = await postedEntry(owner)
    const third = await postedEntry(owner)
    const tx = await linkedTransaction(owner, first)
    await getPool().query(`UPDATE public.transactions SET journal_entry_id = $2 WHERE id = $1`, [tx, other])
    expect(await basisOf(tx)).toEqual({ link_basis: null, link_evidence: null })

    await getPool().query(
      `UPDATE public.transactions SET journal_entry_id = $2, link_basis = 'rule_amount_date', link_evidence = '{"rule_id":"auto_exact"}'::jsonb WHERE id = $1`,
      [tx, third],
    )
    expect(await basisOf(tx)).toEqual({ link_basis: 'rule_amount_date', link_evidence: { rule_id: 'auto_exact' } })
  })

  it('keeps a basis the same UPDATE sets, even the value the row already had', async () => {
    // A person links the bank row to a verifikat, then matches it to an
    // invoice, which re-points it to the payment verifikat: user_confirmed twice.
    const owner = await seedCompany()
    const first = await postedEntry(owner)
    const payment = await postedEntry(owner)
    const tx = await linkedTransaction(owner, first, 'user_confirmed', null)
    await getPool().query(
      `UPDATE public.transactions SET journal_entry_id = $2, link_basis = 'user_confirmed', link_evidence = NULL WHERE id = $1`,
      [tx, payment],
    )
    expect(await basisOf(tx)).toEqual({ link_basis: 'user_confirmed', link_evidence: null })

    // A multi-row UPDATE notes each row on its own: the stamped row keeps its
    // basis, an unstamped re-point in the next statement clears.
    const other = await postedEntry(owner)
    const tx2 = await linkedTransaction(owner, first, 'rule_amount_date', { rule_id: 'auto_exact' })
    await getPool().query(
      `UPDATE public.transactions SET journal_entry_id = $2, link_basis = link_basis WHERE id = ANY($1::uuid[])`,
      [[tx, tx2], other],
    )
    expect((await basisOf(tx)).link_basis).toBe('user_confirmed')
    expect((await basisOf(tx2)).link_basis).toBe('rule_amount_date')
    await getPool().query(`UPDATE public.transactions SET journal_entry_id = $2 WHERE id = $1`, [tx2, first])
    expect(await basisOf(tx2)).toEqual({ link_basis: null, link_evidence: null })
  })

  it('keeps the basis when the link moves to the correction of its verifikat, and back', async () => {
    const owner = await seedCompany()
    const original = await postedEntry(owner)
    const correction = await postedEntry(owner, original)
    const tx = await linkedTransaction(owner, original, 'user_created', { pending_operation_id: randomUUID() })
    const before = await basisOf(tx)

    await getPool().query(`UPDATE public.transactions SET journal_entry_id = $2 WHERE id = $1`, [tx, correction])
    expect(await basisOf(tx)).toEqual(before)

    // delete_last_voucher points the row back at the original when it deletes the correction.
    await getPool().query(`UPDATE public.transactions SET journal_entry_id = $2 WHERE id = $1`, [tx, original])
    expect(await basisOf(tx)).toEqual(before)
  })

  it('runs for a member under RLS: the correction lookup sees the company verifikat', async () => {
    const owner = await seedCompany()
    const original = await postedEntry(owner)
    const correction = await postedEntry(owner, original)
    const unrelated = await postedEntry(owner)
    const tx = await linkedTransaction(owner, original, 'user_confirmed', null)

    const followed = await withUserContext(owner.userId, async (client) => {
      await client.query(`UPDATE public.transactions SET journal_entry_id = $2 WHERE id = $1`, [tx, correction])
      const { rows } = await client.query(`SELECT link_basis FROM public.transactions WHERE id = $1`, [tx])
      return rows[0]?.link_basis
    })
    expect(followed).toBe('user_confirmed')

    const cleared = await withUserContext(owner.userId, async (client) => {
      await client.query(`UPDATE public.transactions SET journal_entry_id = $2 WHERE id = $1`, [tx, unrelated])
      const { rows } = await client.query(`SELECT link_basis FROM public.transactions WHERE id = $1`, [tx])
      return rows[0]?.link_basis
    })
    expect(cleared).toBeNull()
  })
})

/** The bases a door may name itself (DoorLinkBasis); the other three come from the scope. */
const SCOPE_ONLY_BASES = ['agent_proposed_user_approved', 'agent_autonomous_within_grant', 'client_asserted']
const DOORS = LINK_BASES.filter((b) => !SCOPE_ONLY_BASES.includes(b)) as DoorLinkBasis[]
/** Every actor type a commit records, plus no actor, an empty one and garbage. */
const ACTORS: Array<string | undefined> = [
  undefined,
  '',
  'user',
  'api_key',
  'mcp_oauth',
  'service_account',
  'agent_chat',
  'cron',
  'system',
  'garbage',
  'API_KEY',
  ' cron',
]

/** What linkBasisColumns(door) answers outside an approval, on this actor. */
function tsBasis(door: DoorLinkBasis, actor: string | undefined): string {
  return resolveLinkBasis(door, undefined, { pendingOperationId: null, actorType: actor }).link_basis
}

describe('resolve_link_basis: the SQL twin of linkBasisColumns', () => {
  it('answers what resolveLinkBasis answers, for every door and actor, passed or read from gnubok.actor_type', async () => {
    const client = await getPool().connect()
    try {
      for (const door of DOORS) {
        for (const actor of ACTORS) {
          const expected = tsBasis(door, actor)
          const passed = await client.query<{ b: string | null }>(`SELECT public.resolve_link_basis($1, $2) AS b`, [door, actor ?? null])
          expect(passed.rows[0]?.b, `${door}, p_actor_type ${JSON.stringify(actor)}`).toBe(expected)

          await client.query('BEGIN')
          try {
            await client.query(`SELECT set_config('gnubok.actor_type', $1, true)`, [actor ?? ''])
            const read = await client.query<{ b: string | null }>(`SELECT public.resolve_link_basis($1) AS b`, [door])
            expect(read.rows[0]?.b, `${door}, gnubok.actor_type ${JSON.stringify(actor)}`).toBe(expected)
          } finally {
            await client.query('ROLLBACK')
          }
        }
      }
    } finally {
      client.release()
    }
  })

  it('a passed actor wins over the setting; an empty one falls back to it', async () => {
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('gnubok.actor_type', 'api_key', true)`)
      const { rows } = await client.query<{ person: string; empty: string; none: string }>(
        `SELECT public.resolve_link_basis('user_created', 'user') AS person,
                public.resolve_link_basis('user_created', '') AS empty,
                public.resolve_link_basis('user_created') AS none`,
      )
      expect(rows[0]).toEqual({ person: 'user_created', empty: 'client_asserted', none: 'client_asserted' })
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })

  it('never raises: NULL for a door outside the door vocabulary, the door for any setting', async () => {
    const { rows } = await getPool().query<{ b: string | null }>(
      `SELECT public.resolve_link_basis(d) AS b
         FROM unnest(ARRAY[NULL, '', 'guessed', 'client_asserted', 'agent_proposed_user_approved',
                           'agent_autonomous_within_grant', 'USER_CREATED']::text[]) AS d`,
    )
    expect(rows.map((r) => r.b)).toEqual([null, null, null, null, null, null, null])

    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('gnubok.actor_type', repeat('x', 5000) || E'\\n''; DROP TABLE x; --', true)`)
      const odd = await client.query<{ b: string }>(`SELECT public.resolve_link_basis('user_confirmed') AS b`)
      expect(odd.rows[0]?.b).toBe('user_confirmed')
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })

  it('runs for a member and for the service role, is not callable by anon, and is a plain STABLE invoker function', async () => {
    const owner = await seedCompany()
    const asMember = await withUserContext(owner.userId, async (client) => {
      const { rows } = await client.query<{ b: string }>(`SELECT public.resolve_link_basis('user_confirmed', 'mcp_oauth') AS b`)
      return rows[0]?.b
    })
    expect(asMember).toBe('client_asserted')
    const asService = await runAsServiceRole(async (client) => {
      const { rows } = await client.query<{ b: string }>(`SELECT public.resolve_link_basis('user_created', 'cron') AS b`)
      return rows[0]?.b
    })
    expect(asService).toBe('system_derived')

    const { rows } = await getPool().query(
      `SELECT has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
              has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role,
              EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS public_exec,
              p.prosecdef AS definer, p.provolatile AS volatility, p.proconfig AS config
         FROM pg_proc p
        WHERE p.oid = 'public.resolve_link_basis(text, text)'::regprocedure`,
    )
    expect(rows[0]).toEqual({
      anon: false,
      authenticated: true,
      service_role: true,
      public_exec: false,
      definer: false,
      volatility: 's',
      config: ['search_path=""'],
    })
  })
})
