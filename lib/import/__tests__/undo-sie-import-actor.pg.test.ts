import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from '@/tests/pg/setup'
import {
  seedCompany,
  insertAuthUser,
  insertCompanyMember,
  insertDraftJournalEntry,
  insertBalancedLines,
} from '@/tests/pg/fixtures'

// Migration 20260624120000_undo_sie_import_explicit_actor.sql makes
// undo_sie_import accept the authorising user as p_user_id and resolve the
// owner/admin gate against COALESCE(p_user_id, auth.uid()).
//
// Why: the RPC now runs on the service-role client (to escape the 8s
// statement_timeout on large imports). That client is cookie-less, so inside
// the RPC auth.uid() is NULL: before this fix the role lookup matched nothing
// and the function ALWAYS raised "Only company owners and admins can undo SIE
// imports", breaking undo entirely on hosted.
//
// These tests call the function over the raw pool (no JWT context), which is
// exactly the auth.uid()-is-NULL situation the service client creates.

async function insertCompletedImport(params: {
  companyId: string
  userId: string
  fiscalPeriodId: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.sie_imports
       (id, user_id, company_id, filename, file_hash, sie_type,
        fiscal_year_start, fiscal_year_end, accounts_count, transactions_count,
        status, fiscal_period_id, imported_at)
     VALUES ($1, $2, $3, 'undo-actor-test.se', $4, 4,
             '2026-01-01', '2026-12-31', 0, 1,
             'completed', $5, now())`,
    [id, params.userId, params.companyId, `hash-${id}`, params.fiscalPeriodId],
  )
  return id
}

// Seed one posted source_type='import' verifikat so undo has something to
// delete. Insert as draft + balanced lines, then commit the draft→posted
// transition (the balance trigger requires balanced lines on that step).
async function insertPostedImportEntry(params: {
  companyId: string
  userId: string
  fiscalPeriodId: string
}): Promise<string> {
  const jeId = await insertDraftJournalEntry({
    userId: params.userId,
    companyId: params.companyId,
    fiscalPeriodId: params.fiscalPeriodId,
    sourceType: 'import',
    status: 'draft',
    voucherNumber: 1,
  })
  await insertBalancedLines(jeId, 1000)
  await getPool().query(
    `UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`,
    [jeId],
  )
  return jeId
}

async function callUndo(companyId: string, importId: string, actor: string | null) {
  return getPool().query<{ deleted: number }>(
    `SELECT public.undo_sie_import($1::uuid, $2::uuid, $3::uuid) AS deleted`,
    [companyId, importId, actor],
  )
}

describe('undo_sie_import: explicit actor (service-client path)', () => {
  it('succeeds with an owner p_user_id even when auth.uid() is NULL', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const importId = await insertCompletedImport({ companyId, userId, fiscalPeriodId })
    const jeId = await insertPostedImportEntry({ companyId, userId, fiscalPeriodId })

    const res = await callUndo(companyId, importId, userId)
    expect(res.rows[0].deleted).toBe(1)

    const { rows: jeRows } = await getPool().query(
      `SELECT 1 FROM public.journal_entries WHERE id = $1`,
      [jeId],
    )
    expect(jeRows).toHaveLength(0)

    const { rows: impRows } = await getPool().query<{ status: string }>(
      `SELECT status FROM public.sie_imports WHERE id = $1`,
      [importId],
    )
    expect(impRows[0].status).toBe('undone')
  })

  it('raises when no authorising identity is supplied (auth.uid() NULL, p_user_id NULL)', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const importId = await insertCompletedImport({ companyId, userId, fiscalPeriodId })

    await expect(callUndo(companyId, importId, null)).rejects.toThrow(
      /owners and admins/i,
    )

    // The gate fired before any mutation: the import is untouched.
    const { rows } = await getPool().query<{ status: string }>(
      `SELECT status FROM public.sie_imports WHERE id = $1`,
      [importId],
    )
    expect(rows[0].status).toBe('completed')
  })

  it('raises when p_user_id is not an owner/admin of the company', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const importId = await insertCompletedImport({ companyId, userId, fiscalPeriodId })

    // A 'member' of the same company is still not allowed to undo.
    const memberId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: memberId, role: 'member' })

    await expect(callUndo(companyId, importId, memberId)).rejects.toThrow(
      /owners and admins/i,
    )

    // And a complete stranger (no membership) is rejected too.
    await expect(callUndo(companyId, importId, randomUUID())).rejects.toThrow(
      /owners and admins/i,
    )
  })

  it('still resolves the actor from auth.uid() when p_user_id is omitted (backward compat)', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const importId = await insertCompletedImport({ companyId, userId, fiscalPeriodId })
    // Seed a posted import verifikat so undo has something to delete. Without it
    // the returned count is 0 regardless of behaviour, so the assertion would
    // pass even if the function deleted nothing: making the count meaningless.
    await insertPostedImportEntry({ companyId, userId, fiscalPeriodId })

    // 2-arg shape: p_user_id defaults to NULL, so the gate falls back to
    // auth.uid(). withUserContext sets the JWT sub to the owner and runs in a
    // transaction; assert inside it (the helper rolls back on return).
    const deleted = await withUserContext(userId, async (client) => {
      const res = await client.query<{ deleted: number }>(
        `SELECT public.undo_sie_import($1::uuid, $2::uuid) AS deleted`,
        [companyId, importId],
      )
      const imp = await client.query<{ status: string }>(
        `SELECT status FROM public.sie_imports WHERE id = $1`,
        [importId],
      )
      expect(imp.rows[0].status).toBe('undone')
      return res.rows[0].deleted
    })
    expect(deleted).toBe(1)
  })
})
