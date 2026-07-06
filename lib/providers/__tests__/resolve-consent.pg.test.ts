import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool } from '@/tests/pg/setup'
import { seedCompany } from '@/tests/pg/fixtures'

// Regression guard for a destructive bug: resolveConsent()'s optimistic
// concurrency guard ran `UPDATE provider_consent_tokens … .select('id')`, but
// this table's PRIMARY KEY is `consent_id` and it has NO `id` column. Postgres
// rejected the whole statement ("column provider_consent_tokens.id does not
// exist"), which surfaced as updateError AFTER the provider had already rotated
// the refresh token: permanently breaking the consent.
//
// Unit mocks can't catch this (they replay queued data regardless of the
// selected columns), so we assert the real query shapes against real Postgres.

async function seedConsentWithToken(): Promise<{ consentId: string; expiresAt: string }> {
  const { companyId } = await seedCompany()
  const consentId = randomUUID()
  const expiresAt = '2020-01-01T00:00:00.000Z'

  await getPool().query(
    `INSERT INTO provider_consents (id, company_id, name, status, provider)
     VALUES ($1, $2, $3, 1, 'fortnox')`,
    [consentId, companyId, `pg-real-${consentId}`],
  )
  await getPool().query(
    `INSERT INTO provider_consent_tokens
       (consent_id, provider, access_token, refresh_token, token_expires_at)
     VALUES ($1, 'fortnox', 'old-access', 'old-refresh', $2)`,
    [consentId, expiresAt],
  )
  return { consentId, expiresAt }
}

describe('provider_consent_tokens guarded update (pg-real)', () => {
  it('the rotation UPDATE … RETURNING consent_id is valid and matches the row', async () => {
    const { consentId, expiresAt } = await seedConsentWithToken()

    // This mirrors resolveConsent()'s guarded update exactly. `consent_id` is
    // the PK; selecting it must succeed and return the matched row.
    const { rows } = await getPool().query(
      `UPDATE provider_consent_tokens
          SET access_token = $1, refresh_token = $2, token_expires_at = $3
        WHERE consent_id = $4 AND token_expires_at = $5
        RETURNING consent_id`,
      ['new-access', 'new-refresh', '2030-01-01T00:00:00.000Z', consentId, expiresAt],
    )

    expect(rows).toHaveLength(1)
    expect(rows[0].consent_id).toBe(consentId)
  })

  it('there is no `id` column to select (proves why the old query broke)', async () => {
    const { consentId } = await seedConsentWithToken()

    await expect(
      getPool().query(
        `SELECT id FROM provider_consent_tokens WHERE consent_id = $1`,
        [consentId],
      ),
    ).rejects.toThrow(/column .*id.* does not exist/i)
  })
})
