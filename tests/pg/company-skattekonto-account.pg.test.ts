/**
 * The skattekonto's ledger account per company (migration 20261015030000,
 * PH 175): 1630, or 2012 for an enskild firma that runs it in eget kapital.
 *
 *   - company_skattekonto_account(): 2012 only for an enskild firma whose
 *     setting says 2012; every other form and every unset value is 1630, and
 *     the legal form falls back to companies.entity_type like the app does;
 *   - the CHECK accepts only 1630, 2012 or NULL;
 *   - derive_skattekonto_account(): what the books say (1630 wins, then 2012,
 *     else NULL), drafts never count;
 *   - skattekonto_shape_accounts() and the VAT functions: a pure 26xx/2012
 *     verifikat is a settlement against the skattekonto in an enskild firma
 *     (excluded from the rutor, listed as settlement-shaped) and an ordinary
 *     verifikat in an aktiebolag (counted, as before);
 *   - ACLs: authenticated and service_role execute, anon does not; a stranger
 *     reads 1630 (no row visible), never the company's setting.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { getPool, withUserContext } from './setup'
import {
  insertAuthUser,
  insertCompany,
  insertCompanyMember,
  insertDraftJournalEntry,
  insertFiscalPeriod,
  insertPostedJournalEntry,
} from './fixtures'
import { VAT_ACCOUNTS, VAT_SETTLEMENT_NET_ACCOUNTS } from '@/lib/reports/vat-declaration'
import type { EntityType } from '@/types'

type Line = [account: string, debit: number, credit: number]

async function seed(params: {
  entityType: EntityType
  settingsEntityType?: EntityType | null
  stored?: string | null
  withSettings?: boolean
}) {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId, entityType: params.entityType })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  if (params.withSettings !== false) {
    await getPool().query(
      `INSERT INTO public.company_settings (user_id, company_id, entity_type, skattekonto_account)
       VALUES ($1, $2, $3, $4)`,
      [
        userId,
        companyId,
        params.settingsEntityType === undefined ? params.entityType : params.settingsEntityType,
        params.stored ?? null,
      ],
    )
  }
  const fiscalPeriodId = await insertFiscalPeriod({ userId, companyId })
  let voucherNumber = 0
  const post = (lines: Line[], sourceType = 'manual') =>
    insertPostedJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      voucherNumber: ++voucherNumber,
      entryDate: '2026-03-15',
      sourceType,
      lines: lines.map(([accountNumber, debitAmount, creditAmount]) => ({ accountNumber, debitAmount, creditAmount })),
    })
  return { userId, companyId, fiscalPeriodId, post }
}

async function resolved(companyId: string): Promise<string> {
  const { rows } = await getPool().query<{ account: string }>(
    `SELECT public.company_skattekonto_account($1) AS account`,
    [companyId],
  )
  return rows[0].account
}

async function derived(companyId: string): Promise<string | null> {
  const { rows } = await getPool().query<{ account: string | null }>(
    `SELECT public.derive_skattekonto_account($1) AS account`,
    [companyId],
  )
  return rows[0].account
}

async function shapeAccounts(companyId: string): Promise<string[]> {
  const { rows } = await getPool().query<{ accounts: string[] }>(
    `SELECT public.skattekonto_shape_accounts($1) AS accounts`,
    [companyId],
  )
  return rows[0].accounts
}

describe('company_skattekonto_account', () => {
  it('is 2012 only for an enskild firma that chose it', async () => {
    expect(await resolved((await seed({ entityType: 'enskild_firma', stored: '2012' })).companyId)).toBe('2012')
    expect(await resolved((await seed({ entityType: 'enskild_firma', stored: '1630' })).companyId)).toBe('1630')
    expect(await resolved((await seed({ entityType: 'enskild_firma' })).companyId)).toBe('1630')
  }, 30_000)

  it('is always 1630 for an aktiebolag, whatever is stored', async () => {
    expect(await resolved((await seed({ entityType: 'aktiebolag', stored: '2012' })).companyId)).toBe('1630')
    expect(await resolved((await seed({ entityType: 'aktiebolag' })).companyId)).toBe('1630')
  }, 30_000)

  it('falls back to companies.entity_type, and to 1630 without settings or company', async () => {
    const fallback = await seed({ entityType: 'enskild_firma', settingsEntityType: null, stored: '2012' })
    expect(await resolved(fallback.companyId)).toBe('2012')
    const noSettings = await seed({ entityType: 'enskild_firma', withSettings: false })
    expect(await resolved(noSettings.companyId)).toBe('1630')
    expect(await resolved('00000000-0000-0000-0000-000000000000')).toBe('1630')
  }, 30_000)

  it('refuses any other account', async () => {
    const { companyId } = await seed({ entityType: 'enskild_firma' })
    await expect(
      getPool().query(`UPDATE public.company_settings SET skattekonto_account = '1930' WHERE company_id = $1`, [companyId]),
    ).rejects.toThrow(/company_settings_skattekonto_account_check/)
  }, 30_000)

  it('a member reads the setting, a stranger reads 1630; anon cannot execute', async () => {
    const owner = await seed({ entityType: 'enskild_firma', stored: '2012' })
    const stranger = await seed({ entityType: 'enskild_firma' })
    const asMember = await withUserContext(owner.userId, async (client) => {
      const { rows } = await client.query<{ account: string }>(
        `SELECT public.company_skattekonto_account($1) AS account`,
        [owner.companyId],
      )
      return rows[0].account
    })
    const asStranger = await withUserContext(stranger.userId, async (client) => {
      const { rows } = await client.query<{ account: string }>(
        `SELECT public.company_skattekonto_account($1) AS account`,
        [owner.companyId],
      )
      return rows[0].account
    })
    expect(asMember).toBe('2012')
    expect(asStranger).toBe('1630')

    const { rows } = await getPool().query<Record<string, boolean>>(
      `SELECT has_function_privilege('anon', 'public.company_skattekonto_account(uuid)', 'EXECUTE') AS resolver_anon,
              has_function_privilege('authenticated', 'public.company_skattekonto_account(uuid)', 'EXECUTE') AS resolver_auth,
              has_function_privilege('service_role', 'public.company_skattekonto_account(uuid)', 'EXECUTE') AS resolver_service,
              has_function_privilege('anon', 'public.derive_skattekonto_account(uuid)', 'EXECUTE') AS derive_anon,
              has_function_privilege('authenticated', 'public.derive_skattekonto_account(uuid)', 'EXECUTE') AS derive_auth,
              has_function_privilege('anon', 'public.skattekonto_shape_accounts(uuid)', 'EXECUTE') AS shape_anon,
              has_function_privilege('authenticated', 'public.skattekonto_shape_accounts(uuid)', 'EXECUTE') AS shape_auth`,
    )
    expect(rows[0]).toEqual({
      resolver_anon: false,
      resolver_auth: true,
      resolver_service: true,
      derive_anon: false,
      derive_auth: true,
      shape_anon: false,
      shape_auth: true,
    })
  }, 30_000)
})

describe('derive_skattekonto_account', () => {
  it('reads the books: nothing, 2012 only, then 1630 wins', async () => {
    const { companyId, post, userId, fiscalPeriodId } = await seed({ entityType: 'enskild_firma' })
    expect(await derived(companyId)).toBeNull()

    // A draft on 1630 is no evidence.
    const draftId = await insertDraftJournalEntry({ userId, companyId, fiscalPeriodId, voucherNumber: 0 })
    await getPool().query(
      `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount)
       VALUES ($1, '1630', 100, 0), ($1, '1930', 0, 100)`,
      [draftId],
    )
    expect(await derived(companyId)).toBeNull()
    await post([['2012', 3000, 0], ['1930', 0, 3000]])
    expect(await derived(companyId)).toBe('2012')

    await post([['1630', 500, 0], ['1930', 0, 500]])
    expect(await derived(companyId)).toBe('1630')
  }, 30_000)
})

describe('the one-time backfill', () => {
  // The UPDATE exactly as the migration ran it, read from the file, so this
  // test cannot drift from what production executed.
  function backfillSql(): string {
    const file = readFileSync(
      resolve(__dirname, '../../supabase/migrations/20261015030000_company_skattekonto_account.sql'),
      'utf8',
    )
    const section = file.split('-- 3. Backfill, once.')[1].split('-- 4. The resolver.')[0]
    const sql = section
      .split('\n')
      .filter((line) => !line.startsWith('--'))
      .join('\n')
      .trim()
    expect(sql).toMatch(/^UPDATE public\.company_settings cs/)
    return sql
  }

  it('sets 2012 only for an unset enskild firma whose books run 2012 and never 1630', async () => {
    const only2012 = await seed({ entityType: 'enskild_firma' })
    await only2012.post([['2012', 3000, 0], ['1930', 0, 3000]], 'import')
    const both = await seed({ entityType: 'enskild_firma' })
    await both.post([['2012', 3000, 0], ['1930', 0, 3000]], 'import')
    await both.post([['1630', 500, 0], ['1930', 0, 500]])
    const chosen = await seed({ entityType: 'enskild_firma', stored: '1630' })
    await chosen.post([['2012', 3000, 0], ['1930', 0, 3000]], 'import')
    const ab = await seed({ entityType: 'aktiebolag' })
    await ab.post([['2012', 3000, 0], ['1930', 0, 3000]], 'import')
    const empty = await seed({ entityType: 'enskild_firma' })
    // A migration reset source is immutable: the backfill must not touch it
    // (an UPDATE would raise and abort the migration).
    const resetSource = await seed({ entityType: 'enskild_firma' })
    await resetSource.post([['2012', 3000, 0], ['1930', 0, 3000]], 'import')
    const replacement = await seed({ entityType: 'enskild_firma' })
    await getPool().query(
      `INSERT INTO public.company_migration_resets
         (source_company_id, replacement_company_id, reason, confirmation_snapshot, source_counts)
       VALUES ($1, $2, 'backfill test: reset source stays immutable', '{}'::jsonb, '{}'::jsonb)`,
      [resetSource.companyId, replacement.companyId],
    )

    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      await client.query(backfillSql())
      const { rows } = await client.query<{ company_id: string; skattekonto_account: string | null }>(
        `SELECT company_id, skattekonto_account FROM public.company_settings WHERE company_id = ANY ($1::uuid[])`,
        [[only2012, both, chosen, ab, empty, resetSource].map((s) => s.companyId)],
      )
      const stored = new Map(rows.map((r) => [r.company_id, r.skattekonto_account]))
      expect(stored.get(only2012.companyId)).toBe('2012')
      expect(stored.get(both.companyId)).toBeNull()
      expect(stored.get(chosen.companyId)).toBe('1630')
      expect(stored.get(ab.companyId)).toBeNull()
      expect(stored.get(empty.companyId)).toBeNull()
      expect(stored.get(resetSource.companyId)).toBeNull()
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  }, 60_000)
})

describe('VAT functions: a pure 26xx movement against 2012', () => {
  const ALL_ACCOUNTS = [...VAT_ACCOUNTS, ...VAT_SETTLEMENT_NET_ACCOUNTS]

  async function figure(companyId: string) {
    const { rows } = await getPool().query(
      `SELECT public.get_vat_declaration_totals($1,$2,$3,$4,$5,$6) AS payload`,
      [companyId, '2026-01-01', '2026-12-31', ALL_ACCOUNTS, VAT_ACCOUNTS, VAT_SETTLEMENT_NET_ACCOUNTS],
    )
    return rows[0].payload as {
      totals: Array<{ account_number: string; debit: number; credit: number }>
      settlement_shaped_entries: Array<{ id: string }>
    }
  }

  async function drillDownIds(companyId: string): Promise<string[]> {
    const { rows } = await getPool().query<{ journal_entry_id: string }>(
      `SELECT * FROM public.get_vat_ruta_source_lines($1,$2,$3,$4,$5,$6, NULL, NULL, NULL, NULL, 501)`,
      [companyId, '2026-01-01', '2026-12-31', ALL_ACCOUNTS, VAT_ACCOUNTS, VAT_SETTLEMENT_NET_ACCOUNTS],
    )
    return rows.map((r) => r.journal_entry_id)
  }

  const credit2611 = (payload: Awaited<ReturnType<typeof figure>>) =>
    Number(payload.totals.find((t) => t.account_number === '2611')?.credit ?? 0)

  it('names 1630 and 2012 as the skattekonto of an enskild firma, 1630 of an aktiebolag', async () => {
    expect(await shapeAccounts((await seed({ entityType: 'enskild_firma' })).companyId)).toEqual(['1630', '2012'])
    expect(await shapeAccounts((await seed({ entityType: 'enskild_firma', stored: '2012' })).companyId)).toEqual(['1630', '2012'])
    expect(await shapeAccounts((await seed({ entityType: 'aktiebolag', stored: '2012' })).companyId)).toEqual(['1630'])
  }, 30_000)

  it('excludes 2611 D / 2012 K in an enskild firma, whichever account it runs today', async () => {
    for (const stored of ['2012', null]) {
      const { companyId, post } = await seed({ entityType: 'enskild_firma', stored })
      await post([['1510', 1250, 0], ['3001', 0, 1000], ['2611', 0, 250]], 'invoice_created')
      const settledId = await post([['2611', 250, 0], ['2012', 0, 250]], 'import')

      const payload = await figure(companyId)
      // Only the sale is left on ruta 10's account.
      expect(credit2611(payload)).toBe(250)
      expect(payload.totals.find((t) => t.account_number === '2611')?.debit ?? 0).toBe(0)
      expect(payload.settlement_shaped_entries.map((e) => e.id)).toEqual([settledId])
      expect(await drillDownIds(companyId)).not.toContain(settledId)
    }
  }, 60_000)

  it('keeps counting the same verifikat in an aktiebolag: 2012 is no skattekonto there', async () => {
    const { companyId, post } = await seed({ entityType: 'aktiebolag', stored: '2012' })
    await post([['1510', 1250, 0], ['3001', 0, 1000], ['2611', 0, 250]], 'invoice_created')
    const entryId = await post([['2611', 250, 0], ['2012', 0, 250]], 'import')

    const payload = await figure(companyId)
    expect(payload.settlement_shaped_entries).toEqual([])
    expect(await drillDownIds(companyId)).toContain(entryId)
  }, 30_000)

  it('still treats a business verifikat against 2012 as business: 5410 D / 2641 D / 2012 K counts', async () => {
    const { companyId, post } = await seed({ entityType: 'enskild_firma', stored: '2012' })
    const businessId = await post([['5410', 400, 0], ['2641', 100, 0], ['2012', 0, 500]])

    const payload = await figure(companyId)
    expect(payload.settlement_shaped_entries).toEqual([])
    expect(Number(payload.totals.find((t) => t.account_number === '2641')?.debit ?? 0)).toBe(100)
    expect(await drillDownIds(companyId)).toContain(businessId)
  }, 30_000)
})
