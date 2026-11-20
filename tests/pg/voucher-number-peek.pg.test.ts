import type { PoolClient } from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { allocateVoucherNumber, peekNextVoucherNumber } from '@/lib/bookkeeping/engine'
import { getClient } from './setup'
import { insertBalancedLines, insertDraftJournalEntry, seedCompany } from './fixtures'
import { stagingSIEClient } from './sie-client'

/**
 * The v1 commit dry run projects the voucher number with peekNextVoucherNumber.
 *
 * It used to call next_voucher_number, which increments
 * voucher_sequences.last_number, so every dry run consumed a real number and
 * the next commit left a gap in the löpnummer series (BFL 5 kap. 7 §,
 * BFNAR 2013:2). Pinned here against the real schema and the real
 * commit_journal_entry: the peek leaves last_number where it was, and the
 * number it projects is the one the commit then assigns.
 *
 * Runs as service_role, the presentation the v1 route's API-key client has.
 */

let owner: Awaited<ReturnType<typeof seedCompany>>
let client: PoolClient

async function lastNumber(series = 'A'): Promise<number | null> {
  const { rows } = await client.query<{ last_number: number }>(
    `SELECT last_number FROM public.voucher_sequences
      WHERE company_id = $1 AND fiscal_period_id = $2 AND voucher_series = $3`,
    [owner.companyId, owner.fiscalPeriodId, series],
  )
  return rows[0]?.last_number ?? null
}

async function commit(entryId: string): Promise<number> {
  const { rows } = await client.query<{ voucher_number: number }>(
    'SELECT voucher_number FROM public.commit_journal_entry($1, $2)',
    [owner.companyId, entryId],
  )
  return Number(rows[0]!.voucher_number)
}

async function draft(): Promise<string> {
  const entryId = await insertDraftJournalEntry({
    userId: owner.userId,
    companyId: owner.companyId,
    fiscalPeriodId: owner.fiscalPeriodId,
  })
  await insertBalancedLines(entryId)
  return entryId
}

beforeEach(async () => {
  owner = await seedCompany()
  client = await getClient()
})

afterEach(async () => {
  await client.query('ROLLBACK').catch(() => {})
  client.release()
})

async function beginAsServiceRole() {
  await client.query('BEGIN')
  await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: 'service_role' })])
  await client.query("SELECT set_config('request.jwt.claim.role', 'service_role', true)")
  await client.query('SET LOCAL ROLE service_role')
}

describe('peekNextVoucherNumber (pg)', () => {
  it('projects the number commit_journal_entry assigns, without advancing the series', async () => {
    const first = await draft()
    const second = await draft()
    await beginAsServiceRole()
    const db = stagingSIEClient(client, '')

    // No row yet: the series starts at 1, and peeking does not create the row.
    expect(await peekNextVoucherNumber(db, owner.companyId, owner.fiscalPeriodId, 'A')).toBe(1)
    expect(await lastNumber()).toBeNull()
    expect(await commit(first)).toBe(1)

    // Two dry runs in a row: the same projection, last_number untouched.
    expect(await peekNextVoucherNumber(db, owner.companyId, owner.fiscalPeriodId, 'A')).toBe(2)
    expect(await peekNextVoucherNumber(db, owner.companyId, owner.fiscalPeriodId, 'A')).toBe(2)
    expect(await lastNumber()).toBe(1)

    // The commit gets exactly the projected number: no gap.
    expect(await commit(second)).toBe(2)
  })

  it('reads only its own series', async () => {
    const entry = await draft()
    await beginAsServiceRole()
    const db = stagingSIEClient(client, '')
    expect(await commit(entry)).toBe(1)

    expect(await peekNextVoucherNumber(db, owner.companyId, owner.fiscalPeriodId, 'B')).toBe(1)
    expect(await lastNumber('B')).toBeNull()
  })

  it('allocateVoucherNumber, by contrast, takes the number', async () => {
    await beginAsServiceRole()
    const db = stagingSIEClient(client, '')

    expect(await allocateVoucherNumber(db, owner.companyId, owner.fiscalPeriodId, 'A')).toBe(1)
    expect(await lastNumber()).toBe(1)
    expect(await peekNextVoucherNumber(db, owner.companyId, owner.fiscalPeriodId, 'A')).toBe(2)
  })
})
