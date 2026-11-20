import { describe, expect, it } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import {
  assertCanManageServiceAccounts,
  listServiceAccounts,
  scopesNotHeld,
  serviceAccountDatabaseFailure,
  type ServiceAccountCaller,
} from '../service'

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const caller: ServiceAccountCaller = {
  userId: 'user-1',
  scopes: ['service_accounts:manage', 'invoices:read'],
  serviceAccount: null,
  actor: { type: 'api_key', label: 'Admin key' },
}

function row(id: string, sponsor: string, revokedAt: string | null = null) {
  return {
    id,
    company_id: COMPANY_ID,
    name: `Konto ${id}`,
    sponsor_user_id: sponsor,
    created_by: 'user-1',
    created_at: '2026-10-16T08:00:00Z',
    revoked_at: revokedAt,
    revoked_by: revokedAt ? 'user-1' : null,
  }
}

describe('serviceAccountDatabaseFailure', () => {
  it('maps a refusal raised with its code as the message prefix', () => {
    expect(serviceAccountDatabaseFailure({ code: '55000', message: 'SERVICE_ACCOUNT_REVOKED: the service account is revoked' })).toEqual({
      ok: false,
      code: 'SERVICE_ACCOUNT_REVOKED',
    })
  })

  it('maps the live-name unique violation', () => {
    expect(serviceAccountDatabaseFailure({ code: '23505', message: 'duplicate key value' })).toEqual({
      ok: false,
      code: 'SERVICE_ACCOUNT_NAME_TAKEN',
    })
  })

  it('leaves every other error to the caller', () => {
    expect(serviceAccountDatabaseFailure({ code: '57014', message: 'canceling statement due to statement timeout' })).toBeNull()
    expect(serviceAccountDatabaseFailure({ message: 'SOMETHING_ELSE: x' })).toBeNull()
    expect(serviceAccountDatabaseFailure(null)).toBeNull()
  })
})

describe('scopesNotHeld', () => {
  it('names each requested scope the calling key lacks', () => {
    expect(scopesNotHeld(['invoices:read', 'payroll:write', 'reports:read'], ['invoices:read'])).toEqual([
      'payroll:write',
      'reports:read',
    ])
    expect(scopesNotHeld(['invoices:read'], ['invoices:read', 'invoices:write'])).toEqual([])
  })
})

describe('assertCanManageServiceAccounts', () => {
  it("refuses a service account's key before reading anything", async () => {
    const mock = createTableMockSupabase()
    const refusal = await assertCanManageServiceAccounts(mock.supabase as never, COMPANY_ID, {
      ...caller,
      serviceAccount: { id: 'sa-1', name: 'Synk' },
    })
    expect(refusal).toMatchObject({ code: 'SERVICE_ACCOUNT_KEY_NOT_PERMITTED' })
    expect(mock.tables()).toEqual([])
  })

  it('lets an owner or admin through and refuses every other role', async () => {
    for (const [role, allowed] of [['owner', true], ['admin', true], ['member', false], ['viewer', false]] as const) {
      const mock = createTableMockSupabase({ company_members: { data: { role } } })
      const refusal = await assertCanManageServiceAccounts(mock.supabase as never, COMPANY_ID, caller)
      expect(refusal === null, role).toBe(allowed)
    }
  })
})

describe('listServiceAccounts status', () => {
  it('reports suspended for a demoted or departed sponsor and for an archived company', async () => {
    const mock = createTableMockSupabase({
      service_accounts: {
        data: [row('a', 'admin-1'), row('b', 'member-1'), row('c', 'gone-1'), row('d', 'admin-1', '2026-10-16T09:00:00Z')],
      },
      company_members: {
        data: [
          { user_id: 'admin-1', role: 'admin' },
          { user_id: 'member-1', role: 'member' },
        ],
      },
      companies: { data: { archived_at: null } },
    })
    const accounts = await listServiceAccounts(mock.supabase as never, COMPANY_ID)
    expect(accounts.map((a) => [a.id, a.status])).toEqual([
      ['a', 'active'],
      ['b', 'suspended'],
      ['c', 'suspended'],
      ['d', 'revoked'],
    ])

    mock.setTable('companies', { data: { archived_at: '2026-10-16T10:00:00Z' } })
    const archived = await listServiceAccounts(mock.supabase as never, COMPANY_ID)
    expect(archived.find((a) => a.id === 'a')?.status).toBe('suspended')
  })
})
