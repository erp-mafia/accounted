import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { normalizeOrgNumber, orgNumberKey, partyOrgKey } from '@/lib/invariants/org-number'
import { getPool, runAsServiceRole } from './setup'
import { seedCompany } from './fixtures'

/**
 * public.org_number_key, public.party_org_key and public.normalize_org_number
 * (20261101120000): the SQL side of lib/invariants/org-number.ts. One table of
 * written forms through both languages, then the writes that read the key: the
 * party link trigger, the provider migration and the customer merge.
 *
 * LEGAL passes the check digit; PERSON is a fabricated samordningsnummer.
 */
const LEGAL = '5566778899'
const PERSON = '8003740118'

const WRITTEN_FORMS: Array<string | null> = [
  LEGAL,
  '556677-8899',
  '556677 8899',
  ' 556677 - 8899 ',
  `16${LEGAL}`,
  '16556677-8899',
  `83${LEGAL}`,
  `${LEGAL}01`,
  `BE${LEGAL}`,
  `FR${LEGAL}`,
  `be${LEGAL}`,
  'NO 923 609 016',
  PERSON,
  '800374-0118',
  '800374+0118',
  '800374 + 0118',
  `19${PERSON}`,
  '19800374-0118',
  `18${PERSON}`,
  `20${PERSON}`,
  '5566778898',
  '12345',
  '55667788990',
  'saknas',
  '-',
  '',
  null,
]

async function sqlValue(fn: string, raw: string | null): Promise<string | null> {
  const { rows } = await getPool().query<{ value: string | null }>(`SELECT public.${fn}($1) AS value`, [raw])
  return rows[0]!.value
}

type Seeded = { userId: string; companyId: string }

async function customer(c: Seeded, org: string, customerType = 'swedish_business'): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.customers (company_id, user_id, name, customer_type, org_number)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [c.companyId, c.userId, `Kund ${randomUUID()}`, customerType, org],
  )
  return rows[0]!.id
}

async function migrationJob(c: Seeded): Promise<string> {
  const consent = randomUUID()
  const pool = getPool()
  await pool.query(
    `INSERT INTO public.provider_consents (id, company_id, name, provider, org_number) VALUES ($1, $2, 'Nyckeln', 'visma', $3)`,
    [consent, c.companyId, LEGAL],
  )
  await pool.query(
    `INSERT INTO public.provider_consent_tokens (consent_id, provider, access_token) VALUES ($1, 'visma', 'not-a-real-token')`,
    [consent],
  )
  await pool.query(
    `INSERT INTO public.sie_imports (company_id, user_id, filename, file_hash, sie_type, status)
     VALUES ($1::uuid, $2, 'test.se', md5($1::uuid::text), 4, 'completed')`,
    [c.companyId, c.userId],
  )
  return runAsServiceRole(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `SELECT (public.create_provider_migration_job($1, $2, $3, ARRAY['customers'], NULL)).id AS id`,
      [c.companyId, c.userId, consent],
    )
    return rows[0]!.id
  })
}

async function resolveParty(jobId: string, sourceId: string, org: string): Promise<string> {
  return runAsServiceRole(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `SELECT public.resolve_provider_migration_party($1, 'customers', $2, $3::jsonb) AS id`,
      [jobId, sourceId, JSON.stringify({ name: 'Från leverantören', customer_type: 'swedish_business', org_number: org })],
    )
    return rows[0]!.id
  })
}

type MergeAnswer = { ok: boolean; code?: string; details?: Record<string, unknown> }

function mergePreview(c: Seeded, survivor: string, merged: string[]): Promise<MergeAnswer> {
  return runAsServiceRole(async (client) =>
    (await client.query<{ r: MergeAnswer }>(`SELECT public.customer_merge_preview($1, $2, $3::uuid[], $4) AS r`,
      [c.companyId, survivor, merged, c.userId])).rows[0]!.r)
}

describe('one key in both languages', () => {
  it.each(WRITTEN_FORMS.map((form) => [form]))('%j reads the same in SQL and TypeScript', async (form) => {
    expect(await sqlValue('org_number_key', form)).toBe(orgNumberKey(form))
    expect(await sqlValue('party_org_key', form)).toBe(partyOrgKey(form))
    expect(await sqlValue('normalize_org_number', form)).toBe(normalizeOrgNumber(form))
  })

  it('a 12-digit value without a century is not cut to the number at its tail', async () => {
    expect(await sqlValue('normalize_org_number', `83${LEGAL}`)).toBeNull()
    expect(await sqlValue('normalize_org_number', `16${LEGAL}`)).toBe(LEGAL)
  })
})

describe('the party a role row links to', () => {
  it('a 12-digit value without a century writes no org number onto the party', async () => {
    const c = await seedCompany()
    const id = await customer(c, `83${LEGAL}`)
    const { rows } = await getPool().query<{ org_number: string | null }>(
      `SELECT p.org_number FROM public.customers k JOIN public.parties p ON p.id = k.party_id WHERE k.id = $1`,
      [id],
    )
    expect(rows[0]!.org_number).toBeNull()
  })

  it('the century form of a company lands on the party of its 10-digit form', async () => {
    const c = await seedCompany()
    const first = await customer(c, LEGAL)
    const second = await customer(c, `16${LEGAL}`)
    const { rows } = await getPool().query<{ party_id: string }>(
      `SELECT party_id FROM public.customers WHERE id = ANY($1::uuid[])`, [[first, second]])
    expect(new Set(rows.map((row) => row.party_id)).size).toBe(1)
  })
})

describe('resolve_provider_migration_party', () => {
  it.each([`16${LEGAL}`, '556677-8899', LEGAL])('adopts the card holding the same number written %s', async (written) => {
    const c = await seedCompany()
    const card = await customer(c, LEGAL)
    const job = await migrationJob(c)
    expect(await resolveParty(job, 'src-1', written)).toBe(card)
  })

  it('never adopts a card of another country with the same digits', async () => {
    const c = await seedCompany()
    const card = await customer(c, `BE${LEGAL}`, 'eu_business')
    const job = await migrationJob(c)
    expect(await resolveParty(job, 'src-2', `FR${LEGAL}`)).not.toBe(card)
    expect(await resolveParty(job, 'src-3', `be${LEGAL}`)).toBe(card)
  })

  it('never adopts on a value that names no number at all', async () => {
    const c = await seedCompany()
    const job = await migrationJob(c)
    const first = await resolveParty(job, 'src-4', '-')
    const second = await resolveParty(job, 'src-5', '--')
    expect(first).not.toBe(second)
  })
})

describe('customer_merge_preview', () => {
  it('sees two cards of one number as one identity, in any written form', async () => {
    const c = await seedCompany()
    const survivor = await customer(c, LEGAL)
    expect(await mergePreview(c, survivor, [await customer(c, `16${LEGAL}`)])).toMatchObject({ ok: true })
    expect(await mergePreview(c, survivor, [await customer(c, '556677-8899')])).toMatchObject({ ok: true })
  })

  it('refuses 83 + a number against that number: the tail is not the identity', async () => {
    const c = await seedCompany()
    const survivor = await customer(c, LEGAL)
    expect(await mergePreview(c, survivor, [await customer(c, `83${LEGAL}`)]))
      .toMatchObject({ ok: false, code: 'CUSTOMER_MERGE_IDENTITY_CONFLICT', details: { field: 'org_number' } })
  })

  it('refuses two countries with the same digits', async () => {
    const c = await seedCompany()
    const survivor = await customer(c, `BE${LEGAL}`, 'eu_business')
    expect(await mergePreview(c, survivor, [await customer(c, `FR${LEGAL}`, 'eu_business')]))
      .toMatchObject({ ok: false, code: 'CUSTOMER_MERGE_IDENTITY_CONFLICT', details: { field: 'org_number' } })
  })
})
