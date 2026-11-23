import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, runAsServiceRole, withUserContext } from './setup'
import { insertCompanyMember, seedCompany, setActiveCompany } from './fixtures'

/**
 * guard_document_storage_path (20261123092000): a member's document row keeps
 * storage_path inside its own company. The company folder is allowed, and so
 * is a key another row of the same company already holds (a copy of a stored
 * file, a legacy uploader key); any other key is refused with 42501. Server
 * code (the service role) is not checked. The TypeScript side of the same
 * rule is src/lib/core/documents/storage-key.ts.
 */

const sha = () => randomUUID().replace(/-/g, '').padEnd(64, '0')

/** A document row written on the superuser connection, as fixtures are. */
async function seedDocument(userId: string, companyId: string, storagePath: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.document_attachments
       (id, user_id, company_id, storage_path, file_name, file_size_bytes, mime_type, sha256_hash)
     VALUES ($1, $2, $3, $4, 'kvitto.pdf', 1024, 'application/pdf', $5)`,
    [id, userId, companyId, storagePath, sha()],
  )
  return id
}

/** The member inserts a document row with this key through their own token. */
async function memberInsert(userId: string, companyId: string, storagePath: string): Promise<void> {
  await withUserContext(userId, (c) =>
    c.query(
      `INSERT INTO public.document_attachments
         (user_id, company_id, storage_path, file_name, file_size_bytes, mime_type, sha256_hash)
       VALUES ($1, $2, $3, 'kvitto.pdf', 1024, 'application/pdf', $4)`,
      [userId, companyId, storagePath, sha()],
    ),
  )
}

async function twoCompanies() {
  const a = await seedCompany()
  const b = await seedCompany()
  return {
    userA: a.userId,
    companyA: a.companyId,
    userB: b.userId,
    companyB: b.companyId,
  }
}

describe('guard_document_storage_path (pg)', () => {
  it('lets a member write a key in the company folder', async () => {
    const { userA, companyA } = await twoCompanies()
    await expect(memberInsert(userA, companyA, `documents/${companyA}/${userA}/1767000000000_kvitto.pdf`)).resolves.toBeUndefined()
  })

  it('refuses a key in another company folder', async () => {
    const { userA, companyA, userB, companyB } = await twoCompanies()
    const keyOfB = `documents/${companyB}/${userB}/1767000000000_faktura.pdf`
    await seedDocument(userB, companyB, keyOfB)
    await expect(memberInsert(userA, companyA, keyOfB)).rejects.toMatchObject({ code: '42501' })
  })

  it('refuses a legacy uploader key that no row of the company holds', async () => {
    const { userA, companyA, userB, companyB } = await twoCompanies()
    const legacyOfB = `documents/${userB}/1767000000000_faktura.pdf`
    await seedDocument(userB, companyB, legacyOfB)
    await expect(memberInsert(userA, companyA, legacyOfB)).rejects.toMatchObject({ code: '42501' })
    // The member's own legacy folder is no exception: the key names no company.
    await expect(memberInsert(userA, companyA, `documents/${userA}/1767000000000_kvitto.pdf`)).rejects.toMatchObject({ code: '42501' })
  })

  it('lets a member write a key another row of the same company holds', async () => {
    const { userA, companyA } = await twoCompanies()
    const legacyOfA = `documents/${userA}/1767000000000_kvitto.pdf`
    await seedDocument(userA, companyA, legacyOfA)
    await expect(memberInsert(userA, companyA, legacyOfA)).resolves.toBeUndefined()
  })

  it('judges a member of two companies by the row company, not the membership', async () => {
    const { userA, companyA, userB, companyB } = await twoCompanies()
    await insertCompanyMember({ companyId: companyB, userId: userA, role: 'member' })
    await setActiveCompany(userA, companyA)
    const legacyOfB = `documents/${userB}/1767000000000_faktura.pdf`
    await seedDocument(userB, companyB, legacyOfB)
    await expect(memberInsert(userA, companyA, legacyOfB)).rejects.toMatchObject({ code: '42501' })
  })

  it('refuses a key with an empty, "." or ".." part or a character a URL reads differently', async () => {
    const { userA, companyA, companyB } = await twoCompanies()
    const own = `documents/${companyA}`
    for (const key of [
      `${own}/../${companyB}/1767000000000_faktura.pdf`,
      `${own}/./1767000000000_kvitto.pdf`,
      `${own}//1767000000000_kvitto.pdf`,
      `${own}/`,
      `${own}/%2e%2e/${companyB}/1767000000000_faktura.pdf`,
      `${own}/..\\${companyB}/1767000000000_faktura.pdf`,
      `${own}/x.pdf?download=1`,
      `${own}/x.pdf#y`,
      `${own}/.\n./${companyB}/1767000000000_faktura.pdf`,
    ]) {
      await expect(memberInsert(userA, companyA, key), key).rejects.toMatchObject({ code: '42501' })
    }
  })

  it('refuses moving an own row onto another company key, and leaves other updates alone', async () => {
    const { userA, companyA, userB, companyB } = await twoCompanies()
    const keyOfB = `documents/${companyB}/${userB}/1767000000000_faktura.pdf`
    await seedDocument(userB, companyB, keyOfB)
    // An older row on a legacy key nothing else holds: its other columns stay writable.
    const legacyRow = await seedDocument(userA, companyA, `documents/${userA}/1767000000000_kvitto.pdf`)

    await expect(
      withUserContext(userA, (c) =>
        c.query(`UPDATE public.document_attachments SET storage_path = $2 WHERE id = $1`, [legacyRow, keyOfB]),
      ),
    ).rejects.toMatchObject({ code: '42501' })

    const renamed = await withUserContext(userA, (c) =>
      c.query(`UPDATE public.document_attachments SET file_name = 'kvitto-mars.pdf' WHERE id = $1 RETURNING id`, [legacyRow]),
    )
    expect(renamed.rowCount).toBe(1)

    // Naming the unchanged key in the update is no change either.
    const restated = await withUserContext(userA, (c) =>
      c.query(
        `UPDATE public.document_attachments SET storage_path = storage_path, file_name = 'kvitto-april.pdf' WHERE id = $1 RETURNING id`,
        [legacyRow],
      ),
    )
    expect(restated.rowCount).toBe(1)
  })

  it('keeps a new version in the company folder (create_document_version)', async () => {
    const { userA, companyA } = await twoCompanies()
    const original = await seedDocument(userA, companyA, `documents/${companyA}/${userA}/1767000000000_kvitto.pdf`)
    const version = (key: string) =>
      withUserContext(userA, (c) =>
        c.query(`SELECT public.create_document_version($1, $2, $3, 'kvitto-v2.pdf', 11, 'application/pdf', $4)`, [
          userA,
          original,
          key,
          sha(),
        ]),
      )
    await expect(version(`documents/${userA}/1767000000001_kvitto-v2.pdf`)).rejects.toMatchObject({ code: '42501' })
    await expect(version(`documents/${companyA}/${userA}/1767000000001_kvitto-v2.pdf`)).resolves.toBeTruthy()
  })

  it('leaves server code alone: the service role and the superuser write any key', async () => {
    const { userA, companyA, userB, companyB } = await twoCompanies()
    const keyOfB = `documents/${companyB}/${userB}/1767000000000_faktura.pdf`
    await seedDocument(userB, companyB, keyOfB)
    const id = randomUUID()
    await runAsServiceRole((c) =>
      c.query(
        `INSERT INTO public.document_attachments
           (id, user_id, company_id, storage_path, file_name, file_size_bytes, mime_type, sha256_hash)
         VALUES ($1, $2, $3, $4, 'kvitto.pdf', 1024, 'application/pdf', $5)`,
        [id, userA, companyA, `documents/${userA}/1767000000000_kvitto.pdf`, sha()],
      ),
    )
    await expect(seedDocument(userA, companyA, `test/${randomUUID()}.pdf`)).resolves.toBeTruthy()
    const { rows } = await getPool().query<{ n: string }>(`SELECT count(*) AS n FROM public.document_attachments WHERE id = $1`, [id])
    expect(Number(rows[0]!.n)).toBe(1)
  })
})
