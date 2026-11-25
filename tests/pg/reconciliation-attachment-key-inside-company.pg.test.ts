import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { attachmentStoragePath } from '@/lib/reconciliation/attachments'
import { getPool, runAsServiceRole, withUserContext } from './setup'
import { insertCompanyMember, seedCompany } from './fixtures'

/**
 * guard_reconciliation_attachment_storage_path (20261125162000): a member's
 * reconciliation attachment names a file in its own company's folder of the
 * documents bucket, where attachUnderlag puts it. Another bucket, another
 * company's folder, a key outside the company folder or a key that is not
 * plain is refused with 42501. Server code (the service role, the superuser)
 * is not checked. The TypeScript side of the same rule is
 * isCompanyFolderObject in src/lib/core/documents/storage-key.ts.
 */

const SHA = 'cd'.repeat(32)

/** The member inserts an attachment row with this bucket and key through their own token. */
async function memberAttach(userId: string, companyId: string, storagePath: string, storageBucket = 'documents'): Promise<void> {
  await withUserContext(userId, (c) =>
    c.query(
      `INSERT INTO public.account_reconciliation_attachments
         (company_id, account_key, through_date, file_name, mime_type, size_bytes, storage_bucket, storage_path, sha256, uploaded_by)
       VALUES ($1, 'manual:2350', '2026-12-31', 'kontoutdrag.pdf', 'application/pdf', 1234, $2, $3, $4, $5)`,
      [companyId, storageBucket, storagePath, SHA, userId],
    ),
  )
}

/** Where attachUnderlag puts a file of this company. */
const ownKey = (companyId: string, fileName = 'kontoutdrag.pdf') =>
  attachmentStoragePath(companyId, 'manual:2350', '2026-12-31', fileName)

async function twoCompanies() {
  const a = await seedCompany()
  const b = await seedCompany()
  return { userA: a.userId, companyA: a.companyId, userB: b.userId, companyB: b.companyId }
}

describe('guard_reconciliation_attachment_storage_path (pg)', () => {
  it('lets a member attach a file where attachUnderlag puts it, whatever its name', async () => {
    const { userA, companyA } = await twoCompanies()
    for (const fileName of ['kontoutdrag.pdf', 'Skattekontoutdrag från Byrån.pdf', '../../x.pdf', '%2e%2e?#.pdf', '.pdf']) {
      await expect(memberAttach(userA, companyA, ownKey(companyA, fileName)), fileName).resolves.toBeUndefined()
    }
  })

  it('refuses a key in another company folder', async () => {
    const { userA, companyA, companyB } = await twoCompanies()
    await expect(memberAttach(userA, companyA, ownKey(companyB))).rejects.toMatchObject({ code: '42501' })
  })

  it('refuses any bucket but documents', async () => {
    const { userA, companyA } = await twoCompanies()
    for (const bucket of ['receipts', 'sie-files', 'Documents', '']) {
      await expect(memberAttach(userA, companyA, ownKey(companyA), bucket), bucket).rejects.toMatchObject({ code: '42501' })
    }
  })

  it('refuses a key outside the company folder, a legacy uploader key included', async () => {
    const { userA, companyA } = await twoCompanies()
    for (const key of [
      `${companyA}/reconciliation/kontoutdrag.pdf`,
      `reconciliation/documents/${companyA}/kontoutdrag.pdf`,
      `documents/${userA}/1767000000000_kontoutdrag.pdf`,
      `documents/${companyA}`,
      `documents/${companyA}x/kontoutdrag.pdf`,
      // The company id as the database writes it, in lower case: the folder a member's upload can reach.
      `documents/${companyA.toUpperCase()}/reconciliation/kontoutdrag.pdf`,
    ]) {
      await expect(memberAttach(userA, companyA, key), key).rejects.toMatchObject({ code: '42501' })
    }
  })

  it('judges a member of two companies by the row company, not the membership', async () => {
    const { userA, companyA, companyB } = await twoCompanies()
    await insertCompanyMember({ companyId: companyB, userId: userA, role: 'member' })
    await expect(memberAttach(userA, companyA, ownKey(companyB))).rejects.toMatchObject({ code: '42501' })
    await expect(memberAttach(userA, companyB, ownKey(companyB))).resolves.toBeUndefined()
  })

  it('refuses a key with an empty, "." or ".." part or a character a URL reads differently', async () => {
    const { userA, companyA, companyB } = await twoCompanies()
    const own = `documents/${companyA}`
    for (const key of [
      `${own}/../${companyB}/reconciliation/kontoutdrag.pdf`,
      `${own}/./kontoutdrag.pdf`,
      `${own}//kontoutdrag.pdf`,
      `${own}/`,
      `${own}/reconciliation/`,
      `${own}/%2e%2e/${companyB}/kontoutdrag.pdf`,
      `${own}/..\\${companyB}/kontoutdrag.pdf`,
      `${own}/kontoutdrag.pdf?download=1`,
      `${own}/kontoutdrag.pdf#y`,
      `${own}/.\n./${companyB}/kontoutdrag.pdf`,
    ]) {
      await expect(memberAttach(userA, companyA, key), key).rejects.toMatchObject({ code: '42501' })
    }
  })

  it('leaves server code alone: the service role and the superuser write any bucket and key', async () => {
    const { userA, companyA } = await twoCompanies()
    const insert = `INSERT INTO public.account_reconciliation_attachments
         (id, company_id, account_key, through_date, file_name, mime_type, size_bytes, storage_bucket, storage_path, sha256, uploaded_by)
       VALUES ($1::uuid, $2, 'manual:2350', '2026-12-31', 'kontoutdrag.pdf', 'application/pdf', 1234, 'pg-fixture', $1::uuid::text, $3, $4)`
    const viaService = randomUUID()
    await runAsServiceRole((c) => c.query(insert, [viaService, companyA, SHA, userA]))
    const viaSuperuser = randomUUID()
    await getPool().query(insert, [viaSuperuser, companyA, SHA, userA])
    const { rows } = await getPool().query<{ n: string }>(
      `SELECT count(*) AS n FROM public.account_reconciliation_attachments WHERE id = ANY($1::uuid[])`,
      [[viaService, viaSuperuser]],
    )
    expect(Number(rows[0]!.n)).toBe(2)
  })
})
