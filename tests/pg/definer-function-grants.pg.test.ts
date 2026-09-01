import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { getClient, getPool, runAsServiceRole, withUserContext } from '@/tests/pg/setup'
import { seedCompany } from '@/tests/pg/fixtures'

// Ratchet for 20260901100000_revoke_anon_execute_on_definer_writes.sql.
//
// Supabase's bootstrap grants EXECUTE on every new public function to PUBLIC,
// anon, authenticated and service_role, and PostgREST publishes each of them as
// POST /rest/v1/rpc/<name>. A SECURITY DEFINER function that writes and that
// anon can execute is therefore an unauthenticated cross-tenant write, whether
// or not it carries an in-body guard: the anon key's JWT has no `sub` claim, so
// auth.uid() is NULL and any "NULL is trusted" guard waves it straight through.
// That is exactly how generate_invoice_number, peek_next_invoice_number and
// get_next_arrival_number were wrongly classified as safe.
//
// The first test is generated from a sweep rather than a hand list, so the next
// unguarded function that ships fails CI instead of being declared safe by
// whoever writes the list.
//
// prokind = 'f' keeps procedures out of scope: the migration revokes with
// REVOKE ... ON FUNCTION, which rejects a procedure, so a SECURITY DEFINER
// procedure must not be reported here as an offender the migration can fix.
const DEFINER_WRITERS_SQL = `
  SELECT p.oid::regprocedure::text AS fn,
         has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prosecdef
     AND p.prokind = 'f'
     AND p.prorettype <> 'trigger'::regtype
     AND (p.prosrc ~* '\\minsert\\s+into\\s'
          OR p.prosrc ~* '\\mupdate\\s+[a-z_"]'
          OR p.prosrc ~* '\\mdelete\\s+from\\s')
   ORDER BY 1
`

// SECURITY DEFINER writers deliberately left callable by anon. There are none,
// and there is no good reason for one to exist: an unauthenticated caller has
// no tenant, so a definer write on its behalf is a cross-tenant write. If a
// function ever genuinely belongs here, add it with the call site that needs it
// and the reason the write cannot be attributed to a session.
const ANON_CALLABLE_ALLOWLIST: string[] = []

// No user-session caller: revoked from authenticated as well. A forgotten
// PUBLIC in the REVOKE is the standard failure mode (anon is a member of
// PUBLIC), so both roles are asserted explicitly.
const SERVICE_ROLE_ONLY = [
  'sync_team_to_company(uuid,uuid)',
  'claim_due_webhook_deliveries(integer,timestamp with time zone)',
]

// Called on the user's session client by the app, so authenticated keeps
// EXECUTE and the in-body membership guard carries the tenant check. For these
// the REVOKE stops the anon key only: the guard is what stops a signed-in
// caller from reaching another tenant, which is why every one of them is
// exercised below with a real non-member session.
const AUTHENTICATED_GUARDED_WRITERS = [
  'generate_invoice_number(uuid,uuid,text)',
  'peek_next_invoice_number(uuid,text)',
  'get_next_arrival_number(uuid)',
  'generate_delivery_note_number(uuid)',
  'generate_article_number(uuid,uuid)',
  'check_and_increment_inbox_quota(uuid,integer,integer)',
]

interface GrantRow {
  exists: boolean
  anon_can: boolean | null
  auth_can: boolean | null
  service_can: boolean | null
}

// Resolve through to_regprocedure() so a signature that drifted out of the
// schema fails on `exists` instead of silently returning NULL privileges.
async function grantsFor(signature: string): Promise<GrantRow> {
  const { rows } = await getPool().query<GrantRow>(
    `SELECT to_regprocedure($1) IS NOT NULL AS exists,
            has_function_privilege('anon', to_regprocedure($1)::oid, 'EXECUTE') AS anon_can,
            has_function_privilege('authenticated', to_regprocedure($1)::oid, 'EXECUTE') AS auth_can,
            has_function_privilege('service_role', to_regprocedure($1)::oid, 'EXECUTE') AS service_can`,
    [`public.${signature}`],
  )
  return rows[0]!
}

// Run `fn` with the presentation an anon-key request gets from PostgREST: a
// role claim of 'anon' and NO `sub` claim, so auth.uid() is NULL. Both GUC
// styles are set for the reason runAsServiceRole() sets both (the CI image
// ships the legacy auth shim, which reads only request.jwt.claim.*).
//
// The connection stays superuser, which is the point: EXECUTE is already
// revoked, so this isolates the in-body guard and proves it fails closed on
// its own rather than leaning on the grant.
async function withAnonClaims<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('request.jwt.claims', '{"role":"anon"}', true)`)
    await client.query(`SELECT set_config('request.jwt.claim.role', 'anon', true)`)
    const check = await client.query<{ uid: string | null; role: string | null }>(
      `SELECT auth.uid()::text AS uid, auth.role()::text AS role`,
    )
    if (check.rows[0]?.uid !== null || check.rows[0]?.role !== 'anon') {
      throw new Error(
        `withAnonClaims: auth.uid()=${check.rows[0]?.uid ?? 'NULL'}, ` +
          `auth.role()=${check.rows[0]?.role ?? 'NULL'}; expected NULL/anon.`,
      )
    }
    return await fn(client)
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
}

describe('SECURITY DEFINER function grants.pg', () => {
  it('leaves no SECURITY DEFINER writer in public executable by anon', async () => {
    const { rows } = await getPool().query<{ fn: string; anon_can: boolean }>(
      DEFINER_WRITERS_SQL,
    )

    // Sanity: the sweep has to actually match functions, otherwise an empty
    // offender list proves nothing about the schema.
    expect(rows.length).toBeGreaterThan(10)

    const offenders = rows
      .filter((r) => r.anon_can)
      .map((r) => r.fn)
      .filter((fn) => !ANON_CALLABLE_ALLOWLIST.includes(fn))

    // If this fails, the named function was created without a REVOKE. Add
    // `REVOKE EXECUTE ON FUNCTION <sig> FROM PUBLIC, anon;` to the migration
    // that created it (PUBLIC included: revoking anon alone is a no-op).
    expect(offenders).toEqual([])
  })

  it.each(SERVICE_ROLE_ONLY)('%s is unreachable for anon and authenticated', async (sig) => {
    const grants = await grantsFor(sig)
    expect(grants.exists).toBe(true)
    expect(grants.anon_can).toBe(false)
    expect(grants.auth_can).toBe(false)
    expect(grants.service_can).toBe(true)
  })

  it.each(AUTHENTICATED_GUARDED_WRITERS)(
    '%s keeps authenticated and service_role but not anon',
    async (sig) => {
      const grants = await grantsFor(sig)
      expect(grants.exists).toBe(true)
      expect(grants.anon_can).toBe(false)
      expect(grants.auth_can).toBe(true)
      expect(grants.service_can).toBe(true)
    },
  )
})

describe('numbering RPC guards: fail closed for an anon-shaped caller.pg', () => {
  it('refuses every numbering RPC when the JWT has a role but no sub', async () => {
    const { userId, companyId } = await seedCompany()
    await getPool().query(
      `INSERT INTO public.company_settings (user_id, company_id, invoice_prefix, next_invoice_number)
       VALUES ($1, $2, 'F', 1)
       ON CONFLICT (company_id) DO NOTHING`,
      [userId, companyId],
    )
    const articleId = randomUUID()
    await getPool().query(
      `INSERT INTO public.articles (id, company_id, user_id, name) VALUES ($1, $2, $3, 'Konsulttimme')`,
      [articleId, companyId, userId],
    )
    const customerId = randomUUID()
    await getPool().query(
      `INSERT INTO public.customers (id, user_id, company_id, name) VALUES ($1, $2, $3, 'Test Customer')`,
      [customerId, userId, companyId],
    )
    const invoiceId = randomUUID()
    await getPool().query(
      `INSERT INTO public.invoices
         (id, user_id, company_id, customer_id, invoice_number, document_type,
          invoice_date, due_date, currency, subtotal, vat_amount, total,
          vat_treatment, vat_rate, moms_ruta, status)
       VALUES ($1, $2, $3, $4, NULL, 'invoice',
               '2026-09-01', '2026-10-01', 'SEK', 1000, 250, 1250,
               'standard_25', 25, '10', 'draft')`,
      [invoiceId, userId, companyId, customerId],
    )

    await withAnonClaims(async (client) => {
      await expect(
        client.query('SELECT public.peek_next_invoice_number($1, $2)', [companyId, 'invoice']),
      ).rejects.toThrow(/unauthorized/i)
    })

    await withAnonClaims(async (client) => {
      await expect(
        client.query('SELECT public.generate_invoice_number($1, $2, $3)', [
          companyId,
          invoiceId,
          'invoice',
        ]),
      ).rejects.toThrow(/unauthorized/i)
    })

    await withAnonClaims(async (client) => {
      await expect(
        client.query('SELECT public.get_next_arrival_number($1)', [companyId]),
      ).rejects.toThrow(/unauthorized/i)
    })

    await withAnonClaims(async (client) => {
      await expect(
        client.query('SELECT public.generate_delivery_note_number($1)', [companyId]),
      ).rejects.toThrow(/unauthorized/i)
    })

    await withAnonClaims(async (client) => {
      await expect(
        client.query('SELECT public.generate_article_number($1, $2)', [companyId, articleId]),
      ).rejects.toThrow(/unauthorized/i)
    })

    // The invoice must come back unnumbered: the refusal has to land before
    // the two UPDATEs, not after one of them.
    const { rows } = await getPool().query<{ invoice_number: string | null }>(
      `SELECT invoice_number FROM public.invoices WHERE id = $1`,
      [invoiceId],
    )
    expect(rows[0]!.invoice_number).toBeNull()
  })

  it('leaves the delivery-note and article counters untouched after a refusal', async () => {
    const { userId, companyId } = await seedCompany()
    await getPool().query(
      `INSERT INTO public.company_settings (user_id, company_id) VALUES ($1, $2)
       ON CONFLICT (company_id) DO NOTHING`,
      [userId, companyId],
    )

    await withAnonClaims(async (client) => {
      await expect(
        client.query('SELECT public.generate_delivery_note_number($1)', [companyId]),
      ).rejects.toThrow(/unauthorized/i)
    })

    const { rows } = await getPool().query<{
      next_delivery_note_number: number
      next_article_number: number
    }>(
      `SELECT next_delivery_note_number, next_article_number
         FROM public.company_settings WHERE company_id = $1`,
      [companyId],
    )
    expect(rows[0]!.next_delivery_note_number).toBe(1)
    expect(rows[0]!.next_article_number).toBe(1)
  })

  it('still trusts a direct database connection with no JWT at all', async () => {
    // Service-role, cron and pg-real seed paths reach these functions without a
    // JWT. They stay trusted: tightening the guard must not break the numbering
    // that runs from the API-key and MCP surfaces.
    const { userId, companyId } = await seedCompany()
    await getPool().query(
      `INSERT INTO public.company_settings (user_id, company_id, invoice_prefix, next_invoice_number)
       VALUES ($1, $2, 'F', 1)
       ON CONFLICT (company_id) DO NOTHING`,
      [userId, companyId],
    )

    const peek = await getPool().query<{ peek_next_invoice_number: string }>(
      'SELECT public.peek_next_invoice_number($1, $2)',
      [companyId, 'invoice'],
    )
    expect(peek.rows[0]!.peek_next_invoice_number).toBe('F001')

    const arrival = await getPool().query<{ n: number }>(
      'SELECT public.get_next_arrival_number($1) AS n',
      [companyId],
    )
    expect(arrival.rows[0]!.n).toBe(1)

    const deliveryNote = await getPool().query<{ generate_delivery_note_number: string }>(
      'SELECT public.generate_delivery_note_number($1)',
      [companyId],
    )
    expect(deliveryNote.rows[0]!.generate_delivery_note_number).toMatch(/^FS-\d{4}001$/)
  })
})

describe('inbox quota guard: membership required.pg', () => {
  const MINUTE_MAX = 30
  const DAY_MAX = 500

  it('refuses an authenticated caller who is not a member of the target company', async () => {
    const victim = await seedCompany()
    const outsider = await seedCompany()

    // The shape the REVOKE cannot reach: a real signed-in user of their own
    // company, calling with someone else's company id. authenticated keeps
    // EXECUTE here because the upload and retry routes run this on the user's
    // session client, so the in-body guard is the only thing in the way.
    await expect(
      withUserContext(outsider.userId, (client) =>
        client.query('SELECT public.check_and_increment_inbox_quota($1, $2, $3)', [
          victim.companyId,
          MINUTE_MAX,
          DAY_MAX,
        ]),
      ),
    ).rejects.toThrow(/unauthorized/i)
  })

  it('refuses an anon-shaped caller with a role claim but no sub', async () => {
    const { companyId } = await seedCompany()

    await withAnonClaims(async (client) => {
      await expect(
        client.query('SELECT public.check_and_increment_inbox_quota($1, $2, $3)', [
          companyId,
          MINUTE_MAX,
          DAY_MAX,
        ]),
      ).rejects.toThrow(/unauthorized/i)
    })
  })

  it('still counts for a member and for the service path', async () => {
    const { userId, companyId } = await seedCompany()

    const member = await withUserContext(userId, async (client) => {
      const res = await client.query<{ result: { ok: boolean } }>(
        'SELECT public.check_and_increment_inbox_quota($1, $2, $3) AS result',
        [companyId, MINUTE_MAX, DAY_MAX],
      )
      return res.rows[0]!.result
    })
    expect(member.ok).toBe(true)

    // The inbound-email and WhatsApp paths arrive on
    // createServiceClientNoCookies(): no auth.uid() and no membership row to
    // find, so the trusted branch has to keep letting them through.
    const service = await runAsServiceRole(async (client) => {
      const res = await client.query<{ result: { ok: boolean } }>(
        'SELECT public.check_and_increment_inbox_quota($1, $2, $3) AS result',
        [companyId, MINUTE_MAX, DAY_MAX],
      )
      return res.rows[0]!.result
    })
    expect(service.ok).toBe(true)

    // runAsServiceRole commits while withUserContext rolls back, so the one
    // surviving counter row is the service call's: proof it went through the
    // upsert rather than just returning ok.
    const { rows } = await getPool().query<{ count: number }>(
      `SELECT count FROM public.inbox_rate_counters
        WHERE company_id = $1 AND window_kind = 'minute'`,
      [companyId],
    )
    expect(rows[0]!.count).toBe(1)
  })
})
