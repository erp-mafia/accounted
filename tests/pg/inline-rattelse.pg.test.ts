import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from '@/tests/pg/setup'
import {
  seedCompany,
  insertAuthUser,
  insertCompanyMember,
  insertDraftJournalEntry,
  insertCashAccount,
} from '@/tests/pg/fixtures'

// Migration 20260723210000_verifikat_inline_rattelse.sql: the founder-approved
// inline rättelse of posted verifikat (BFL 5 kap 5 § / 9 §).
//
// The mandatory suite:
//   1. GUC-less UPDATE of description/entry_date on a posted entry stays blocked
//   2. GUC-less DELETE of a posted line stays blocked
//   3. under the metadata GUC, any non-description/date column change still raises
//   4. both RPCs are blocked in closed/locked periods and behind the lock date
//   5. the effective line set must balance to the öre and keep >= 2 lines
//   6. every rättelse writes an immutable journal_entry_rattelse_log row
//   7. the log itself is WORM
//   8. role gates (viewer/stranger), cross-tenant reach, structural source types

async function insertPostedEntry(params: {
  companyId: string
  userId: string
  fiscalPeriodId: string
  entryDate?: string
  voucherNumber?: number
  sourceType?: string
  description?: string
}): Promise<{ entryId: string; debitLineId: string; creditLineId: string }> {
  const entryId = await insertDraftJournalEntry({
    userId: params.userId,
    companyId: params.companyId,
    fiscalPeriodId: params.fiscalPeriodId,
    sourceType: params.sourceType ?? 'manual',
    status: 'draft',
    voucherNumber: params.voucherNumber ?? 1,
    entryDate: params.entryDate,
  })
  if (params.description) {
    await getPool().query(`UPDATE public.journal_entries SET description = $2 WHERE id = $1`, [
      entryId,
      params.description,
    ])
  }
  const { rows: debitRows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.journal_entry_lines
       (journal_entry_id, account_number, debit_amount, credit_amount, sort_order)
     VALUES ($1, '5010', 1000, 0, 1)
     RETURNING id`,
    [entryId],
  )
  const { rows: creditRows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.journal_entry_lines
       (journal_entry_id, account_number, debit_amount, credit_amount, sort_order)
     VALUES ($1, '1930', 0, 1000, 2)
     RETURNING id`,
    [entryId],
  )
  await getPool().query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [entryId])
  return { entryId, debitLineId: debitRows[0].id, creditLineId: creditRows[0].id }
}

async function insertChartAccount(companyId: string, userId: string, accountNumber: string): Promise<void> {
  await getPool().query(
    `INSERT INTO public.chart_of_accounts
       (user_id, company_id, account_number, account_name, account_class, account_type, normal_balance)
     VALUES ($1, $2, $3, 'Testkonto ' || $3, left($3, 1)::int, 'expense', 'debit')
     ON CONFLICT DO NOTHING`,
    [userId, companyId, accountNumber],
  )
}

async function callMetadata(
  companyId: string,
  entryId: string,
  description: string | null,
  entryDate: string | null,
  actor: string,
) {
  return getPool().query<{ result: { changed: boolean; log_id: string | null } }>(
    `SELECT public.correct_entry_metadata($1::uuid, $2::uuid, $3, $4::date, $5::uuid) AS result`,
    [companyId, entryId, description, entryDate, actor],
  )
}

async function callStrike(
  companyId: string,
  entryId: string,
  strikeIds: string[],
  newLines: unknown[],
  actor: string,
) {
  return getPool().query<{ result: { struck_count: number; added_count: number; log_id: string } }>(
    `SELECT public.correct_entry_lines_inline($1::uuid, $2::uuid, $3::uuid[], $4::jsonb, $5::uuid) AS result`,
    [companyId, entryId, strikeIds, JSON.stringify(newLines), actor],
  )
}

async function periodBounds(fiscalPeriodId: string): Promise<{ start: string; end: string }> {
  const { rows } = await getPool().query<{ period_start: string; period_end: string }>(
    `SELECT period_start::text, period_end::text FROM public.fiscal_periods WHERE id = $1`,
    [fiscalPeriodId],
  )
  return { start: rows[0].period_start, end: rows[0].period_end }
}

describe('inline rättelse: metadata (correct_entry_metadata)', () => {
  it('still blocks a GUC-less description/date UPDATE on a posted entry', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const { entryId } = await insertPostedEntry({ companyId, userId, fiscalPeriodId })

    await expect(
      getPool().query(`UPDATE public.journal_entries SET description = 'hacked' WHERE id = $1`, [entryId]),
    ).rejects.toThrow(/immutable/)
  })

  it('corrects description + same-period date, and logs old/new with the actor', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const bounds = await periodBounds(fiscalPeriodId)
    const { entryId } = await insertPostedEntry({
      companyId, userId, fiscalPeriodId,
      entryDate: bounds.start, description: 'Felstavat teext',
    })

    const res = await callMetadata(companyId, entryId, 'Rättad text', bounds.end, userId)
    expect(res.rows[0].result.changed).toBe(true)
    expect(res.rows[0].result.log_id).toBeTruthy()

    const { rows: entry } = await getPool().query(
      `SELECT description, entry_date::text, status FROM public.journal_entries WHERE id = $1`,
      [entryId],
    )
    expect(entry[0].description).toBe('Rättad text')
    expect(entry[0].entry_date).toBe(bounds.end)
    expect(entry[0].status).toBe('posted')

    const { rows: log } = await getPool().query(
      `SELECT rattelse_type, old_description, new_description, old_entry_date::text, new_entry_date::text, actor
         FROM public.journal_entry_rattelse_log WHERE journal_entry_id = $1`,
      [entryId],
    )
    expect(log).toHaveLength(1)
    expect(log[0].rattelse_type).toBe('metadata')
    expect(log[0].old_description).toBe('Felstavat teext')
    expect(log[0].new_description).toBe('Rättad text')
    expect(log[0].old_entry_date).toBe(bounds.start)
    expect(log[0].new_entry_date).toBe(bounds.end)
    expect(log[0].actor).toBe(userId)
  })

  it('is an idempotent no-op (no log row) when nothing changes', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const { entryId } = await insertPostedEntry({
      companyId, userId, fiscalPeriodId, description: 'Samma text',
    })

    const res = await callMetadata(companyId, entryId, 'Samma text', null, userId)
    expect(res.rows[0].result.changed).toBe(false)

    const { rows } = await getPool().query(
      `SELECT 1 FROM public.journal_entry_rattelse_log WHERE journal_entry_id = $1`,
      [entryId],
    )
    expect(rows).toHaveLength(0)
  })

  it('rejects a date outside the fiscal period', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const bounds = await periodBounds(fiscalPeriodId)
    const { entryId } = await insertPostedEntry({
      companyId, userId, fiscalPeriodId, entryDate: bounds.start,
    })
    const outside = new Date(new Date(bounds.end).getTime() + 24 * 3600 * 1000)
      .toISOString()
      .slice(0, 10)

    await expect(callMetadata(companyId, entryId, null, outside, userId)).rejects.toThrow(
      /inom samma bokföringsperiod/,
    )
  })

  it('rejects all metadata edits on storno entries', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const { entryId } = await insertPostedEntry({
      companyId, userId, fiscalPeriodId, sourceType: 'storno', voucherNumber: 8,
    })

    await expect(callMetadata(companyId, entryId, 'Omdöpt storno', null, userId)).rejects.toThrow(
      /Stornoverifikat kan inte rättas/,
    )
  })

  it('rejects date changes on opening_balance/year_end/vat_settlement entries', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const bounds = await periodBounds(fiscalPeriodId)
    const { entryId } = await insertPostedEntry({
      companyId, userId, fiscalPeriodId,
      entryDate: bounds.start, sourceType: 'year_end', voucherNumber: 7,
    })

    await expect(callMetadata(companyId, entryId, null, bounds.end, userId)).rejects.toThrow(
      /kan inte ändras/,
    )
    // ...but the description alone is still correctable.
    const res = await callMetadata(companyId, entryId, 'Bokslut, rättad text', null, userId)
    expect(res.rows[0].result.changed).toBe(true)
  })

  it('rejects metadata rättelse in closed and locked periods, and behind the lock date', async () => {
    const closed = await seedCompany()
    const closedEntry = await insertPostedEntry({
      companyId: closed.companyId, userId: closed.userId, fiscalPeriodId: closed.fiscalPeriodId,
    })
    await getPool().query(
      `UPDATE public.fiscal_periods SET is_closed = true, closed_at = now() WHERE id = $1`,
      [closed.fiscalPeriodId],
    )
    await expect(
      callMetadata(closed.companyId, closedEntry.entryId, 'Ny text', null, closed.userId),
    ).rejects.toThrow(/stängd eller låst/)

    const locked = await seedCompany()
    const lockedEntry = await insertPostedEntry({
      companyId: locked.companyId, userId: locked.userId, fiscalPeriodId: locked.fiscalPeriodId,
    })
    await getPool().query(`UPDATE public.fiscal_periods SET locked_at = now() WHERE id = $1`, [
      locked.fiscalPeriodId,
    ])
    await expect(
      callMetadata(locked.companyId, lockedEntry.entryId, 'Ny text', null, locked.userId),
    ).rejects.toThrow(/stängd eller låst/)

    const lockDated = await seedCompany()
    const lockDatedBounds = await periodBounds(lockDated.fiscalPeriodId)
    const lockDatedEntry = await insertPostedEntry({
      companyId: lockDated.companyId, userId: lockDated.userId,
      fiscalPeriodId: lockDated.fiscalPeriodId, entryDate: lockDatedBounds.start,
    })
    await getPool().query(
      `INSERT INTO public.company_settings (user_id, company_id, bookkeeping_locked_through)
       VALUES ($1, $2, $3::date)
       ON CONFLICT (company_id) DO UPDATE SET bookkeeping_locked_through = $3::date`,
      [lockDated.userId, lockDated.companyId, lockDatedBounds.end],
    )
    await expect(
      callMetadata(lockDated.companyId, lockDatedEntry.entryId, 'Ny text', null, lockDated.userId),
    ).rejects.toThrow(/låst t\.o\.m/)
  })

  it('rejects viewers, strangers and drafts', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const { entryId } = await insertPostedEntry({ companyId, userId, fiscalPeriodId })

    const viewerId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: viewerId, role: 'viewer' })
    await expect(callMetadata(companyId, entryId, 'Som viewer', null, viewerId)).rejects.toThrow(
      /skrivbehörighet/,
    )
    await expect(callMetadata(companyId, entryId, 'Som främling', null, randomUUID())).rejects.toThrow(
      /skrivbehörighet/,
    )

    const draftId = await insertDraftJournalEntry({
      userId, companyId, fiscalPeriodId, status: 'draft', voucherNumber: 99,
    })
    await expect(callMetadata(companyId, draftId, 'Utkast', null, userId)).rejects.toThrow(
      /bokförda verifikat/,
    )
  })

  it('ignores a spoofed p_user_id for JWT callers (viewer cannot act as the owner)', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const { entryId } = await insertPostedEntry({ companyId, userId, fiscalPeriodId })
    const viewerId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: viewerId, role: 'viewer' })

    // Authenticated JWT context as the viewer, passing the OWNER's id as
    // p_user_id: the RPC must pin the actor to auth.uid() and refuse.
    await withUserContext(viewerId, async (client) => {
      await expect(
        client.query(
          `SELECT public.correct_entry_metadata($1::uuid, $2::uuid, 'Spoofad text', NULL, $3::uuid)`,
          [companyId, entryId, userId],
        ),
      ).rejects.toThrow(/skrivbehörighet/)
    })
  })

  it('never admits a smuggled non-metadata change under the GUC', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const { entryId } = await insertPostedEntry({ companyId, userId, fiscalPeriodId })

    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('gnubok.allow_metadata_rattelse', 'true', true)`)
      await expect(
        client.query(
          `UPDATE public.journal_entries SET description = 'ny text', voucher_number = 4711 WHERE id = $1`,
          [entryId],
        ),
      ).rejects.toThrow(/immutable/)
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })

  it("cannot reach another company's entries", async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    const { entryId } = await insertPostedEntry({
      companyId: a.companyId, userId: a.userId, fiscalPeriodId: a.fiscalPeriodId,
    })

    await expect(callMetadata(b.companyId, entryId, 'Cross-tenant', null, b.userId)).rejects.toThrow(
      /hittades inte/,
    )
  })
})

describe('inline rättelse: lines (correct_entry_lines_inline)', () => {
  it('still blocks a GUC-less DELETE of a posted line', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const { debitLineId } = await insertPostedEntry({ companyId, userId, fiscalPeriodId })

    await expect(
      getPool().query(`DELETE FROM public.journal_entry_lines WHERE id = $1`, [debitLineId]),
    ).rejects.toThrow(/Cannot DELETE lines of a posted journal entry/)
  })

  it('strikes a line and adds a balanced replacement in the same verifikat (happy path)', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    await insertChartAccount(companyId, userId, '5420')
    const { entryId, debitLineId } = await insertPostedEntry({ companyId, userId, fiscalPeriodId })

    const res = await callStrike(
      companyId, entryId, [debitLineId],
      [{ account_number: '5420', debit_amount: 1000, credit_amount: 0, line_description: 'Programvara' }],
      userId,
    )
    expect(res.rows[0].result.struck_count).toBe(1)
    expect(res.rows[0].result.added_count).toBe(1)

    // The struck line is gone from the effective verifikat; the replacement
    // exists with a resolved account_id and a sort_order after the survivors.
    const { rows: lines } = await getPool().query(
      `SELECT account_number, debit_amount::numeric, credit_amount::numeric, account_id, sort_order
         FROM public.journal_entry_lines WHERE journal_entry_id = $1 ORDER BY sort_order`,
      [entryId],
    )
    expect(lines).toHaveLength(2)
    expect(lines.map((l) => l.account_number)).toEqual(['1930', '5420'])
    expect(lines[1].account_id).toBeTruthy()
    expect(Number(lines[1].debit_amount)).toBe(1000)

    // Entry still balances and is still posted.
    const { rows: sums } = await getPool().query(
      `SELECT sum(debit_amount)::numeric AS d, sum(credit_amount)::numeric AS c
         FROM public.journal_entry_lines WHERE journal_entry_id = $1`,
      [entryId],
    )
    expect(Number(sums[0].d)).toBe(1000)
    expect(Number(sums[0].c)).toBe(1000)

    // Immutable log row carries the full struck snapshot + the added lines.
    const { rows: log } = await getPool().query(
      `SELECT rattelse_type, struck_lines, added_lines, actor
         FROM public.journal_entry_rattelse_log WHERE journal_entry_id = $1`,
      [entryId],
    )
    expect(log).toHaveLength(1)
    expect(log[0].rattelse_type).toBe('lines')
    expect(log[0].struck_lines).toHaveLength(1)
    expect(log[0].struck_lines[0].account_number).toBe('5010')
    expect(Number(log[0].struck_lines[0].debit_amount)).toBe(1000)
    expect(log[0].added_lines).toHaveLength(1)
    expect(log[0].added_lines[0].account_number).toBe('5420')
    expect(log[0].actor).toBe(userId)
  })

  it('rejects an unbalanced rättelse and rolls back atomically', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    await insertChartAccount(companyId, userId, '5420')
    const { entryId, debitLineId } = await insertPostedEntry({ companyId, userId, fiscalPeriodId })

    await expect(
      callStrike(
        companyId, entryId, [debitLineId],
        [{ account_number: '5420', debit_amount: 900, credit_amount: 0 }],
        userId,
      ),
    ).rejects.toThrow(/balanserar inte/)

    // Nothing changed, nothing logged.
    const { rows: lines } = await getPool().query(
      `SELECT count(*)::int AS n FROM public.journal_entry_lines WHERE journal_entry_id = $1`,
      [entryId],
    )
    expect(lines[0].n).toBe(2)
    const { rows: log } = await getPool().query(
      `SELECT 1 FROM public.journal_entry_rattelse_log WHERE journal_entry_id = $1`,
      [entryId],
    )
    expect(log).toHaveLength(0)
  })

  it('rejects a rättelse that leaves fewer than two lines or zeroes the verifikat', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const { entryId, debitLineId, creditLineId } = await insertPostedEntry({
      companyId, userId, fiscalPeriodId,
    })

    await expect(callStrike(companyId, entryId, [debitLineId], [], userId)).rejects.toThrow(
      /minst två rader/,
    )
    await expect(
      callStrike(companyId, entryId, [debitLineId, creditLineId], [], userId),
    ).rejects.toThrow(/minst två rader/)
  })

  it('rejects an empty rättelse and a strike + identical re-add', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    await insertChartAccount(companyId, userId, '5010')
    const { entryId, debitLineId } = await insertPostedEntry({ companyId, userId, fiscalPeriodId })

    await expect(callStrike(companyId, entryId, [], [], userId)).rejects.toThrow(/minst en rad/)
    await expect(
      callStrike(
        companyId, entryId, [debitLineId],
        [{ account_number: '5010', debit_amount: 1000, credit_amount: 0 }],
        userId,
      ),
    ).rejects.toThrow(/ändrar ingenting/)
  })

  it("rejects strike ids from another entry and accounts missing from the chart", async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const first = await insertPostedEntry({ companyId, userId, fiscalPeriodId })
    const second = await insertPostedEntry({ companyId, userId, fiscalPeriodId, voucherNumber: 2 })

    await expect(
      callStrike(companyId, first.entryId, [second.debitLineId], [], userId),
    ).rejects.toThrow(/hör inte till verifikationen/)

    await expect(
      callStrike(
        companyId, first.entryId, [first.debitLineId],
        [{ account_number: '9999', debit_amount: 1000, credit_amount: 0 }],
        userId,
      ),
    ).rejects.toThrow(/finns inte i kontoplanen/)
  })

  it('rejects line rättelse on structural source types and outside open periods', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const yearEnd = await insertPostedEntry({
      companyId, userId, fiscalPeriodId, sourceType: 'year_end', voucherNumber: 3,
    })
    await expect(
      callStrike(companyId, yearEnd.entryId, [yearEnd.debitLineId], [], userId),
    ).rejects.toThrow(/kan inte rättas radvis/)

    const locked = await seedCompany()
    const lockedEntry = await insertPostedEntry({
      companyId: locked.companyId, userId: locked.userId, fiscalPeriodId: locked.fiscalPeriodId,
    })
    await getPool().query(`UPDATE public.fiscal_periods SET locked_at = now() WHERE id = $1`, [
      locked.fiscalPeriodId,
    ])
    await expect(
      callStrike(locked.companyId, lockedEntry.entryId, [lockedEntry.debitLineId], [], locked.userId),
    ).rejects.toThrow(/stängd eller låst/)
  })

  it('blocks striking foreign-currency lines and doc-attached lines', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    await insertChartAccount(companyId, userId, '5420')
    const entryId = await insertDraftJournalEntry({
      userId, companyId, fiscalPeriodId, sourceType: 'manual', status: 'draft', voucherNumber: 11,
    })
    const { rows: fxRows } = await getPool().query<{ id: string }>(
      `INSERT INTO public.journal_entry_lines
         (journal_entry_id, account_number, debit_amount, credit_amount, sort_order, currency, amount_in_currency, exchange_rate)
       VALUES ($1, '5010', 1000, 0, 1, 'EUR', 90, 11.11) RETURNING id`,
      [entryId],
    )
    await getPool().query(
      `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount, sort_order)
       VALUES ($1, '1930', 0, 1000, 2)`,
      [entryId],
    )
    await getPool().query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [entryId])

    await expect(
      callStrike(companyId, entryId, [fxRows[0].id],
        [{ account_number: '5420', debit_amount: 1000, credit_amount: 0 }], userId),
    ).rejects.toThrow(/utländsk valuta/)

    await getPool().query(
      `INSERT INTO public.document_attachments
         (user_id, company_id, journal_entry_id, journal_entry_line_id, storage_path, file_name, sha256_hash)
       VALUES ($1, $2, $3, $4, 'test/underlag.pdf', 'kvitto.pdf', repeat('a', 64))`,
      [userId, companyId, entryId, fxRows[0].id],
    )
    await expect(
      callStrike(companyId, entryId, [fxRows[0].id],
        [{ account_number: '5420', debit_amount: 1000, credit_amount: 0 }], userId),
    ).rejects.toThrow(/utländsk valuta|kopplat underlag/)
  })

  it('protects the bank side of transaction-linked entries but allows contra-side fixes', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    await insertChartAccount(companyId, userId, '5420')
    await insertChartAccount(companyId, userId, '1930')
    const { entryId, debitLineId, creditLineId } = await insertPostedEntry({
      companyId, userId, fiscalPeriodId, sourceType: 'bank_transaction',
    })
    await getPool().query(
      `INSERT INTO public.transactions (user_id, company_id, date, description, amount, journal_entry_id, is_business)
       VALUES ($1, $2, '2026-02-10', 'Bank tx', -1000, $3, true)`,
      [userId, companyId, entryId],
    )

    // Changing the 1930 net is refused: the bank feed amount is immutable.
    await expect(
      callStrike(companyId, entryId, [creditLineId],
        [
          { account_number: '1930', debit_amount: 0, credit_amount: 900 },
          { account_number: '5420', debit_amount: 0, credit_amount: 100 },
        ], userId),
    ).rejects.toThrow(/kopplad till en banktransaktion/)

    // The contra side (wrong expense account) is exactly the reconciliation
    // use case and stays correctable.
    const res = await callStrike(companyId, entryId, [debitLineId],
      [{ account_number: '5420', debit_amount: 1000, credit_amount: 0 }], userId)
    expect(res.rows[0].result.struck_count).toBe(1)

    // A net-preserving strike+re-add on the bank line (description fix) is
    // allowed, and counts as a real change thanks to the description-aware
    // no-op comparison.
    const res2 = await callStrike(companyId, entryId, [creditLineId],
      [{ account_number: '1930', debit_amount: 0, credit_amount: 1000, line_description: 'Rättad text' }], userId)
    expect(res2.rows[0].result.struck_count).toBe(1)
  })

  // 20260819092408_inline_rattelse_bank_anchor.sql: the bank-side guard is
  // anchored to the linked bank amount, not to the pre-state. The Discord
  // case (Sebastian, 2026-08-19): a +10 874,81 deposit booked as 1930 D /
  // 1930 K (the credit should have been 2970), so the 1930 net was 0 and the
  // only rättelse that makes the entry match the feed was refused.
  it('allows a bank-side strike that makes the 19xx net equal the linked bank amount', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    await insertChartAccount(companyId, userId, '1930')
    await insertChartAccount(companyId, userId, '2970')
    const entryId = await insertDraftJournalEntry({
      userId, companyId, fiscalPeriodId, sourceType: 'bank_transaction', status: 'draft', voucherNumber: 21,
    })
    await getPool().query(
      `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount, sort_order)
       VALUES ($1, '1930', 10874.81, 0, 1)`,
      [entryId],
    )
    const { rows: wrongRows } = await getPool().query<{ id: string }>(
      `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount, sort_order, line_description)
       VALUES ($1, '1930', 0, 10874.81, 2, 'Förutbetalda intäkter') RETURNING id`,
      [entryId],
    )
    await getPool().query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [entryId])
    await getPool().query(
      `INSERT INTO public.transactions (user_id, company_id, date, description, amount, journal_entry_id, is_business)
       VALUES ($1, $2, '2026-02-10', 'BOKADIREKT X', 10874.81, $3, true)`,
      [userId, companyId, entryId],
    )

    // Moving the 1930 net somewhere that is NOT the bank amount is still
    // refused, and the message now carries both amounts.
    await expect(
      callStrike(companyId, entryId, [wrongRows[0].id],
        [
          { account_number: '1930', debit_amount: 0, credit_amount: 5000 },
          { account_number: '2970', debit_amount: 0, credit_amount: 5874.81 },
        ], userId),
    ).rejects.toThrow(/kopplad till en banktransaktion på 10874\.81 kr.*5874\.81 kr/)

    // Striking the wrong 1930 K line and re-adding it on 2970 takes the 1930
    // net from 0 to +10 874,81 = the deposit. Allowed.
    const res = await callStrike(companyId, entryId, [wrongRows[0].id],
      [{ account_number: '2970', debit_amount: 0, credit_amount: 10874.81, line_description: 'Förutbetalda intäkter' }], userId)
    expect(res.rows[0].result.struck_count).toBe(1)
    expect(res.rows[0].result.added_count).toBe(1)

    const { rows: after } = await getPool().query<{ account_number: string; debit_amount: string; credit_amount: string }>(
      `SELECT account_number, debit_amount::text, credit_amount::text FROM public.journal_entry_lines
        WHERE journal_entry_id = $1 ORDER BY sort_order`,
      [entryId],
    )
    expect(after.map((l) => [l.account_number, Number(l.debit_amount), Number(l.credit_amount)])).toEqual([
      ['1930', 10874.81, 0],
      ['2970', 0, 10874.81],
    ])

    // Now that the bank side matches the feed, moving it again is refused:
    // the anchor is the feed, not the pre-state.
    const { rows: bankRows } = await getPool().query<{ id: string }>(
      `SELECT id FROM public.journal_entry_lines WHERE journal_entry_id = $1 AND account_number = '1930'`,
      [entryId],
    )
    await expect(
      callStrike(companyId, entryId, [bankRows[0].id],
        [
          { account_number: '1930', debit_amount: 10000, credit_amount: 0 },
          { account_number: '2970', debit_amount: 874.81, credit_amount: 0 },
        ], userId),
    ).rejects.toThrow(/kopplad till en banktransaktion/)
  })

  it('anchors split-linked entries by allocated_amount on the transaction cash account, once per transaction', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    await insertChartAccount(companyId, userId, '1940')
    await insertChartAccount(companyId, userId, '3010')
    const cashAccountId = await insertCashAccount({ companyId, ledgerAccount: '1940' })
    const entryId = await insertDraftJournalEntry({
      userId, companyId, fiscalPeriodId, sourceType: 'bank_transaction', status: 'draft', voucherNumber: 22,
    })
    // Two deposits (600 + 400) on the 1940 cash account, booked as
    // 1940 D 1000 / 1940 K 1000: the contra line landed on the bank account.
    await getPool().query(
      `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount, sort_order)
       VALUES ($1, '1940', 1000, 0, 1)`,
      [entryId],
    )
    const { rows: wrongRows } = await getPool().query<{ id: string }>(
      `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount, sort_order)
       VALUES ($1, '1940', 0, 1000, 2) RETURNING id`,
      [entryId],
    )
    await getPool().query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [entryId])
    const { rows: txRows } = await getPool().query<{ id: string }>(
      `INSERT INTO public.transactions (user_id, company_id, date, description, amount, cash_account_id, is_business, journal_entry_id)
       VALUES ($1, $2, '2026-02-10', 'Swish 1', 600, $3, true, NULL),
              ($1, $2, '2026-02-10', 'Swish 2', 400, $3, true, $4)
       RETURNING id`,
      [userId, companyId, cashAccountId, entryId],
    )
    // Both transactions carry split links; the second ALSO has the direct FK
    // (the 1:1 bulk-book shape). Double counting it would make the anchor
    // 1 400 and wrongly refuse the fix below.
    for (const tx of txRows) {
      await getPool().query(
        `INSERT INTO public.transaction_voucher_links
           (user_id, company_id, transaction_id, journal_entry_id, allocated_amount, role)
         VALUES ($1, $2, $3, $4, (SELECT amount FROM public.transactions WHERE id = $3), 'bank_line')`,
        [userId, companyId, tx.id, entryId],
      )
    }

    // Partial move: 1940 would end at 400 ≠ 1 000. Refused with the amounts.
    await expect(
      callStrike(companyId, entryId, [wrongRows[0].id],
        [
          { account_number: '1940', debit_amount: 0, credit_amount: 600 },
          { account_number: '3010', debit_amount: 0, credit_amount: 400 },
        ], userId),
    ).rejects.toThrow(/banktransaktion på 1000\.00 kr.*400\.00 kr/)

    // Full move: 1940 net 0 -> 1 000 = 600 + 400. Allowed.
    const res = await callStrike(companyId, entryId, [wrongRows[0].id],
      [{ account_number: '3010', debit_amount: 0, credit_amount: 1000 }], userId)
    expect(res.rows[0].result.struck_count).toBe(1)
  })

  it('keeps the journal_entry_rattelse_log immutable', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    await insertChartAccount(companyId, userId, '5420')
    const { entryId, debitLineId } = await insertPostedEntry({ companyId, userId, fiscalPeriodId })
    await callStrike(
      companyId, entryId, [debitLineId],
      [{ account_number: '5420', debit_amount: 1000, credit_amount: 0 }],
      userId,
    )

    const { rows } = await getPool().query<{ id: string }>(
      `SELECT id FROM public.journal_entry_rattelse_log WHERE journal_entry_id = $1`,
      [entryId],
    )
    await expect(
      getPool().query(`UPDATE public.journal_entry_rattelse_log SET actor = NULL WHERE id = $1`, [
        rows[0].id,
      ]),
    ).rejects.toThrow(/oföränderlig/)
    await expect(
      getPool().query(`DELETE FROM public.journal_entry_rattelse_log WHERE id = $1`, [rows[0].id]),
    ).rejects.toThrow(/oföränderlig/)
  })

  it('leaves the gnubok.allow_delete bulk-delete path unaffected', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const { entryId, debitLineId } = await insertPostedEntry({ companyId, userId, fiscalPeriodId })

    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('gnubok.allow_delete', 'true', true)`)
      await client.query(`DELETE FROM public.journal_entry_lines WHERE id = $1`, [debitLineId])
      await client.query(`DELETE FROM public.journal_entries WHERE id = $1`, [entryId])
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })
})
