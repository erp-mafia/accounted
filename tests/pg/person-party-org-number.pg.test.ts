import { describe, expect, it } from 'vitest'
import { getPool } from './setup'
import { seedCompany } from './fixtures'

// Synthetic personnummer (Luhn-valid, as normalize_org_number requires);
// the party stores the 10-digit form.
const PNR = '900101-1239'
const PNR10 = '9001011239'
const SEALED = 'ab'.repeat(40)

async function party(id: string) {
  const { rows } = await getPool().query<{ org_number: string | null; kind: string }>(
    `SELECT org_number, kind FROM public.parties WHERE id = $1`,
    [id],
  )
  return rows[0] ?? null
}

async function lastPartyAudit(id: string) {
  const { rows } = await getPool().query<{ old_state: Record<string, unknown>; new_state: Record<string, unknown> }>(
    `SELECT old_state, new_state FROM public.audit_log
     WHERE table_name = 'parties' AND record_id = $1 AND action = 'UPDATE'
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    [id],
  )
  return rows[0] ?? null
}

async function businessCard(companyId: string, userId: string, name = 'Anna Andersson') {
  const { rows } = await getPool().query<{ id: string; party_id: string }>(
    `INSERT INTO public.customers (company_id, user_id, name, org_number, customer_type)
     VALUES ($1, $2, $3, $4, 'swedish_business') RETURNING id, party_id`,
    [companyId, userId, name, PNR],
  )
  return rows[0]!
}

async function retypeAsPerson(cardId: string) {
  await getPool().query(
    `UPDATE public.customers SET customer_type = 'individual', org_number = NULL, personal_number = $2 WHERE id = $1`,
    [cardId, SEALED],
  )
}

describe('a private customer card never leaves its personnummer on its party (pg)', () => {
  it('turns the party of a card retyped as a private person into a person without a number, and audits it without the number', async () => {
    const c = await seedCompany()
    const card = await businessCard(c.companyId, c.userId)
    expect(await party(card.party_id)).toEqual({ org_number: PNR10, kind: 'company' })

    await retypeAsPerson(card.id)

    expect(await party(card.party_id)).toEqual({ org_number: null, kind: 'person' })
    const audit = await lastPartyAudit(card.party_id)
    expect(audit!.old_state).toMatchObject({ org_number_set: true, kind: 'company' })
    expect(audit!.old_state).not.toHaveProperty('org_number')
    expect(JSON.stringify(audit)).not.toContain(PNR10)
  })

  it('keeps the number on a party a supplier also uses: a sole trader is identified by it', async () => {
    const c = await seedCompany()
    const s = await getPool().query<{ party_id: string }>(
      `INSERT INTO public.suppliers (company_id, user_id, name, org_number) VALUES ($1, $2, 'Anna Andersson Konsult', $3) RETURNING party_id`,
      [c.companyId, c.userId, PNR],
    )
    const card = await businessCard(c.companyId, c.userId)
    expect(card.party_id).toBe(s.rows[0]!.party_id)

    await retypeAsPerson(card.id)

    expect(await party(card.party_id)).toEqual({ org_number: PNR10, kind: 'company' })
  })

  it('keeps the number on a party another business card still uses', async () => {
    const c = await seedCompany()
    const card = await businessCard(c.companyId, c.userId)
    const other = await businessCard(c.companyId, c.userId, 'Anna Andersson Firma')
    expect(other.party_id).toBe(card.party_id)

    await retypeAsPerson(card.id)

    expect(await party(card.party_id)).toEqual({ org_number: PNR10, kind: 'company' })
  })

  it('still records the old number when a company party loses its org number', async () => {
    const c = await seedCompany()
    const s = await getPool().query<{ party_id: string }>(
      `INSERT INTO public.suppliers (company_id, user_id, name, org_number) VALUES ($1, $2, 'Beijer Byggmaterial AB', '556430-0142') RETURNING party_id`,
      [c.companyId, c.userId],
    )
    await getPool().query(`UPDATE public.parties SET org_number = NULL WHERE id = $1`, [s.rows[0]!.party_id])

    const audit = await lastPartyAudit(s.rows[0]!.party_id)
    expect(audit!.old_state).toMatchObject({ org_number: '5564300142' })
  })
})
