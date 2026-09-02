import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { insertPostedJournalEntry, seedCompany } from './fixtures'

const ORG = '5564300142'
const OTHER_ORG = '5560125790'
const LOOPIA_ORG = '5566661012'

const expense = (account: string, amount: number) => [
  { accountNumber: account, debitAmount: amount, creditAmount: 0 },
  { accountNumber: '2440', debitAmount: 0, creditAmount: amount },
]

async function linkDocument(params: {
  companyId: string
  userId: string
  journalEntryId: string
  supplier: Record<string, string | null>
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.document_attachments (id, company_id, user_id, uploaded_by, storage_path, file_name, sha256_hash, mime_type, upload_source, journal_entry_id, extracted_data)
     VALUES ($1, $2, $3, $3, $4, 'f.pdf', md5($4), 'application/pdf', 'file_upload', $5, $6::jsonb)`,
    [id, params.companyId, params.userId, `docs/${id}.pdf`, params.journalEntryId, JSON.stringify({ supplier: params.supplier })],
  )
  return id
}

interface Evidence {
  key: string
  docs: number
  self_docs: number
  orgs: Array<{ org: string; n: number }>
  vat_numbers: Array<{ vat: string; n: number }>
  names: Array<{ name: string; n: number }>
  bankgiro: Array<{ value: string; n: number; first_seen: string; last_seen: string }>
  plusgiro: Array<{ value: string; n: number }>
}

async function evidence(companyId: string, userId: string): Promise<Evidence[]> {
  return withUserContext(userId, async (client) => {
    const { rows } = await client.query<{ r: Evidence[] }>(`SELECT public.get_ledger_key_evidence($1) AS r`, [companyId])
    return rows[0]!.r
  })
}

// Writes run on the pool connection (service presentation: auth.uid() NULL,
// committed). withUserContext rolls back and is used for RLS assertions only.
async function apply(companyId: string, userId: string, items: unknown[]) {
  const { rows } = await getPool().query<{ r: Record<string, number> }>(
    `SELECT public.apply_party_suggestions($1, $2, $3::jsonb) AS r`,
    [companyId, userId, JSON.stringify(items)],
  )
  return rows[0]!.r
}

async function decide(companyId: string, userId: string, ids: string[], kind: string, note: string | null = null): Promise<number> {
  const { rows } = await getPool().query<{ n: number }>(
    `SELECT public.decide_parties($1, $2, $3::uuid[], $4, $5) AS n`,
    [companyId, userId, ids, kind, note],
  )
  return rows[0]!.n
}

describe('get_ledger_key_evidence (pg)', () => {
  it('aggregates hard keys per ledger key and counts own-org documents as self_docs only', async () => {
    const c = await seedCompany()
    await getPool().query(`UPDATE public.companies SET org_number = '556430-0142' WHERE id = $1`, [c.companyId])
    const base = { userId: c.userId, companyId: c.companyId, fiscalPeriodId: c.fiscalPeriodId, sourceType: 'import' }
    const e1 = await insertPostedJournalEntry({ ...base, entryDate: '2026-01-10', description: 'Levfakt Loopia AB (17)', lines: expense('6540', 100) })
    const e2 = await insertPostedJournalEntry({ ...base, entryDate: '2026-02-10', description: 'Levfakt Loopia AB (17)', lines: expense('6540', 100) })
    const e3 = await insertPostedJournalEntry({ ...base, entryDate: '2026-03-10', description: 'Levfakt Loopia AB (17)', lines: expense('6540', 100) })
    await linkDocument({ ...c, journalEntryId: e1, supplier: { name: 'Loopia AB', orgNumber: '556666-1012', vatNumber: 'SE556666101201', bankgiro: '5317-0900', plusgiro: null } })
    await linkDocument({ ...c, journalEntryId: e2, supplier: { name: 'Loopia AB', orgNumber: LOOPIA_ORG, vatNumber: 'SE556666101201', bankgiro: '53170900', plusgiro: null } })
    // Own sales invoice uploaded as underlag: the company's own org number.
    await linkDocument({ ...c, journalEntryId: e3, supplier: { name: 'Me AB', orgNumber: ORG, vatNumber: null, bankgiro: '11112222', plusgiro: null } })

    const rows = await evidence(c.companyId, c.userId)
    const loopia = rows.find((r) => r.key === 'loopia')
    expect(loopia).toBeDefined()
    expect(loopia!.docs).toBe(3)
    expect(loopia!.self_docs).toBe(1)
    expect(loopia!.orgs).toEqual([{ org: LOOPIA_ORG, n: 2 }])
    expect(loopia!.vat_numbers).toEqual([{ vat: 'SE556666101201', n: 2 }])
    expect(loopia!.names).toEqual([{ name: 'Loopia AB', n: 2 }])
    expect(loopia!.bankgiro).toEqual([{ value: '53170900', n: 2, first_seen: '2026-01-10', last_seen: '2026-02-10' }])
    expect(loopia!.plusgiro).toEqual([])
  })

  it('is invisible across companies', async () => {
    const mine = await seedCompany()
    const theirs = await seedCompany()
    const e = await insertPostedJournalEntry({ userId: theirs.userId, companyId: theirs.companyId, fiscalPeriodId: theirs.fiscalPeriodId, sourceType: 'import', description: 'Levfakt Loopia AB', lines: expense('6540', 100) })
    await linkDocument({ ...theirs, journalEntryId: e, supplier: { name: 'Loopia AB', orgNumber: LOOPIA_ORG, vatNumber: null, bankgiro: null, plusgiro: null } })
    expect(await evidence(theirs.companyId, mine.userId)).toEqual([])
  })
})

describe('apply_party_suggestions (pg)', () => {
  it('inserts suggested parties, attaches by org and by alias key, and is idempotent', async () => {
    const c = await seedCompany()
    const item = (over: Record<string, unknown>) => ({
      key: 'loopia',
      display_name: 'Loopia AB',
      kind: 'company',
      origin: 'document',
      alias_keys: ['loopia'],
      reason: { attach: 'new', occurrences: 3 },
      facts: [{ field: 'dominant_account', value: { account: '6540' }, source: 'ledger' }],
      identities: [{ scheme: 'bankgiro', value: '53170900', first_seen: '2026-01-10', last_seen: '2026-02-10', seen_count: 1 }],
      ...over,
    })

    const first = await apply(c.companyId, c.userId, [item({ org_number: '556666-1012' })])
    expect(first).toEqual({ created: 1, attached: 0, identities: 1, facts: 1 })
    const party = await getPool().query<{ id: string; status: string; org_number: string; alias_keys: string[]; suggested_reason: { attach: string }; origin: string }>(
      `SELECT id, status, org_number, alias_keys, suggested_reason, origin FROM public.parties WHERE company_id = $1`,
      [c.companyId],
    )
    expect(party.rows).toHaveLength(1)
    expect(party.rows[0]).toMatchObject({ status: 'suggested', org_number: LOOPIA_ORG, alias_keys: ['loopia'], origin: 'document' })
    expect(party.rows[0]!.suggested_reason.attach).toBe('new')
    const partyId = party.rows[0]!.id

    // Same org under another key: attaches, unions aliases, promotes the identity to known.
    const second = await apply(c.companyId, c.userId, [
      item({ key: 'loopia webbhotell', alias_keys: ['loopia webbhotell'], org_number: LOOPIA_ORG, identities: [{ scheme: 'bankgiro', value: '53170900', first_seen: '2026-03-10', last_seen: '2026-03-10', seen_count: 2 }] }),
    ])
    expect(second).toEqual({ created: 0, attached: 1, identities: 1, facts: 0 })
    const after = await getPool().query<{ n: string; alias_keys: string[] }>(
      `SELECT (SELECT count(*) FROM public.parties WHERE company_id = $1)::text AS n, alias_keys FROM public.parties WHERE id = $2`,
      [c.companyId, partyId],
    )
    expect(after.rows[0]!.n).toBe('1')
    expect([...after.rows[0]!.alias_keys].sort()).toEqual(['loopia', 'loopia webbhotell'])
    const ident = await getPool().query<{ status: string; seen_count: number; first_seen: string; last_seen: string }>(
      `SELECT status, seen_count, first_seen::text, last_seen::text FROM public.party_identities WHERE party_id = $1`,
      [partyId],
    )
    expect(ident.rows).toEqual([{ status: 'known', seen_count: 2, first_seen: '2026-01-10', last_seen: '2026-03-10' }])

    // Exact alias key without org: attaches too. Re-running creates nothing new.
    const third = await apply(c.companyId, c.userId, [item({ key: 'loopia webbhotell', alias_keys: ['loopia webbhotell'] })])
    expect(third).toMatchObject({ created: 0, attached: 1, facts: 0 })
    const facts = await getPool().query(`SELECT 1 FROM public.party_facts WHERE party_id = $1`, [partyId])
    expect(facts.rowCount).toBe(1)
  })

  it('never merges on name: same core text becomes a second suggested party', async () => {
    const c = await seedCompany()
    await apply(c.companyId, c.userId, [{ key: 'fortnox', display_name: 'Fortnox AB', org_number: ORG }])
    await apply(c.companyId, c.userId, [{ key: 'fortnox finans', display_name: 'Fortnox Finans AB', org_number: OTHER_ORG }])
    await apply(c.companyId, c.userId, [{ key: 'fortnox ab', display_name: 'FORTNOX AB' }])
    const { rows } = await getPool().query<{ display_name: string }>(
      `SELECT display_name FROM public.parties WHERE company_id = $1 ORDER BY created_at`,
      [c.companyId],
    )
    expect(rows.map((r) => r.display_name)).toEqual(['Fortnox AB', 'Fortnox Finans AB', 'FORTNOX AB'])
  })

  it('rejects an explicit party_id from another company and a spoofed user id', async () => {
    const mine = await seedCompany()
    const theirs = await seedCompany()
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO public.parties (company_id, user_id, display_name) VALUES ($1, $2, 'Theirs') RETURNING id`,
      [theirs.companyId, theirs.userId],
    )
    await expect(apply(mine.companyId, mine.userId, [{ key: 'x', display_name: 'X', party_id: rows[0]!.id }])).rejects.toMatchObject({ code: '23503' })
    await expect(
      withUserContext(mine.userId, (client) =>
        client.query(`SELECT public.apply_party_suggestions($1, $2, '[]'::jsonb)`, [mine.companyId, theirs.userId]),
      ),
    ).rejects.toMatchObject({ code: '42501' })
    // RLS: a member of another company cannot write into mine.
    await expect(
      withUserContext(theirs.userId, (client) =>
        client.query(`SELECT public.apply_party_suggestions($1, $2, $3::jsonb)`, [mine.companyId, theirs.userId, JSON.stringify([{ key: 'x', display_name: 'X' }])]),
      ),
    ).rejects.toMatchObject({ code: '42501' })
  })
})

describe('decide_parties (pg)', () => {
  it('confirms and dismisses in bulk, logging one decision per party', async () => {
    const c = await seedCompany()
    await apply(c.companyId, c.userId, [
      { key: 'loopia', display_name: 'Loopia AB', reason: { attach: 'new' } },
      { key: 'beijer', display_name: 'Beijer AB', reason: { attach: 'new' } },
      { key: 'noise', display_name: 'Noise', reason: { attach: 'new' } },
    ])
    const ids = await getPool().query<{ id: string; display_name: string }>(
      `SELECT id, display_name FROM public.parties WHERE company_id = $1`,
      [c.companyId],
    )
    const byName = Object.fromEntries(ids.rows.map((r) => [r.display_name, r.id]))

    const confirmed = await decide(c.companyId, c.userId, [byName['Loopia AB']!, byName['Beijer AB']!], 'confirm', 'bulk from queue')
    expect(confirmed).toBe(2)
    const dismissed = await decide(c.companyId, c.userId, [byName['Noise']!], 'dismiss')
    expect(dismissed).toBe(1)

    const state = await getPool().query<{ display_name: string; status: string; archived: boolean; reason: unknown }>(
      `SELECT display_name, status, archived_at IS NOT NULL AS archived, suggested_reason AS reason FROM public.parties WHERE company_id = $1 ORDER BY display_name`,
      [c.companyId],
    )
    expect(state.rows).toEqual([
      { display_name: 'Beijer AB', status: 'confirmed', archived: false, reason: null },
      { display_name: 'Loopia AB', status: 'confirmed', archived: false, reason: null },
      { display_name: 'Noise', status: 'suggested', archived: true, reason: { attach: 'new' } },
    ])
    const decisions = await getPool().query<{ kind: string; n: string }>(
      `SELECT kind, count(*)::text AS n FROM public.party_decisions WHERE company_id = $1 GROUP BY kind ORDER BY kind`,
      [c.companyId],
    )
    expect(decisions.rows).toEqual([
      { kind: 'confirm', n: '2' },
      { kind: 'dismiss', n: '1' },
    ])

    // Second confirm of the same ids is a no-op: no duplicate decisions.
    const again = await decide(c.companyId, c.userId, [byName['Loopia AB']!], 'confirm')
    expect(again).toBe(0)
  })

  it('rejects unknown kinds and other companies', async () => {
    const mine = await seedCompany()
    const theirs = await seedCompany()
    await apply(theirs.companyId, theirs.userId, [{ key: 'loopia', display_name: 'Loopia AB' }])
    const { rows } = await getPool().query<{ id: string }>(`SELECT id FROM public.parties WHERE company_id = $1`, [theirs.companyId])
    await expect(
      withUserContext(mine.userId, (client) =>
        client.query(`SELECT public.decide_parties($1, $2, $3::uuid[], 'merge', NULL)`, [mine.companyId, mine.userId, [rows[0]!.id]]),
      ),
    ).rejects.toMatchObject({ code: '22023' })
    // Under RLS a member of another company sees no rows to update.
    const n = await withUserContext(mine.userId, async (client) => {
      const r = await client.query<{ n: number }>(`SELECT public.decide_parties($1, $2, $3::uuid[], 'confirm', NULL) AS n`, [
        theirs.companyId,
        mine.userId,
        [rows[0]!.id],
      ])
      return r.rows[0]!.n
    })
    expect(n).toBe(0)
    const still = await getPool().query<{ status: string }>(`SELECT status FROM public.parties WHERE id = $1`, [rows[0]!.id])
    expect(still.rows[0]!.status).toBe('suggested')
  })
})
