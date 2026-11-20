import { randomUUID } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { getPool, runAsServiceRole, withUserContext } from './setup'
import { insertAuthUser, insertCompanyMember, insertPostedJournalEntry, seedCompany } from './fixtures'

// pg-real coverage for 20261011120000_account_reconciliation_settlements:
// RLS (members read, owners/admins/members settle and undo as themselves,
// viewers look, another company's member reads and writes nothing, nobody
// deletes), the grants, the one-live-settlement-per-verifikat index, the
// freeze trigger (only the undo stamp changes, once), and that a settlement
// leaves the verifikat and the candidate RPCs exactly as they were: the
// reconciliation reader decides what a settlement means, never the ledger.
//
// The fixture is the shape of crm#1074: one verifikat that wrongly credits
// the bank account, and a rättelse booked by hand a month later, with no
// bank rows.

type Owner = Awaited<ReturnType<typeof seedCompany>>

async function wrongAndCorrection(owner: Owner): Promise<{ wrong: string; correction: string }> {
  const wrong = await insertPostedJournalEntry({
    ...owner,
    entryDate: '2026-03-18',
    description: 'Betalning bokad en gång för mycket',
    lines: [
      { accountNumber: '2440', debitAmount: 1250, creditAmount: 0 },
      { accountNumber: '1930', debitAmount: 0, creditAmount: 1250 },
    ],
  })
  const correction = await insertPostedJournalEntry({
    ...owner,
    entryDate: '2026-04-21',
    description: 'Rättelse av betalning bokad en gång för mycket',
    lines: [
      { accountNumber: '1930', debitAmount: 1250, creditAmount: 0 },
      { accountNumber: '2440', debitAmount: 0, creditAmount: 1250 },
    ],
  })
  return { wrong, correction }
}

async function insertSettlement(
  companyId: string,
  settledBy: string,
  entries: Array<{ id: string; amount: number }>,
  accountNumber = '1930',
): Promise<string> {
  const settlementId = randomUUID()
  for (const entry of entries) {
    await getPool().query(
      `INSERT INTO public.account_reconciliation_settlements
         (company_id, settlement_id, account_number, journal_entry_id, amount, settled_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [companyId, settlementId, accountNumber, entry.id, entry.amount, settledBy],
    )
  }
  return settlementId
}

const INSERT_ROW = `INSERT INTO public.account_reconciliation_settlements
     (company_id, settlement_id, account_number, journal_entry_id, amount, settled_by)
   VALUES ($1, $2, '1930', $3, $4, $5) RETURNING id`

describe('account_reconciliation_settlements RLS', () => {
  it('lets company members read; a member of another company sees and writes nothing', async () => {
    const owner = await seedCompany()
    const { wrong, correction } = await wrongAndCorrection(owner)
    const settlementId = await insertSettlement(owner.companyId, owner.userId, [
      { id: wrong, amount: -1250 },
      { id: correction, amount: 1250 },
    ])
    // A full member, but of ANOTHER company.
    const other = await seedCompany()

    const ownView = await withUserContext(owner.userId, (client) =>
      client.query(`SELECT id FROM public.account_reconciliation_settlements WHERE settlement_id = $1`, [settlementId]),
    )
    expect(ownView.rows).toHaveLength(2)

    const otherView = await withUserContext(other.userId, (client) =>
      client.query(`SELECT id FROM public.account_reconciliation_settlements WHERE settlement_id = $1`, [settlementId]),
    )
    expect(otherView.rows).toHaveLength(0)

    // Cannot settle in a company they do not belong to.
    await expect(
      withUserContext(other.userId, (client) =>
        client.query(INSERT_ROW, [owner.companyId, randomUUID(), wrong, -1250, other.userId]),
      ),
    ).rejects.toThrow(/row-level security/i)

    // Cannot undo there either: the row is invisible, so nothing is touched.
    const otherUndo = await withUserContext(other.userId, (client) =>
      client.query(
        `UPDATE public.account_reconciliation_settlements
            SET undone_at = now(), undone_by = $2
          WHERE settlement_id = $1`,
        [settlementId, other.userId],
      ),
    )
    expect(otherUndo.rowCount).toBe(0)
  })

  it('refuses a row in the own company that names another company\'s verifikat', async () => {
    const owner = await seedCompany()
    const other = await seedCompany()
    const foreign = await wrongAndCorrection(other)

    await expect(
      withUserContext(owner.userId, (client) =>
        client.query(INSERT_ROW, [owner.companyId, randomUUID(), foreign.wrong, -1250, owner.userId]),
      ),
    ).rejects.toThrow(/row-level security/i)
  })

  it('lets viewers read but not settle or undo', async () => {
    const owner = await seedCompany()
    const { wrong, correction } = await wrongAndCorrection(owner)
    const settlementId = await insertSettlement(owner.companyId, owner.userId, [
      { id: wrong, amount: -1250 },
      { id: correction, amount: 1250 },
    ])
    const viewer = await insertAuthUser()
    await insertCompanyMember({ companyId: owner.companyId, userId: viewer, role: 'viewer' })

    const read = await withUserContext(viewer, (client) =>
      client.query(`SELECT id FROM public.account_reconciliation_settlements WHERE settlement_id = $1`, [settlementId]),
    )
    expect(read.rows).toHaveLength(2)

    await expect(
      withUserContext(viewer, (client) => client.query(INSERT_ROW, [owner.companyId, randomUUID(), wrong, -1250, viewer])),
    ).rejects.toThrow(/row-level security/i)

    const undo = await withUserContext(viewer, (client) =>
      client.query(
        `UPDATE public.account_reconciliation_settlements SET undone_at = now(), undone_by = $2 WHERE settlement_id = $1`,
        [settlementId, viewer],
      ),
    )
    expect(undo.rowCount).toBe(0)
  })

  it('lets a member settle and undo as themselves, never as someone else, and never delete', async () => {
    const owner = await seedCompany()
    const { wrong, correction } = await wrongAndCorrection(owner)
    const member = await insertAuthUser()
    await insertCompanyMember({ companyId: owner.companyId, userId: member, role: 'member' })

    await expect(
      withUserContext(member, (client) =>
        client.query(INSERT_ROW, [owner.companyId, randomUUID(), wrong, -1250, owner.userId]),
      ),
    ).rejects.toThrow(/row-level security/i)

    const inserted = await withUserContext(member, async (client) => {
      const settlementId = randomUUID()
      await client.query(INSERT_ROW, [owner.companyId, settlementId, wrong, -1250, member])
      await client.query(INSERT_ROW, [owner.companyId, settlementId, correction, 1250, member])
      return client.query(`SELECT id FROM public.account_reconciliation_settlements WHERE settlement_id = $1`, [
        settlementId,
      ])
    })
    expect(inserted.rows).toHaveLength(2)

    // withUserContext rolls back, so seed a committed settlement for the undo.
    const settlementId = await insertSettlement(owner.companyId, owner.userId, [
      { id: wrong, amount: -1250 },
      { id: correction, amount: 1250 },
    ])
    await expect(
      withUserContext(member, (client) =>
        client.query(
          `UPDATE public.account_reconciliation_settlements SET undone_at = now(), undone_by = $2 WHERE settlement_id = $1`,
          [settlementId, owner.userId],
        ),
      ),
    ).rejects.toThrow(/row-level security/i)

    const undone = await withUserContext(member, (client) =>
      client.query(
        `UPDATE public.account_reconciliation_settlements
            SET undone_at = now(), undone_by = $2
          WHERE settlement_id = $1 AND undone_at IS NULL
          RETURNING id`,
        [settlementId, member],
      ),
    )
    expect(undone.rows).toHaveLength(2)

    await expect(
      withUserContext(member, (client) =>
        client.query(`DELETE FROM public.account_reconciliation_settlements WHERE settlement_id = $1`, [settlementId]),
      ),
    ).rejects.toThrow(/permission denied/i)
  })

  it('is reachable by the service role (the v1 and MCP doors)', async () => {
    const owner = await seedCompany()
    const { wrong, correction } = await wrongAndCorrection(owner)
    const settlementId = randomUUID()
    const rows = await runAsServiceRole(async (client) => {
      await client.query(INSERT_ROW, [owner.companyId, settlementId, wrong, -1250, owner.userId])
      await client.query(INSERT_ROW, [owner.companyId, settlementId, correction, 1250, owner.userId])
      await client.query(
        `UPDATE public.account_reconciliation_settlements SET undone_at = now(), undone_by = $2 WHERE settlement_id = $1`,
        [settlementId, owner.userId],
      )
      return client.query<{ undone_by: string | null }>(
        `SELECT undone_by FROM public.account_reconciliation_settlements WHERE settlement_id = $1`,
        [settlementId],
      )
    })
    expect(rows.rows.map((r) => r.undone_by)).toEqual([owner.userId, owner.userId])
  })
})

describe('account_reconciliation_settlements constraints', () => {
  it('keeps a verifikat in at most one live settlement per account; an undone one frees it', async () => {
    const owner = await seedCompany()
    const { wrong, correction } = await wrongAndCorrection(owner)
    const first = await insertSettlement(owner.companyId, owner.userId, [
      { id: wrong, amount: -1250 },
      { id: correction, amount: 1250 },
    ])
    await expect(insertSettlement(owner.companyId, owner.userId, [{ id: wrong, amount: -1250 }])).rejects.toThrow(
      /ux_account_reconciliation_settlements_active|duplicate key/i,
    )
    // The same verifikat on another ledger account is its own statement.
    await expect(
      insertSettlement(owner.companyId, owner.userId, [{ id: wrong, amount: 1250 }], '2440'),
    ).resolves.toBeTruthy()

    await getPool().query(
      `UPDATE public.account_reconciliation_settlements SET undone_at = now(), undone_by = $2 WHERE settlement_id = $1`,
      [first, owner.userId],
    )
    await expect(
      insertSettlement(owner.companyId, owner.userId, [
        { id: wrong, amount: -1250 },
        { id: correction, amount: 1250 },
      ]),
    ).resolves.toBeTruthy()
  })

  it('accepts only a four-digit account number, and an undo stamp that carries its time', async () => {
    const owner = await seedCompany()
    const { wrong } = await wrongAndCorrection(owner)
    await expect(insertSettlement(owner.companyId, owner.userId, [{ id: wrong, amount: -1250 }], 'bank')).rejects.toThrow(
      /account_number/i,
    )
    const settlementId = await insertSettlement(owner.companyId, owner.userId, [{ id: wrong, amount: -1250 }])
    await expect(
      getPool().query(`UPDATE public.account_reconciliation_settlements SET undone_by = $2 WHERE settlement_id = $1`, [
        settlementId,
        owner.userId,
      ]),
    ).rejects.toThrow(/account_reconciliation_settlements_undo_stamp/i)
  })

  it('freezes everything but the undo stamp, and the stamp once it is set', async () => {
    const owner = await seedCompany()
    const { wrong, correction } = await wrongAndCorrection(owner)
    const settlementId = await insertSettlement(owner.companyId, owner.userId, [
      { id: wrong, amount: -1250 },
      { id: correction, amount: 1250 },
    ])
    const where = `WHERE settlement_id = '${settlementId}' AND journal_entry_id = '${wrong}'`

    await expect(
      getPool().query(`UPDATE public.account_reconciliation_settlements SET amount = 0 ${where}`),
    ).rejects.toThrow(/append-only/i)
    await expect(
      getPool().query(`UPDATE public.account_reconciliation_settlements SET journal_entry_id = $1 ${where}`, [correction]),
    ).rejects.toThrow(/append-only/i)
    await expect(
      getPool().query(`UPDATE public.account_reconciliation_settlements SET settled_by = $1 ${where}`, [
        await insertAuthUser(),
      ]),
    ).rejects.toThrow(/append-only/i)

    await getPool().query(
      `UPDATE public.account_reconciliation_settlements SET undone_at = now(), undone_by = $1 ${where}`,
      [owner.userId],
    )
    await expect(
      getPool().query(`UPDATE public.account_reconciliation_settlements SET undone_at = NULL, undone_by = NULL ${where}`),
    ).rejects.toThrow(/cannot be restored/i)
    await expect(
      getPool().query(`UPDATE public.account_reconciliation_settlements SET undone_at = now() + interval '1 day' ${where}`),
    ).rejects.toThrow(/cannot be restored/i)
  })
})

describe('a settlement never touches the ledger', () => {
  it('leaves both verifikat posted, their lines unchanged and the candidate RPCs as they were', async () => {
    const owner = await seedCompany()
    const { wrong, correction } = await wrongAndCorrection(owner)

    const snapshot = async () => {
      const entries = await getPool().query(
        `SELECT id, status, entry_date::text, description, updated_at FROM public.journal_entries
          WHERE id = ANY($1::uuid[]) ORDER BY id`,
        [[wrong, correction]],
      )
      const lines = await getPool().query(
        `SELECT journal_entry_id, account_number, debit_amount, credit_amount FROM public.journal_entry_lines
          WHERE journal_entry_id = ANY($1::uuid[]) ORDER BY journal_entry_id, sort_order`,
        [[wrong, correction]],
      )
      const unlinked = await getPool().query(
        `SELECT journal_entry_id, debit_amount, credit_amount, remaining_amount
           FROM public.get_unlinked_gl_lines($1, '1930', NULL, NULL) ORDER BY journal_entry_id`,
        [owner.companyId],
      )
      const candidates = await getPool().query(
        `SELECT journal_entry_id, debit_amount, credit_amount, remaining_amount
           FROM public.get_account_gl_lines_for_matching($1, '1930', NULL, NULL, false) ORDER BY journal_entry_id`,
        [owner.companyId],
      )
      return { entries: entries.rows, lines: lines.rows, unlinked: unlinked.rows, candidates: candidates.rows }
    }

    const before = await snapshot()
    // No bank rows: both verifikat are what the ledger claims and the bank does not show.
    expect(before.unlinked.map((r) => r.journal_entry_id).sort()).toEqual([wrong, correction].sort())
    const net = before.unlinked.reduce((s, r) => s + Number(r.debit_amount) - Number(r.credit_amount), 0)
    expect(net).toBe(0)

    const settlementId = await insertSettlement(owner.companyId, owner.userId, [
      { id: wrong, amount: -1250 },
      { id: correction, amount: 1250 },
    ])
    expect(await snapshot()).toEqual(before)

    await getPool().query(
      `UPDATE public.account_reconciliation_settlements SET undone_at = now(), undone_by = $2 WHERE settlement_id = $1`,
      [settlementId, owner.userId],
    )
    expect(await snapshot()).toEqual(before)
  })
})
