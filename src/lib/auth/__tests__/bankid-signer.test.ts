import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'

const mock = vi.hoisted(() => ({ supabase: null as unknown }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => mock.supabase }))
vi.mock('@/lib/auth/bankid', () => ({
  encryptPersonalNumberForStorage: (v: string) => `enc:${v}`,
  decryptStoredPersonalNumber: (v: string) => v.replace(/^enc:/, ''),
}))

import { hasSignerOnFile, rememberSignerPersonalNumber, signerPersonalNumberOnFile } from '../bankid-signer'

let db: ReturnType<typeof createTableMockSupabase>
beforeEach(() => {
  db = createTableMockSupabase({ bankid_identities: { data: null }, payment_signers: { data: null } })
  mock.supabase = db.supabase
})

describe('the signer on file', () => {
  it('is the BankID login first, else the remembered number, else nothing', async () => {
    expect(await signerPersonalNumberOnFile('u1')).toBeNull()
    expect(await hasSignerOnFile('u1')).toBe(false)

    db.setTable('payment_signers', { data: { user_id: 'u1', personal_number_enc: 'enc:198001019879' } })
    expect(await signerPersonalNumberOnFile('u1')).toBe('198001019879')
    expect(await hasSignerOnFile('u1')).toBe(true)

    db.setTable('bankid_identities', { data: { user_id: 'u1', personal_number_enc: 'enc:199001012385' } })
    expect(await signerPersonalNumberOnFile('u1')).toBe('199001012385')
  })

  it('remembers a valid typed number encrypted, and ignores an invalid one', async () => {
    await rememberSignerPersonalNumber('u1', '800101-9879')
    const [row] = db.findCall('payment_signers', 'upsert') as [Record<string, unknown>]
    expect(row).toMatchObject({ user_id: 'u1', personal_number_enc: 'enc:198001019879' })

    db.reset()
    await rememberSignerPersonalNumber('u1', 'not-a-number')
    expect(db.findCall('payment_signers', 'upsert')).toBeUndefined()
  })
})
