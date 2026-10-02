import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { insertAuthUser, insertCompanyMember, seedCompany } from '@/tests/pg/fixtures'
import { getPool, runAsServiceRole, withUserContext } from '@/tests/pg/setup'

/**
 * pg-real coverage for 20260929173432_withhold_credential_columns_from_end_users.sql
 * (CASA AL1 6.7.1 and 7.3.2, issue #3191).
 *
 * WITHHELD is the registry of credential columns that end-user roles (anon,
 * authenticated) must never read. The migration turned table-level SELECT
 * into column-level SELECT on every other column, which has one trap: a
 * column added to these tables later is invisible to authenticated until
 * its migration grants it. The catalog tests below fail in both directions,
 * with a message that says which fix applies:
 *   - a non-credential column the session cannot read: grant it;
 *   - a credential column the session can read: withhold it.
 * The sweep at the end fails when ANY public table grows a credential-shaped
 * column that members can read, so the next one gets classified in review
 * instead of in an assessment.
 */
const WITHHELD: Record<string, readonly string[]> = {
  webhooks: ['secret'],
  invoice_reminders: ['action_token'],
  calendar_feeds: ['feed_token'],
  skatteverket_tokens: ['access_token', 'refresh_token'],
  shopify_connections: ['client_id_encrypted', 'client_secret_encrypted'],
  woocommerce_connections: ['consumer_key_encrypted', 'consumer_secret_encrypted'],
  zettle_connections: ['refresh_token_encrypted'],
  bolagsverket_subscriptions: ['auth_secret'],
}

/** Plaintext signing / delivery-auth secrets: no end-user session writes these tables at all. */
const SERVER_WRITTEN_ONLY = ['webhooks', 'bolagsverket_subscriptions'] as const

/**
 * Credential-shaped column names that members may read, each with the reason
 * it is not a credential. Anything else the sweep finds is a finding.
 */
const READABLE_NOT_CREDENTIALS: Record<string, string> = {
  'arsredovisning_signature_requests.signer_personnummer_encrypted': 'PII ciphertext, not a credential',
  'bankid_identities.personal_number_enc': 'PII ciphertext, not a credential',
  'invoices.deduction_personnummer_encrypted': 'PII ciphertext, not a credential',
  'whatsapp_phone_links.phone_enc': 'PII ciphertext, not a credential',
  'fiscal_periods.opening_balance_review_token': 'SIE review-hold marker the holds route reads, grants nothing',
}

const TABLES = Object.keys(WITHHELD)

async function columnsOf(table: string): Promise<string[]> {
  const { rows } = await getPool().query<{ attname: string }>(
    `SELECT attname FROM pg_attribute
      WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped
      ORDER BY attnum`,
    [`public.${table}`],
  )
  return rows.map((r) => r.attname)
}

async function canColumn(role: string, table: string, column: string, privilege: string): Promise<boolean> {
  const { rows } = await getPool().query<{ ok: boolean }>(
    `SELECT has_column_privilege($1, $2::regclass, $3, $4) AS ok`,
    [role, `public.${table}`, column, privilege],
  )
  return rows[0].ok
}

async function canAnyColumn(role: string, table: string, privilege: string): Promise<boolean> {
  const { rows } = await getPool().query<{ ok: boolean }>(
    `SELECT has_any_column_privilege($1, $2::regclass, $3) AS ok`,
    [role, `public.${table}`, privilege],
  )
  return rows[0].ok
}

function nonCredentialColumns(all: string[], table: string): string[] {
  return all.filter((c) => !WITHHELD[table].includes(c))
}

/** One statement per user context: a refused statement aborts the transaction. */
async function expectRefused(userId: string, sql: string, params: unknown[]): Promise<void> {
  await expect(withUserContext(userId, (client) => client.query(sql, params))).rejects.toMatchObject({
    code: '42501',
  })
}

describe('credential columns: privileges in the catalog', () => {
  it('no end-user role reads a credential column; the service role does', async () => {
    for (const table of TABLES) {
      for (const column of WITHHELD[table]) {
        const where = `public.${table}.${column}`
        expect(await canColumn('authenticated', table, column, 'SELECT'), `${where} is readable by authenticated: withhold it`).toBe(false)
        expect(await canColumn('anon', table, column, 'SELECT'), `${where} is readable by anon`).toBe(false)
        expect(await canColumn('service_role', table, column, 'SELECT'), `${where} must stay readable by service_role`).toBe(true)
      }
    }
  })

  it('authenticated reads every other column, so a new column needs its grant', async () => {
    for (const table of TABLES) {
      for (const column of nonCredentialColumns(await columnsOf(table), table)) {
        expect(
          await canColumn('authenticated', table, column, 'SELECT'),
          `public.${table}.${column} is not readable by authenticated: GRANT SELECT (${column}) ON public.${table} TO authenticated in the migration that adds it, or add it to WITHHELD if it is a credential`,
        ).toBe(true)
      }
    }
  })

  it('no end-user role holds table-level SELECT, which would re-expose every column', async () => {
    for (const table of TABLES) {
      const { rows } = await getPool().query<{ auth: boolean; anon: boolean }>(
        `SELECT has_table_privilege('authenticated', $1::regclass, 'SELECT') AS auth,
                has_table_privilege('anon', $1::regclass, 'SELECT') AS anon`,
        [`public.${table}`],
      )
      expect(rows[0], `public.${table}`).toEqual({ auth: false, anon: false })
      expect(await canAnyColumn('anon', table, 'SELECT'), `anon reads a column of public.${table}`).toBe(false)
    }
  })

  it('tables holding a plaintext signing secret are written by the server only', async () => {
    for (const table of SERVER_WRITTEN_ONLY) {
      for (const role of ['authenticated', 'anon']) {
        expect(await canAnyColumn(role, table, 'INSERT'), `${role} INSERT on public.${table}`).toBe(false)
        expect(await canAnyColumn(role, table, 'UPDATE'), `${role} UPDATE on public.${table}`).toBe(false)
      }
      expect(await canAnyColumn('service_role', table, 'INSERT')).toBe(true)
      expect(await canAnyColumn('service_role', table, 'UPDATE')).toBe(true)
    }
  })

  it('sweep: no other credential-shaped column in public is readable by members', async () => {
    const { rows } = await getPool().query<{ col: string }>(`
      SELECT c.relname || '.' || a.attname AS col
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relkind IN ('r', 'p')
         AND a.attnum > 0
         AND NOT a.attisdropped
         AND a.attname ~ '(^|_)(token|secret|password|passwd|credential|credentials|private_key|api_key|apikey)(_|$)|_encrypted$|_enc$'
         AND a.attname !~ '(_hash|_id|_used|_count|_version|_at|_expires|_prefix)$'
         AND has_column_privilege('authenticated', c.oid, a.attnum, 'SELECT')
         AND EXISTS (
           SELECT 1 FROM pg_policies p
            WHERE p.schemaname = 'public'
              AND p.tablename = c.relname
              AND p.cmd IN ('SELECT', 'ALL')
              AND p.roles && ARRAY['authenticated', 'public']::name[]
         )
       ORDER BY 1`)
    const unclassified = rows.map((r) => r.col).filter((col) => !(col in READABLE_NOT_CREDENTIALS))
    expect(
      unclassified,
      'members can read these credential-shaped columns: withhold them (a migration like 20260929173432 plus WITHHELD) or add them to READABLE_NOT_CREDENTIALS with the reason',
    ).toEqual([])
  })
})

describe('credential columns: a company member through the API role', () => {
  let ownerId: string
  let viewerId: string
  let companyId: string
  // Several of these columns are UNIQUE and the seed commits: tag each value
  // so the suite can rerun against the same database.
  const tag = randomUUID().slice(0, 8)
  const SEEDED: Record<string, Record<string, string>> = {
    webhooks: { secret: `whsec-${tag}` },
    invoice_reminders: { action_token: `reminder-bearer-${tag}` },
    calendar_feeds: { feed_token: `feed-bearer-${tag}` },
    skatteverket_tokens: { access_token: `enc-access-${tag}`, refresh_token: `enc-refresh-${tag}` },
    shopify_connections: {
      client_id_encrypted: `enc-client-id-${tag}`,
      client_secret_encrypted: `enc-client-secret-${tag}`,
    },
    woocommerce_connections: {
      consumer_key_encrypted: `enc-ck-${tag}`,
      consumer_secret_encrypted: `enc-cs-${tag}`,
    },
    zettle_connections: { refresh_token_encrypted: `enc-zettle-refresh-${tag}` },
    bolagsverket_subscriptions: { auth_secret: `bv-delivery-secret-${tag}` },
  }

  beforeAll(async () => {
    const seeded = await seedCompany()
    ownerId = seeded.userId
    companyId = seeded.companyId
    viewerId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: viewerId, role: 'viewer' })

    const pool = getPool()
    const invoiceId = randomUUID()
    await pool.query(
      `INSERT INTO public.webhooks (company_id, event_type, webhook_url, secret, name)
       VALUES ($1, 'invoice.created', 'https://hooks.example.test/in', $2, 'Bokföring')`,
      [companyId, SEEDED.webhooks.secret],
    )
    await pool.query(
      `INSERT INTO public.invoices (id, user_id, company_id, invoice_number, invoice_date, due_date, status)
       VALUES ($1, $2, $3, $4, '2026-08-01', '2026-08-31', 'sent')`,
      [invoiceId, ownerId, companyId, `F-${invoiceId.slice(0, 8)}`],
    )
    await pool.query(
      `INSERT INTO public.invoice_reminders (invoice_id, user_id, company_id, reminder_level, email_to, action_token)
       VALUES ($1, $2, $3, 1, 'kund@example.test', $4)`,
      [invoiceId, ownerId, companyId, SEEDED.invoice_reminders.action_token],
    )
    await pool.query(
      `INSERT INTO public.calendar_feeds (user_id, company_id, feed_token)
       VALUES ($1, $2, $3)`,
      [ownerId, companyId, SEEDED.calendar_feeds.feed_token],
    )
    await pool.query(
      `INSERT INTO public.skatteverket_tokens (user_id, company_id, access_token, refresh_token, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '1 hour')`,
      [ownerId, companyId, SEEDED.skatteverket_tokens.access_token, SEEDED.skatteverket_tokens.refresh_token],
    )
    await pool.query(
      `INSERT INTO public.shopify_connections
         (company_id, user_id, shop_domain, client_id_encrypted, client_secret_encrypted, status)
       VALUES ($1, $2, $3, $4, $5, 'active')`,
      [
        companyId,
        ownerId,
        `s-${companyId.slice(0, 8)}.myshopify.com`,
        SEEDED.shopify_connections.client_id_encrypted,
        SEEDED.shopify_connections.client_secret_encrypted,
      ],
    )
    await pool.query(
      `INSERT INTO public.woocommerce_connections
         (company_id, user_id, store_url, status, consumer_key_encrypted, consumer_secret_encrypted)
       VALUES ($1, $2, $3, 'pending', $4, $5)`,
      [
        companyId,
        ownerId,
        `https://w-${companyId.slice(0, 8)}.example.test`,
        SEEDED.woocommerce_connections.consumer_key_encrypted,
        SEEDED.woocommerce_connections.consumer_secret_encrypted,
      ],
    )
    await pool.query(
      `INSERT INTO public.zettle_connections (company_id, user_id, refresh_token_encrypted, status)
       VALUES ($1, $2, $3, 'active')`,
      [companyId, ownerId, SEEDED.zettle_connections.refresh_token_encrypted],
    )
    await pool.query(
      `INSERT INTO public.bolagsverket_subscriptions
         (company_id, user_id, orgnr, url, auth_secret, environment, expires_at)
       VALUES ($1, $2, '5560001111', 'https://example.test/hook', $3, 'test', now() + interval '6 months')`,
      [companyId, ownerId, SEEDED.bolagsverket_subscriptions.auth_secret],
    )
  })

  const members = () => [
    ['owner', ownerId],
    ['viewer', viewerId],
  ] as const

  it('is refused every credential column, named or through *', async () => {
    for (const [, userId] of members()) {
      for (const table of TABLES) {
        for (const column of WITHHELD[table]) {
          await expectRefused(userId, `SELECT ${column} FROM public.${table} WHERE company_id = $1`, [companyId])
        }
        await expectRefused(userId, `SELECT * FROM public.${table} WHERE company_id = $1`, [companyId])
      }
    }
  })

  it('still reads every other column of its company rows', async () => {
    for (const [role, userId] of members()) {
      for (const table of TABLES) {
        const columns = nonCredentialColumns(await columnsOf(table), table)
        const rows = await withUserContext(userId, async (client) => {
          const res = await client.query(
            `SELECT ${columns.join(', ')} FROM public.${table} WHERE company_id = $1`,
            [companyId],
          )
          return res.rows
        })
        expect(rows, `${role} reading public.${table}`).toHaveLength(1)
      }
    }
  })

  it('keeps the head count the dashboard runs working', async () => {
    const count = await withUserContext(ownerId, async (client) => {
      const res = await client.query<{ n: string }>(
        `SELECT count(id) AS n FROM public.skatteverket_tokens WHERE user_id = $1 AND company_id = $2`,
        [ownerId, companyId],
      )
      return Number(res.rows[0].n)
    })
    expect(count).toBe(1)
  })

  it('cannot insert or update a webhook or a Bolagsverket subscription, even as owner', async () => {
    await expectRefused(ownerId, `UPDATE public.webhooks SET secret = 'known' WHERE company_id = $1`, [companyId])
    await expectRefused(ownerId, `UPDATE public.webhooks SET active = false WHERE company_id = $1`, [companyId])
    await expectRefused(
      ownerId,
      `INSERT INTO public.webhooks (company_id, event_type, webhook_url, secret)
       VALUES ($1, 'invoice.created', 'https://attacker.example.test', 'known')`,
      [companyId],
    )
    await expectRefused(
      ownerId,
      `UPDATE public.bolagsverket_subscriptions SET auth_secret = 'known' WHERE company_id = $1`,
      [companyId],
    )
    await expectRefused(
      ownerId,
      `INSERT INTO public.bolagsverket_subscriptions (company_id, user_id, orgnr, url, auth_secret, environment, expires_at)
       VALUES ($1, $2, '5560002222', 'https://example.test/hook', 'known', 'test', now() + interval '1 month')`,
      [companyId, ownerId],
    )
  })

  it('keeps the session writes the app makes on the other tables', async () => {
    const updated = await withUserContext(ownerId, async (client) => {
      const res = await client.query(
        `UPDATE public.calendar_feeds SET include_invoices = false
          WHERE company_id = $1 RETURNING id, include_invoices`,
        [companyId],
      )
      return res.rows
    })
    expect(updated).toEqual([{ id: expect.any(String), include_invoices: false }])
  })

  it('leaves every secret readable to the service role', async () => {
    const secrets = await runAsServiceRole(async (client) => {
      const out: Record<string, unknown> = {}
      for (const table of TABLES) {
        const res = await client.query(
          `SELECT ${WITHHELD[table].join(', ')} FROM public.${table} WHERE company_id = $1`,
          [companyId],
        )
        out[table] = res.rows[0]
      }
      return out
    })
    expect(secrets).toEqual(SEEDED)
  })
})
