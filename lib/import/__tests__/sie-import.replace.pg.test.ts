import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getClient, getPool, runAsServiceRole, withUserContext } from '@/tests/pg/setup'
import { seedCompany, insertAuthUser, insertCompanyMember } from '@/tests/pg/fixtures'

// Covers the Fortnox re-sync flow:
//  1. The partial unique index `sie_imports_company_id_file_hash_active_idx`
//     (added in migration 20260517150000) blocks duplicate (company_id,
//     file_hash) rows for active statuses but allows them once a prior row
//     is marked 'replaced' or 'failed'.
//  2. The replace_sie_import RPC hard-deletes journal entries with
//     source_type='import' (since 20260526120000), detaches user-attached
//     documents from them, clears the fiscal-period opening-balance
//     pointer if it came from the import, and resets voucher_sequences
//     so the next re-import restarts the series. User-created entries
//     (source_type='manual', 'bank_transaction', etc.) are left intact.
//  3. Since 20260727120000 the RPC takes a third argument, p_user_id, and
//     gates on owner/admin membership. Before that migration the function was
//     SECURITY DEFINER with EXECUTE held by `anon` and no authorization check
//     at all, while it set gnubok.allow_delete: an unauthenticated caller
//     could hard-delete any tenant's imported verifikationer.
//  4. p_user_id is honored ONLY when auth.role() = 'service_role' (the
//     cookieless server client); every other caller is pinned to its own
//     auth.uid(). A plain COALESCE(p_user_id, auth.uid()) would have let any
//     authenticated PostgREST caller pass an owner's UUID and impersonate
//     them into the gate. These tests therefore run the RPC under a simulated
//     service-role context (runAsServiceRole), which is how the app's
//     rpcClientForBulkDelete path presents.

async function insertSIEImport(params: {
  companyId: string
  userId: string
  fileHash: string
  status: 'pending' | 'mapped' | 'completed' | 'failed' | 'replaced'
  fiscalPeriodId?: string
  openingBalanceEntryId?: string
  fiscalYearStart?: string
  fiscalYearEnd?: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.sie_imports
       (id, user_id, company_id, filename, file_hash, sie_type,
        fiscal_year_start, fiscal_year_end, accounts_count, transactions_count,
        status, fiscal_period_id, opening_balance_entry_id, imported_at)
     VALUES ($1, $2, $3, 'fortnox-export.se', $4, 4,
             $5, $6, 0, 0,
             $7, $8, $9, $10)`,
    [
      id,
      params.userId,
      params.companyId,
      params.fileHash,
      params.fiscalYearStart ?? '2026-01-01',
      params.fiscalYearEnd ?? '2026-12-31',
      params.status,
      params.fiscalPeriodId ?? null,
      params.openingBalanceEntryId ?? null,
      params.status === 'completed' ? new Date().toISOString() : null,
    ],
  )
  return id
}

async function insertPostedEntry(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  sourceType: 'import' | 'manual' | 'bank_transaction'
  voucherNumber: number
  voucherSeries?: string
  entryDate?: string
}): Promise<string> {
  const id = randomUUID()
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'Test entry', $8, 'posted')`,
      [
        id,
        params.userId,
        params.companyId,
        params.fiscalPeriodId,
        params.voucherNumber,
        params.voucherSeries ?? 'A',
        params.entryDate ?? '2026-06-01',
        params.sourceType,
      ],
    )
    await client.query(
      `INSERT INTO public.journal_entry_lines
         (journal_entry_id, account_number, debit_amount, credit_amount)
       VALUES ($1, '1930', 100, 0),
              ($1, '3001', 0, 100)`,
      [id],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
  return id
}

async function insertVoucherSequence(params: {
  companyId: string
  userId: string
  fiscalPeriodId: string
  series: string
  lastNumber: number
}): Promise<void> {
  await getPool().query(
    `INSERT INTO public.voucher_sequences
       (company_id, user_id, fiscal_period_id, voucher_series, last_number)
     VALUES ($1, $2, $3, $4, $5)`,
    [params.companyId, params.userId, params.fiscalPeriodId, params.series, params.lastNumber],
  )
}

async function insertDocumentAttachment(params: {
  userId: string
  companyId: string
  journalEntryId: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.document_attachments
       (id, user_id, company_id, storage_path, file_name, sha256_hash, journal_entry_id, upload_source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'file_upload')`,
    [
      id,
      params.userId,
      params.companyId,
      `test/${id}.pdf`,
      `test-${id}.pdf`,
      `sha256-${id}`,
      params.journalEntryId,
    ],
  )
  return id
}

// Every call goes through the 3-arg shape with an explicit actor, under the
// service-role context: auth.uid() is NULL there, so the owner/admin gate can
// only resolve through p_user_id, which the function honors for service_role
// alone. Commits on success (the assertions below read persisted state over
// the plain pool); a raise aborts and rolls back.
async function callReplace(companyId: string, importId: string, actor: string | null) {
  return runAsServiceRole((client) =>
    client.query<{ deleted: number }>(
      `SELECT public.replace_sie_import($1::uuid, $2::uuid, $3::uuid) AS deleted`,
      [companyId, importId, actor],
    ),
  )
}

describe('sie_imports: partial unique index + replace flow', () => {
  it('blocks a second active row with the same (company_id, file_hash)', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const hash = `hash-${randomUUID()}`

    await insertSIEImport({
      companyId,
      userId,
      fileHash: hash,
      status: 'completed',
      fiscalPeriodId,
    })

    await expect(
      insertSIEImport({
        companyId,
        userId,
        fileHash: hash,
        status: 'pending',
        fiscalPeriodId,
      }),
    ).rejects.toThrow(/sie_imports_company_id_file_hash_active_idx/)
  })

  it('allows a new pending row with the same hash once the prior row is replaced', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const hash = `hash-${randomUUID()}`

    const priorId = await insertSIEImport({
      companyId,
      userId,
      fileHash: hash,
      status: 'completed',
      fiscalPeriodId,
    })

    // Mark the prior row as replaced (simulating what replace_sie_import does)
    await getPool().query(
      `UPDATE public.sie_imports SET status = 'replaced', replaced_at = now() WHERE id = $1`,
      [priorId],
    )

    // A new pending row with the same hash now succeeds
    const newId = await insertSIEImport({
      companyId,
      userId,
      fileHash: hash,
      status: 'pending',
      fiscalPeriodId,
    })
    expect(newId).toBeTruthy()
  })

  it('replace_sie_import deletes source_type=import entries, leaves manual/bank_transaction posted, and resets voucher_sequences to MAX of remaining', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()

    const obEntry = await insertPostedEntry({
      userId, companyId, fiscalPeriodId, sourceType: 'import', voucherNumber: 1,
    })
    const importEntry1 = await insertPostedEntry({
      userId, companyId, fiscalPeriodId, sourceType: 'import', voucherNumber: 2,
    })
    const importEntry2 = await insertPostedEntry({
      userId, companyId, fiscalPeriodId, sourceType: 'import', voucherNumber: 3,
    })
    const manualEntry = await insertPostedEntry({
      userId, companyId, fiscalPeriodId, sourceType: 'manual', voucherNumber: 4,
    })
    const txnEntry = await insertPostedEntry({
      userId, companyId, fiscalPeriodId, sourceType: 'bank_transaction', voucherNumber: 5,
    })

    // Voucher_sequences advanced past the imports (5 total inserted in series A)
    await insertVoucherSequence({
      companyId, userId, fiscalPeriodId, series: 'A', lastNumber: 5,
    })

    // The fiscal period has its opening_balance_entry_id set to the OB entry,
    // matching what a real SIE import would have produced.
    await getPool().query(
      `UPDATE public.fiscal_periods
         SET opening_balance_entry_id = $1, opening_balances_set = true
       WHERE id = $2`,
      [obEntry, fiscalPeriodId],
    )

    const importId = await insertSIEImport({
      companyId,
      userId,
      fileHash: `hash-${randomUUID()}`,
      status: 'completed',
      fiscalPeriodId,
      openingBalanceEntryId: obEntry,
    })

    const { rows } = await callReplace(companyId, importId, userId)
    expect(rows[0]!.deleted).toBe(3) // OB + 2 import entries

    // The import entries (and their lines) are gone
    const entries = await getPool().query<{ id: string; status: string }>(
      `SELECT id, status FROM public.journal_entries WHERE id = ANY($1)`,
      [[obEntry, importEntry1, importEntry2, manualEntry, txnEntry]],
    )
    const statusById = Object.fromEntries(entries.rows.map(r => [r.id, r.status]))
    expect(statusById[obEntry]).toBeUndefined()
    expect(statusById[importEntry1]).toBeUndefined()
    expect(statusById[importEntry2]).toBeUndefined()
    expect(statusById[manualEntry]).toBe('posted')
    expect(statusById[txnEntry]).toBe('posted')

    const lines = await getPool().query<{ count: string }>(
      `SELECT count(*)::text FROM public.journal_entry_lines
        WHERE journal_entry_id = ANY($1)`,
      [[obEntry, importEntry1, importEntry2]],
    )
    expect(lines.rows[0]!.count).toBe('0')

    // voucher_sequences reset to max of remaining entries in series A (5, the bank tx)
    const vs = await getPool().query<{ last_number: number }>(
      `SELECT last_number FROM public.voucher_sequences
        WHERE company_id = $1 AND fiscal_period_id = $2 AND voucher_series = 'A'`,
      [companyId, fiscalPeriodId],
    )
    expect(vs.rows[0]?.last_number).toBe(5)

    // fiscal_periods OB pointer cleared
    const fp = await getPool().query<{
      opening_balance_entry_id: string | null
      opening_balances_set: boolean
    }>(
      `SELECT opening_balance_entry_id, opening_balances_set
         FROM public.fiscal_periods WHERE id = $1`,
      [fiscalPeriodId],
    )
    expect(fp.rows[0]?.opening_balance_entry_id).toBeNull()
    expect(fp.rows[0]?.opening_balances_set).toBe(false)

    // sie_imports OB FK cleared, status replaced
    const importRow = await getPool().query<{
      status: string
      replaced_at: string | null
      opening_balance_entry_id: string | null
    }>(
      `SELECT status, replaced_at, opening_balance_entry_id
         FROM public.sie_imports WHERE id = $1`,
      [importId],
    )
    expect(importRow.rows[0]?.status).toBe('replaced')
    expect(importRow.rows[0]?.replaced_at).not.toBeNull()
    expect(importRow.rows[0]?.opening_balance_entry_id).toBeNull()
  })

  it('replace_sie_import resets voucher_sequences.last_number to 0 when no entries remain in the series', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()

    await insertPostedEntry({
      userId, companyId, fiscalPeriodId, sourceType: 'import', voucherNumber: 1,
    })
    await insertPostedEntry({
      userId, companyId, fiscalPeriodId, sourceType: 'import', voucherNumber: 2,
    })

    await insertVoucherSequence({
      companyId, userId, fiscalPeriodId, series: 'A', lastNumber: 2,
    })

    const importId = await insertSIEImport({
      companyId,
      userId,
      fileHash: `hash-${randomUUID()}`,
      status: 'completed',
      fiscalPeriodId,
    })

    await callReplace(companyId, importId, userId)

    const vs = await getPool().query<{ last_number: number }>(
      `SELECT last_number FROM public.voucher_sequences
        WHERE company_id = $1 AND fiscal_period_id = $2 AND voucher_series = 'A'`,
      [companyId, fiscalPeriodId],
    )
    expect(vs.rows[0]?.last_number).toBe(0)
  })

  it('replace_sie_import detaches documents from deleted entries without losing the document rows', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()

    const importEntry = await insertPostedEntry({
      userId, companyId, fiscalPeriodId, sourceType: 'import', voucherNumber: 1,
    })
    const manualEntry = await insertPostedEntry({
      userId, companyId, fiscalPeriodId, sourceType: 'manual', voucherNumber: 2,
    })

    const attachedDoc = await insertDocumentAttachment({
      userId, companyId, journalEntryId: importEntry,
    })
    const manualDoc = await insertDocumentAttachment({
      userId, companyId, journalEntryId: manualEntry,
    })

    const importId = await insertSIEImport({
      companyId,
      userId,
      fileHash: `hash-${randomUUID()}`,
      status: 'completed',
      fiscalPeriodId,
    })

    await callReplace(companyId, importId, userId)

    // The document attached to the deleted import entry is detached but preserved
    const detached = await getPool().query<{
      id: string
      journal_entry_id: string | null
      storage_path: string
      file_name: string
    }>(
      `SELECT id, journal_entry_id, storage_path, file_name
         FROM public.document_attachments WHERE id = $1`,
      [attachedDoc],
    )
    expect(detached.rows[0]).toBeTruthy()
    expect(detached.rows[0]?.journal_entry_id).toBeNull()
    expect(detached.rows[0]?.storage_path).toBeTruthy()
    expect(detached.rows[0]?.file_name).toBeTruthy()

    // The document attached to the surviving manual entry is left alone
    const untouched = await getPool().query<{ journal_entry_id: string | null }>(
      `SELECT journal_entry_id FROM public.document_attachments WHERE id = $1`,
      [manualDoc],
    )
    expect(untouched.rows[0]?.journal_entry_id).toBe(manualEntry)
  })

  it('replace_sie_import and undo_sie_import carry a raised statement_timeout', async () => {
    // Regression for the 8s-timeout cancellation (migration 20260629160000):
    // these RPCs run on the service-role REST client, which still inherits the
    // authenticator login role's 8s statement_timeout (service_role.rolconfig
    // is NULL). A large import's delete exceeded that and was cancelled, so the
    // functions now set a function-local statement_timeout well above 8s.
    const { rows } = await getPool().query<{ proname: string; proconfig: string[] | null }>(
      `SELECT proname, proconfig
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND proname IN ('replace_sie_import', 'undo_sie_import')`,
    )
    expect(rows.length).toBe(2)
    for (const fn of rows) {
      const timeout = (fn.proconfig ?? []).find(c => c.startsWith('statement_timeout='))
      expect(timeout, `${fn.proname} should set statement_timeout`).toBeTruthy()
      const seconds = Number(/statement_timeout=(\d+)s/.exec(timeout!)?.[1] ?? 0)
      expect(seconds).toBeGreaterThan(8)
    }
  })

  it('replace_sie_import on an already-replaced import raises', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()

    const importId = await insertSIEImport({
      companyId,
      userId,
      fileHash: `hash-${randomUUID()}`,
      status: 'completed',
      fiscalPeriodId,
    })

    await callReplace(companyId, importId, userId)

    await expect(callReplace(companyId, importId, userId)).rejects.toThrow(
      /not found or not in completed status/,
    )
  })
})

// Migration 20260727120000_replace_sie_import_authorize_actor.sql.
//
// Before it, replace_sie_import was a SECURITY DEFINER function with EXECUTE
// held by PUBLIC and by `anon`, no company_members lookup, no auth.uid() and
// no raise, while it called set_config('gnubok.allow_delete', 'true', true) to
// disarm the BFL immutability and retention triggers. That combination made it
// an unauthenticated cross-tenant data-destruction primitive over PostgREST.
//
// The gate mirrors undo_sie_import (20260624120000) and must fail CLOSED: a
// NULL role (no membership at all, which is what an anon caller has) is
// rejected just like a member/viewer role.
describe('replace_sie_import: owner/admin authorization gate', () => {
  it('succeeds for an owner actor and still deletes the import entries', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()

    const importEntry = await insertPostedEntry({
      userId, companyId, fiscalPeriodId, sourceType: 'import', voucherNumber: 1,
    })
    const manualEntry = await insertPostedEntry({
      userId, companyId, fiscalPeriodId, sourceType: 'manual', voucherNumber: 2,
    })

    const importId = await insertSIEImport({
      companyId,
      userId,
      fileHash: `hash-${randomUUID()}`,
      status: 'completed',
      fiscalPeriodId,
    })

    const { rows } = await callReplace(companyId, importId, userId)
    expect(rows[0]!.deleted).toBe(1)

    const surviving = await getPool().query<{ id: string }>(
      `SELECT id FROM public.journal_entries WHERE id = ANY($1)`,
      [[importEntry, manualEntry]],
    )
    expect(surviving.rows.map(r => r.id)).toEqual([manualEntry])

    const importRow = await getPool().query<{ status: string }>(
      `SELECT status FROM public.sie_imports WHERE id = $1`,
      [importId],
    )
    expect(importRow.rows[0]?.status).toBe('replaced')
  })

  it('succeeds for an admin actor', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const adminId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: adminId, role: 'admin' })

    await insertPostedEntry({
      userId, companyId, fiscalPeriodId, sourceType: 'import', voucherNumber: 1,
    })
    const importId = await insertSIEImport({
      companyId,
      userId,
      fileHash: `hash-${randomUUID()}`,
      status: 'completed',
      fiscalPeriodId,
    })

    const { rows } = await callReplace(companyId, importId, adminId)
    expect(rows[0]!.deleted).toBe(1)
  })

  it('raises for an actor with no membership in the company', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const importEntry = await insertPostedEntry({
      userId, companyId, fiscalPeriodId, sourceType: 'import', voucherNumber: 1,
    })
    const importId = await insertSIEImport({
      companyId,
      userId,
      fileHash: `hash-${randomUUID()}`,
      status: 'completed',
      fiscalPeriodId,
    })

    // A real user who simply belongs to a different company: the cross-tenant
    // case the pre-fix function allowed outright.
    const { userId: strangerId } = await seedCompany()
    await expect(callReplace(companyId, importId, strangerId)).rejects.toThrow(
      /owners and admins/i,
    )

    // And an id that matches no user at all.
    await expect(callReplace(companyId, importId, randomUUID())).rejects.toThrow(
      /owners and admins/i,
    )

    await expectUntouched(companyId, importId, importEntry)
  })

  it('raises for a viewer-role member', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const viewerId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: viewerId, role: 'viewer' })

    const importEntry = await insertPostedEntry({
      userId, companyId, fiscalPeriodId, sourceType: 'import', voucherNumber: 1,
    })
    const importId = await insertSIEImport({
      companyId,
      userId,
      fileHash: `hash-${randomUUID()}`,
      status: 'completed',
      fiscalPeriodId,
    })

    await expect(callReplace(companyId, importId, viewerId)).rejects.toThrow(
      /owners and admins/i,
    )
    await expectUntouched(companyId, importId, importEntry)
  })

  it('raises for a member-role member', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const memberId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: memberId, role: 'member' })

    const importEntry = await insertPostedEntry({
      userId, companyId, fiscalPeriodId, sourceType: 'import', voucherNumber: 1,
    })
    const importId = await insertSIEImport({
      companyId,
      userId,
      fileHash: `hash-${randomUUID()}`,
      status: 'completed',
      fiscalPeriodId,
    })

    await expect(callReplace(companyId, importId, memberId)).rejects.toThrow(
      /owners and admins/i,
    )
    await expectUntouched(companyId, importId, importEntry)
  })

  it('raises when no authorising identity is supplied at all', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const importEntry = await insertPostedEntry({
      userId, companyId, fiscalPeriodId, sourceType: 'import', voucherNumber: 1,
    })
    const importId = await insertSIEImport({
      companyId,
      userId,
      fileHash: `hash-${randomUUID()}`,
      status: 'completed',
      fiscalPeriodId,
    })

    // Explicit NULL p_user_id, auth.uid() NULL under the service role.
    await expect(callReplace(companyId, importId, null)).rejects.toThrow(
      /owners and admins/i,
    )

    // 2-arg shape (p_user_id defaults to NULL): this is the exact call the
    // pre-fix function accepted from anon, and it must now raise.
    await expect(
      runAsServiceRole((client) =>
        client.query(
          `SELECT public.replace_sie_import($1::uuid, $2::uuid)`,
          [companyId, importId],
        ),
      ),
    ).rejects.toThrow(/owners and admins/i)

    await expectUntouched(companyId, importId, importEntry)
  })

  it('ignores a spoofed p_user_id from an authenticated (non-service) caller', async () => {
    // The impersonation hole this migration closes: EXECUTE is granted to
    // `authenticated`, so any signed-in user can call the RPC over PostgREST.
    // A viewer passing the OWNER's UUID as p_user_id must still be pinned to
    // their own auth.uid(), rejected with 42501, and nothing may be deleted:
    // otherwise a known company/import/owner triple is a cross-tenant hard
    // delete of posted verifikationer.
    const { companyId, userId: ownerId, fiscalPeriodId } = await seedCompany()
    const viewerId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: viewerId, role: 'viewer' })
    const memberId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: memberId, role: 'member' })

    const importEntry = await insertPostedEntry({
      userId: ownerId, companyId, fiscalPeriodId, sourceType: 'import', voucherNumber: 1,
    })
    const importId = await insertSIEImport({
      companyId,
      userId: ownerId,
      fileHash: `hash-${randomUUID()}`,
      status: 'completed',
      fiscalPeriodId,
    })

    for (const spoofer of [viewerId, memberId]) {
      await withUserContext(spoofer, async (client) => {
        let raised: (Error & { code?: string }) | null = null
        try {
          await client.query(
            `SELECT public.replace_sie_import($1::uuid, $2::uuid, $3::uuid)`,
            [companyId, importId, ownerId],
          )
        } catch (err) {
          raised = err as Error & { code?: string }
        }
        expect(raised, 'spoofed p_user_id must not authorize').not.toBeNull()
        expect(raised!.message).toMatch(/owners and admins/i)
        // Explicit errcode so the route can map the raise to a 403.
        expect(raised!.code).toBe('42501')
      })
    }

    await expectUntouched(companyId, importId, importEntry)
  })

  it('still resolves the actor from auth.uid() when p_user_id is omitted', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    await insertPostedEntry({
      userId, companyId, fiscalPeriodId, sourceType: 'import', voucherNumber: 1,
    })
    const importId = await insertSIEImport({
      companyId,
      userId,
      fileHash: `hash-${randomUUID()}`,
      status: 'completed',
      fiscalPeriodId,
    })

    // withUserContext sets the JWT sub to the owner and rolls back on return,
    // so assert inside the callback.
    const deleted = await withUserContext(userId, async (client) => {
      const res = await client.query<{ deleted: number }>(
        `SELECT public.replace_sie_import($1::uuid, $2::uuid) AS deleted`,
        [companyId, importId],
      )
      const imp = await client.query<{ status: string }>(
        `SELECT status FROM public.sie_imports WHERE id = $1`,
        [importId],
      )
      expect(imp.rows[0]!.status).toBe('replaced')
      return res.rows[0]!.deleted
    })
    expect(deleted).toBe(1)
  })

  it('exposes exactly one signature and does not grant EXECUTE to anon', async () => {
    // The 2-arg overload is dropped by the migration: leaving it in place
    // would keep an unguarded, unrevoked entry point alive and would make the
    // 2-arg PostgREST call ambiguous against the new DEFAULT NULL parameter.
    const { rows: overloads } = await getPool().query<{ signature: string }>(
      `SELECT p.oid::regprocedure::text AS signature
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'replace_sie_import'`,
    )
    expect(overloads.map(r => r.signature)).toEqual([
      'replace_sie_import(uuid,uuid,uuid)',
    ])

    const { rows } = await getPool().query<{
      anon_can: boolean
      public_can: boolean
      authenticated_can: boolean
      service_role_can: boolean
    }>(
      `SELECT has_function_privilege('anon', 'public.replace_sie_import(uuid,uuid,uuid)', 'EXECUTE') AS anon_can,
              has_function_privilege('public', 'public.replace_sie_import(uuid,uuid,uuid)', 'EXECUTE') AS public_can,
              has_function_privilege('authenticated', 'public.replace_sie_import(uuid,uuid,uuid)', 'EXECUTE') AS authenticated_can,
              has_function_privilege('service_role', 'public.replace_sie_import(uuid,uuid,uuid)', 'EXECUTE') AS service_role_can`,
    )
    expect(rows[0]!.anon_can, 'anon must not be able to call replace_sie_import').toBe(false)
    expect(rows[0]!.public_can, 'PUBLIC must not hold EXECUTE').toBe(false)
    // The app calls the RPC on the service client, falling back to the
    // caller's session client when SUPABASE_SERVICE_ROLE_KEY is unset
    // (rpcClientForBulkDelete in lib/import/sie-import.ts).
    expect(rows[0]!.authenticated_can).toBe(true)
    expect(rows[0]!.service_role_can).toBe(true)
  })
})

// The gate must fire before any mutation: the import row, its verifikat and
// the allow_delete-protected data are all still there after a rejected call.
async function expectUntouched(companyId: string, importId: string, entryId: string) {
  const imp = await getPool().query<{ status: string }>(
    `SELECT status FROM public.sie_imports WHERE id = $1 AND company_id = $2`,
    [importId, companyId],
  )
  expect(imp.rows[0]?.status).toBe('completed')

  const je = await getPool().query<{ status: string }>(
    `SELECT status FROM public.journal_entries WHERE id = $1`,
    [entryId],
  )
  expect(je.rows[0]?.status).toBe('posted')
}
