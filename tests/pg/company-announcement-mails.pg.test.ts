import { describe, expect, it } from 'vitest'
import { getPool } from './setup'

// Migration 20261110030500 drops the send log of the removed one-time
// announcement mail (20261109180000). The founder does not want automated
// announcements to customers; the table must not come back.

describe('company_announcement_mails', () => {
  it('no longer exists', async () => {
    const { rows } = await getPool().query<{ t: string | null }>(
      `SELECT to_regclass('public.company_announcement_mails')::text AS t`,
    )
    expect(rows[0].t).toBeNull()
  })
})
