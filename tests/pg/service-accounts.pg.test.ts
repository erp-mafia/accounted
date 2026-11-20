import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  insertAuthUser,
  insertBalancedLines,
  insertCompany,
  insertCompanyMember,
  insertDraftJournalEntry,
  insertFiscalPeriod,
} from './fixtures'
import { getPool, withUserContext } from './setup'

/**
 * Service accounts with a human sponsor (migrations 20261016120000,
 * 20261016120100, 20261016120200).
 *
 * Locks in:
 *   - a service account needs an owner or admin sponsor, is created and
 *     revoked only by an owner or admin, and changes once: its revocation;
 *   - its keys belong to the sponsor (user_id) and the account's company,
 *     can only be minted through create_service_account_key, and keep both;
 *   - validate_and_increment_api_key answers a service-account key with the
 *     account's id and name and exactly its company, and refuses it while the
 *     account is suspended (sponsor demoted or gone) or revoked;
 *     service_account_key_refusal names the suspension;
 *   - revoking the account revokes its keys, and both land in audit_log with
 *     the acting credential;
 *   - every actor-type CHECK takes 'service_account' and is validated.
 */

async function seedAccountCompany() {
  const ownerId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: ownerId })
  await insertCompanyMember({ companyId, userId: ownerId, role: 'owner' })
  const adminId = await insertAuthUser()
  await insertCompanyMember({ companyId, userId: adminId, role: 'admin' })
  const memberId = await insertAuthUser()
  await insertCompanyMember({ companyId, userId: memberId, role: 'member' })
  return { ownerId, adminId, memberId, companyId }
}

interface AccountRow {
  id: string
  company_id: string
  name: string
  sponsor_user_id: string
  created_by: string
  revoked_at: Date | null
  revoked_by: string | null
}

async function createAccount(params: {
  companyId: string
  name?: string
  sponsorId: string
  createdBy: string
  actorType?: string | null
  actorLabel?: string | null
}): Promise<AccountRow> {
  const { rows } = await getPool().query<AccountRow>(
    `SELECT * FROM public.create_service_account($1, $2, $3, $4, $5, $6)`,
    [
      params.companyId,
      params.name ?? `Integration ${randomUUID().slice(0, 8)}`,
      params.sponsorId,
      params.createdBy,
      params.actorType ?? null,
      params.actorLabel ?? null,
    ],
  )
  return rows[0]!
}

function fakeHash(): string {
  return randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')
}

async function mintKey(params: {
  companyId: string
  accountId: string
  createdBy: string
  readOnly?: boolean
  scopes?: string[]
}): Promise<{ id: string; keyHash: string }> {
  const keyHash = fakeHash()
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT public.create_service_account_key($1, $2, $3, 'gnubok_sk_abcdefgh', 'Nattlig synk', $4,
       'live', $5, NULL, $6, 'api_key', 'Admin key') AS id`,
    [
      params.companyId,
      params.accountId,
      keyHash,
      params.scopes ?? ['invoices:read', 'invoices:write'],
      params.readOnly ?? false,
      params.createdBy,
    ],
  )
  return { id: rows[0]!.id, keyHash }
}

interface ValidateRow {
  user_id: string
  company_id: string | null
  allowed_company_ids: string[] | null
  read_only_company_ids: string[] | null
  service_account_id: string | null
  service_account_name: string | null
}

async function validate(keyHash: string): Promise<ValidateRow[]> {
  const { rows } = await getPool().query<ValidateRow>(
    `SELECT user_id, company_id, allowed_company_ids, read_only_company_ids,
            service_account_id, service_account_name
       FROM public.validate_and_increment_api_key($1)`,
    [keyHash],
  )
  return rows
}

async function refusal(keyHash: string): Promise<string | null> {
  const { rows } = await getPool().query<{ refusal: string | null }>(
    `SELECT public.service_account_key_refusal($1) AS refusal`,
    [keyHash],
  )
  return rows[0]!.refusal
}

describe('service accounts (pg)', () => {
  it('creates an account sponsored by an owner or admin, attributed to the acting credential', async () => {
    const { ownerId, adminId, companyId } = await seedAccountCompany()
    const account = await createAccount({
      companyId,
      name: '  Nattlig fakturasynk  ',
      sponsorId: adminId,
      createdBy: ownerId,
      actorType: 'api_key',
      actorLabel: 'Ägarens nyckel',
    })
    expect(account).toMatchObject({
      company_id: companyId,
      name: 'Nattlig fakturasynk',
      sponsor_user_id: adminId,
      created_by: ownerId,
      revoked_at: null,
      revoked_by: null,
    })

    const { rows } = await getPool().query(
      `SELECT action, user_id, company_id, actor_type, actor_label
         FROM public.audit_log WHERE table_name = 'service_accounts' AND record_id = $1`,
      [account.id],
    )
    expect(rows).toEqual([
      { action: 'INSERT', user_id: ownerId, company_id: companyId, actor_type: 'api_key', actor_label: 'Ägarens nyckel' },
    ])
  })

  it('refuses a member or outsider sponsor, a non-admin creator, and a second live account with the same name', async () => {
    const { ownerId, memberId, companyId } = await seedAccountCompany()
    const outsider = await insertAuthUser()

    await expect(createAccount({ companyId, sponsorId: memberId, createdBy: ownerId })).rejects.toThrow(
      /SERVICE_ACCOUNT_SPONSOR_INVALID/,
    )
    await expect(createAccount({ companyId, sponsorId: outsider, createdBy: ownerId })).rejects.toThrow(
      /SERVICE_ACCOUNT_SPONSOR_INVALID/,
    )
    await expect(createAccount({ companyId, sponsorId: ownerId, createdBy: memberId })).rejects.toThrow(
      /SERVICE_ACCOUNT_ADMIN_REQUIRED/,
    )

    await createAccount({ companyId, name: 'Synk', sponsorId: ownerId, createdBy: ownerId })
    await expect(createAccount({ companyId, name: 'SYNK', sponsorId: ownerId, createdBy: ownerId })).rejects.toMatchObject({
      code: '23505',
    })
  })

  it('lets admins and the sponsor read accounts through RLS, but not other members, and no session writes', async () => {
    const { ownerId, adminId, memberId, companyId } = await seedAccountCompany()
    const account = await createAccount({ companyId, sponsorId: adminId, createdBy: ownerId })

    const visibleTo = async (userId: string) =>
      withUserContext(userId, async (client) => {
        const { rows } = await client.query(`SELECT id FROM public.service_accounts WHERE id = $1`, [account.id])
        return rows.length
      })
    expect(await visibleTo(ownerId)).toBe(1)
    expect(await visibleTo(adminId)).toBe(1)
    expect(await visibleTo(memberId)).toBe(0)

    await expect(
      withUserContext(ownerId, (client) =>
        client.query(
          `INSERT INTO public.service_accounts (company_id, name, sponsor_user_id, created_by)
           VALUES ($1, 'Direkt', $2, $2)`,
          [companyId, ownerId],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' })
  })

  it('mints keys that belong to the sponsor and the company, and only through the RPC', async () => {
    const { ownerId, adminId, companyId } = await seedAccountCompany()
    const account = await createAccount({ companyId, sponsorId: adminId, createdBy: ownerId })
    const key = await mintKey({ companyId, accountId: account.id, createdBy: ownerId })

    const { rows } = await getPool().query(
      `SELECT user_id, company_id, service_account_id, name, scopes, revoked_at FROM public.api_keys WHERE id = $1`,
      [key.id],
    )
    expect(rows[0]).toEqual({
      user_id: adminId,
      company_id: companyId,
      service_account_id: account.id,
      name: 'Nattlig synk',
      scopes: ['invoices:read', 'invoices:write'],
      revoked_at: null,
    })
    const allowlist = await getPool().query(
      `SELECT company_id, access FROM public.api_key_companies WHERE api_key_id = $1`,
      [key.id],
    )
    expect(allowlist.rows).toEqual([{ company_id: companyId, access: 'write' }])

    // A user session never mints one, not even the sponsor for their own id.
    await expect(
      withUserContext(adminId, (client) =>
        client.query(
          `INSERT INTO public.api_keys (user_id, company_id, key_hash, key_prefix, name, scopes, service_account_id)
           VALUES ($1, $2, $3, 'gnubok_sk_x', 'x', '{invoices:read}', $4)`,
          [adminId, companyId, fakeHash(), account.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' })

    // Not for another user, even through the service role.
    await expect(
      getPool().query(
        `INSERT INTO public.api_keys (user_id, company_id, key_hash, key_prefix, name, scopes, service_account_id)
         VALUES ($1, $2, $3, 'gnubok_sk_x', 'x', '{invoices:read}', $4)`,
        [ownerId, companyId, fakeHash(), account.id],
      ),
    ).rejects.toThrow(/belongs to its sponsor and its company/)

    // The account, sponsor and company of a key are fixed.
    await expect(
      getPool().query(`UPDATE public.api_keys SET service_account_id = NULL WHERE id = $1`, [key.id]),
    ).rejects.toThrow(/service_account_id is fixed/)
    await expect(
      getPool().query(`UPDATE public.api_keys SET user_id = $2 WHERE id = $1`, [key.id, ownerId]),
    ).rejects.toThrow(/keeps its sponsor and company/)
  })

  it('caps an account at five live keys', async () => {
    const { ownerId, companyId } = await seedAccountCompany()
    const account = await createAccount({ companyId, sponsorId: ownerId, createdBy: ownerId })
    for (let i = 0; i < 5; i++) await mintKey({ companyId, accountId: account.id, createdBy: ownerId })
    await expect(mintKey({ companyId, accountId: account.id, createdBy: ownerId })).rejects.toThrow(
      /SERVICE_ACCOUNT_KEY_LIMIT/,
    )
  })

  it('validates a key as the account in exactly its company, read-only when minted so', async () => {
    const { ownerId, adminId, companyId } = await seedAccountCompany()
    // The sponsor also owns another company: the key must never reach it.
    const otherCompany = await insertCompany({ createdBy: adminId })
    await insertCompanyMember({ companyId: otherCompany, userId: adminId, role: 'owner' })

    const account = await createAccount({ companyId, name: 'Läsande agent', sponsorId: adminId, createdBy: ownerId })
    const key = await mintKey({ companyId, accountId: account.id, createdBy: ownerId, readOnly: true })

    expect(await validate(key.keyHash)).toEqual([
      {
        user_id: adminId,
        company_id: companyId,
        allowed_company_ids: [companyId],
        read_only_company_ids: [companyId],
        service_account_id: account.id,
        service_account_name: 'Läsande agent',
      },
    ])

    // Removing the allowlist row does not widen the key's reach.
    await getPool().query(`DELETE FROM public.api_key_companies WHERE api_key_id = $1`, [key.id])
    const [row] = await validate(key.keyHash)
    expect(row).toMatchObject({ allowed_company_ids: [companyId], read_only_company_ids: null })
    expect(await refusal(key.keyHash)).toBeNull()
  })

  it('suspends the account while its sponsor is not an owner or admin, and resumes when they are again', async () => {
    const { ownerId, adminId, companyId } = await seedAccountCompany()
    const account = await createAccount({ companyId, sponsorId: adminId, createdBy: ownerId })
    const key = await mintKey({ companyId, accountId: account.id, createdBy: ownerId })
    expect(await validate(key.keyHash)).toHaveLength(1)

    await getPool().query(`UPDATE public.company_members SET role = 'member' WHERE company_id = $1 AND user_id = $2`, [
      companyId,
      adminId,
    ])
    expect(await validate(key.keyHash)).toEqual([])
    expect(await refusal(key.keyHash)).toBe('SERVICE_ACCOUNT_SUSPENDED')
    await expect(mintKey({ companyId, accountId: account.id, createdBy: ownerId })).rejects.toThrow(
      /SERVICE_ACCOUNT_SUSPENDED/,
    )

    await getPool().query(`UPDATE public.company_members SET role = 'admin' WHERE company_id = $1 AND user_id = $2`, [
      companyId,
      adminId,
    ])
    expect(await validate(key.keyHash)).toHaveLength(1)

    // A sponsor who leaves the company suspends it too.
    await getPool().query(`DELETE FROM public.company_members WHERE company_id = $1 AND user_id = $2`, [companyId, adminId])
    expect(await validate(key.keyHash)).toEqual([])
    expect(await refusal(key.keyHash)).toBe('SERVICE_ACCOUNT_SUSPENDED')
  })

  it('answers no refusal for a person key or an unknown hash', async () => {
    const { ownerId, companyId } = await seedAccountCompany()
    const keyHash = fakeHash()
    await getPool().query(
      `INSERT INTO public.api_keys (user_id, company_id, key_hash, key_prefix, name, scopes)
       VALUES ($1, $2, $3, 'gnubok_sk_p', 'Person', '{invoices:read}')`,
      [ownerId, companyId, keyHash],
    )
    const [row] = await validate(keyHash)
    expect(row).toMatchObject({ user_id: ownerId, service_account_id: null, service_account_name: null })
    expect(await refusal(keyHash)).toBeNull()
    expect(await refusal(fakeHash())).toBeNull()
  })

  it('revokes the keys with the account, finally and idempotently, and audits both', async () => {
    const { ownerId, adminId, memberId, companyId } = await seedAccountCompany()
    const account = await createAccount({ companyId, sponsorId: adminId, createdBy: ownerId })
    const keyA = await mintKey({ companyId, accountId: account.id, createdBy: ownerId })
    const keyB = await mintKey({ companyId, accountId: account.id, createdBy: ownerId })

    await expect(
      getPool().query(`SELECT * FROM public.revoke_service_account($1, $2, $3, NULL, NULL)`, [companyId, account.id, memberId]),
    ).rejects.toThrow(/SERVICE_ACCOUNT_ADMIN_REQUIRED/)

    const revoked = await getPool().query<AccountRow>(
      `SELECT * FROM public.revoke_service_account($1, $2, $3, 'api_key', 'Ägarens nyckel')`,
      [companyId, account.id, ownerId],
    )
    expect(revoked.rows[0]).toMatchObject({ id: account.id, revoked_by: ownerId })
    expect(revoked.rows[0]!.revoked_at).not.toBeNull()

    const keys = await getPool().query<{ id: string; revoked_at: Date | null }>(
      `SELECT id, revoked_at FROM public.api_keys WHERE service_account_id = $1`,
      [account.id],
    )
    expect(keys.rows.every((k) => k.revoked_at?.getTime() === revoked.rows[0]!.revoked_at!.getTime())).toBe(true)
    expect(await validate(keyA.keyHash)).toEqual([])
    expect(await validate(keyB.keyHash)).toEqual([])
    expect(await refusal(keyA.keyHash)).toBeNull()

    // Idempotent, final, and no new keys.
    const again = await getPool().query<AccountRow>(
      `SELECT * FROM public.revoke_service_account($1, $2, $3, NULL, NULL)`,
      [companyId, account.id, ownerId],
    )
    expect(again.rows[0]!.revoked_at!.getTime()).toBe(revoked.rows[0]!.revoked_at!.getTime())
    await expect(
      getPool().query(`UPDATE public.service_accounts SET revoked_at = NULL, revoked_by = NULL WHERE id = $1`, [account.id]),
    ).rejects.toThrow(/revoked service account is final/)
    await expect(mintKey({ companyId, accountId: account.id, createdBy: ownerId })).rejects.toThrow(
      /SERVICE_ACCOUNT_REVOKED/,
    )

    const audit = await getPool().query(
      `SELECT action, user_id, actor_type, actor_label FROM public.audit_log
        WHERE table_name = 'service_accounts' AND record_id = $1 ORDER BY created_at, id`,
      [account.id],
    )
    expect(audit.rows.map((r) => r.action)).toEqual(['INSERT', 'UPDATE'])
    expect(audit.rows[1]).toMatchObject({ user_id: ownerId, actor_type: 'api_key', actor_label: 'Ägarens nyckel' })

    // A revoked account's name is free again.
    await expect(
      createAccount({ companyId, name: account.name, sponsorId: ownerId, createdBy: ownerId }),
    ).resolves.toMatchObject({ name: account.name })
  })

  it('refuses any change but the revocation, and a revoked account at creation', async () => {
    const { ownerId, adminId, companyId } = await seedAccountCompany()
    const account = await createAccount({ companyId, sponsorId: adminId, createdBy: ownerId })
    await expect(
      getPool().query(`UPDATE public.service_accounts SET name = 'Annat' WHERE id = $1`, [account.id]),
    ).rejects.toThrow(/only change a service account takes is its revocation/)
    await expect(
      getPool().query(`UPDATE public.service_accounts SET sponsor_user_id = $2 WHERE id = $1`, [account.id, ownerId]),
    ).rejects.toThrow(/only change a service account takes is its revocation/)
    await expect(
      getPool().query(
        `INSERT INTO public.service_accounts (company_id, name, sponsor_user_id, created_by, revoked_at)
         VALUES ($1, 'Redan återkallad', $2, $2, now())`,
        [companyId, ownerId],
      ),
    ).rejects.toThrow(/cannot be revoked/)
  })

  it('revokes one key of an account, idempotently, and nothing outside it', async () => {
    const { ownerId, companyId } = await seedAccountCompany()
    const account = await createAccount({ companyId, sponsorId: ownerId, createdBy: ownerId })
    const other = await createAccount({ companyId, sponsorId: ownerId, createdBy: ownerId })
    const key = await mintKey({ companyId, accountId: account.id, createdBy: ownerId })
    const otherKey = await mintKey({ companyId, accountId: other.id, createdBy: ownerId })

    const revoke = (apiKeyId: string, accountId: string) =>
      getPool().query<{ revoked_at: Date | null }>(
        `SELECT public.revoke_service_account_key($1, $2, $3, $4, 'api_key', 'Ägarens nyckel') AS revoked_at`,
        [companyId, accountId, apiKeyId, ownerId],
      )

    // Another account's key through this account: not found, untouched.
    expect((await revoke(otherKey.id, account.id)).rows[0]!.revoked_at).toBeNull()
    expect(await validate(otherKey.keyHash)).toHaveLength(1)

    const first = (await revoke(key.id, account.id)).rows[0]!.revoked_at
    expect(first).not.toBeNull()
    expect((await revoke(key.id, account.id)).rows[0]!.revoked_at!.getTime()).toBe(first!.getTime())
    expect(await validate(key.keyHash)).toEqual([])

    const audit = await getPool().query(
      `SELECT actor_type, actor_label FROM public.audit_log
        WHERE table_name = 'api_keys' AND record_id = $1 AND action = 'UPDATE'`,
      [key.id],
    )
    expect(audit.rows).toEqual([{ actor_type: 'api_key', actor_label: 'Ägarens nyckel' }])
  })

  it('keeps every write RPC and helper out of reach of anon and authenticated', async () => {
    const signatures = [
      'public.service_account_is_active(uuid)',
      'public.service_account_key_refusal(text)',
      'public.service_account_actor_is_admin(uuid, uuid)',
      'public.create_service_account(uuid, text, uuid, uuid, text, text)',
      'public.revoke_service_account(uuid, uuid, uuid, text, text)',
      'public.create_service_account_key(uuid, uuid, text, text, text, text[], text, boolean, timestamptz, uuid, text, text)',
      'public.revoke_service_account_key(uuid, uuid, uuid, uuid, text, text)',
      'public.validate_and_increment_api_key(text)',
    ]
    for (const signature of signatures) {
      const { rows } = await getPool().query<{ anon: boolean; authenticated: boolean; service: boolean }>(
        `SELECT has_function_privilege('anon', $1, 'EXECUTE') AS anon,
                has_function_privilege('authenticated', $1, 'EXECUTE') AS authenticated,
                has_function_privilege('service_role', $1, 'EXECUTE') AS service`,
        [signature],
      )
      expect(rows[0], signature).toEqual({ anon: false, authenticated: false, service: true })
    }
  })
})

describe('actor type service_account (pg)', () => {
  it('is in every actor-type CHECK, and each is validated', async () => {
    const { rows } = await getPool().query<{ conname: string; convalidated: boolean; def: string }>(
      `SELECT conname, convalidated, pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE conname IN (
          'journal_entries_committed_actor_type_check',
          'pending_operations_actor_type_check',
          'audit_log_actor_type_check',
          'suggestion_log_actor_type_check',
          'journal_entry_rattelse_log_actor_type_check',
          'sie_imports_undo_actor_type_check'
        )
        ORDER BY conname`,
    )
    expect(rows.map((r) => r.conname)).toEqual([
      'audit_log_actor_type_check',
      'journal_entries_committed_actor_type_check',
      'journal_entry_rattelse_log_actor_type_check',
      'pending_operations_actor_type_check',
      'sie_imports_undo_actor_type_check',
      'suggestion_log_actor_type_check',
    ])
    for (const row of rows) {
      expect(row.convalidated, row.conname).toBe(true)
      expect(row.def, row.conname).toContain("'service_account'")
      expect(row.def, row.conname).toContain("'agent_chat'")
    }
  })

  it('stamps a commit by a service account on the entry and its audit row, acting for the sponsor', async () => {
    const { ownerId, adminId, companyId } = await seedAccountCompany()
    const fiscalPeriodId = await insertFiscalPeriod({ userId: ownerId, companyId })
    // The entry belongs to the key's user, which for a service account is its sponsor.
    const entryId = await insertDraftJournalEntry({ userId: adminId, companyId, fiscalPeriodId })
    await insertBalancedLines(entryId)

    await getPool().query(
      `SELECT voucher_number FROM public.commit_journal_entry(
         $1::uuid, $2::uuid, 'api_key', NULL, 'service_account', 'Nattlig fakturasynk')`,
      [companyId, entryId],
    )
    const entry = await getPool().query(
      `SELECT user_id, commit_method, committed_actor_type, committed_actor_label FROM public.journal_entries WHERE id = $1`,
      [entryId],
    )
    expect(entry.rows[0]).toEqual({
      user_id: adminId,
      commit_method: 'api_key',
      committed_actor_type: 'service_account',
      committed_actor_label: 'Nattlig fakturasynk',
    })
    const audit = await getPool().query(
      `SELECT user_id, actor_type, actor_label FROM public.audit_log WHERE record_id = $1 AND action = 'COMMIT'`,
      [entryId],
    )
    expect(audit.rows).toEqual([{ user_id: adminId, actor_type: 'service_account', actor_label: 'Nattlig fakturasynk' }])
  })

  it('still refuses an actor type outside the list', async () => {
    const { ownerId, companyId } = await seedAccountCompany()
    const fiscalPeriodId = await insertFiscalPeriod({ userId: ownerId, companyId })
    const entryId = await insertDraftJournalEntry({ userId: ownerId, companyId, fiscalPeriodId })
    await insertBalancedLines(entryId)
    await expect(
      getPool().query(
        `SELECT voucher_number FROM public.commit_journal_entry($1::uuid, $2::uuid, 'api_key', NULL, 'robot', 'x')`,
        [companyId, entryId],
      ),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('keeps a service account as the actor of an SIE import chunk and of a replacement undo', async () => {
    for (const fn of ['public.import_sie_chunk(uuid,uuid,uuid,integer,text,integer)', 'public.replace_sie_import_job(uuid,uuid,uuid,text,text,jsonb,uuid)']) {
      const { rows } = await getPool().query<{ def: string }>(
        `SELECT pg_get_functiondef($1::regprocedure) AS def`,
        [fn],
      )
      expect(rows[0]!.def, fn).toContain("('user','api_key','mcp_oauth','cron','system','agent_chat','service_account')")
    }
  })
})
