/**
 * The titles of the staged reconciliation operations (crm#1938): they name the
 * account by its name and BAS account, an outside row by its date and text
 * and a residual by what it is. The queue used to read "Markera
 * bank:<uuid> som avstämt", which told two accounts at one bank apart only
 * for someone who knew their ids.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const skattekontoAccountMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/skatteverket/skattekonto-account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/skatteverket/skattekonto-account')>()),
  resolveSkattekontoAccount: (...args: unknown[]) => skattekontoAccountMock(...args),
}))

const signoffMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/reconciliation/signoff', () => ({
  signOffAccount: (...args: unknown[]) => signoffMock(...args),
}))

import { tools } from '../server'
import {
  accountKeyLabel,
  outsideRowLabel,
  reconciliationMatchTitle,
  reconciliationResidualTitle,
  reconciliationSignoffTitle,
  reconciliationUnmatchTitle,
} from '../reconciliation-titles'

const COMPANY = 'company-1'
const CASH_ID = '44444444-4444-4444-8444-444444444444'
const BANK_KEY = `bank:${CASH_ID}`
const ROW = '22222222-2222-4222-8222-222222222222'

/** A key, an id or a code of ours: nothing a person can read. */
const INTERNAL = /bank:|manual:|[0-9a-f]{8}-[0-9a-f]{4}-|bank_fee|interest_|rad\(er\)/

beforeEach(() => {
  vi.clearAllMocks()
  skattekontoAccountMock.mockResolvedValue('1630')
})

describe('accountKeyLabel', () => {
  it('names a bank account by its name and BAS account, read for this company only', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { name: 'Lönekonto', ledger_account: '1935' } })

    await expect(accountKeyLabel(supabase as never, COMPANY, BANK_KEY)).resolves.toBe('Lönekonto (1935)')
    expect(findCalls('cash_accounts', 'eq')).toEqual([
      ['company_id', COMPANY],
      ['id', CASH_ID],
    ])
  })

  it('falls back to the BAS account for a bank account without a name, and to a plain word when the account is not found', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { name: '  ', ledger_account: '1930' } })
    enqueue({ data: null })

    await expect(accountKeyLabel(supabase as never, COMPANY, BANK_KEY)).resolves.toBe('Bankkonto 1930')
    await expect(accountKeyLabel(supabase as never, COMPANY, BANK_KEY)).resolves.toBe('bankkontot')
  })

  it("names the skattekonto with the company's own skattekonto account", async () => {
    const { supabase } = createQueuedMockSupabase()
    skattekontoAccountMock.mockResolvedValue('2012')

    await expect(accountKeyLabel(supabase as never, COMPANY, 'skattekonto')).resolves.toBe('Skattekonto (2012)')
  })

  it('names another balance account by its name in the chart', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { account_name: 'Kundfordringar' } })
    enqueue({ data: null })

    await expect(accountKeyLabel(supabase as never, COMPANY, 'manual:1510')).resolves.toBe('Kundfordringar (1510)')
    expect(findCalls('chart_of_accounts', 'eq')).toEqual([
      ['company_id', COMPANY],
      ['account_number', '1510'],
    ])
    await expect(accountKeyLabel(supabase as never, COMPANY, 'manual:2440')).resolves.toBe('Konto 2440')
  })

  it('never answers with the key when the read fails', async () => {
    const { supabase } = createQueuedMockSupabase()
    skattekontoAccountMock.mockRejectedValue(new Error('Kunde inte läsa skattekontots konto: timeout'))

    await expect(accountKeyLabel(supabase as never, COMPANY, 'skattekonto')).resolves.toBe('Skattekonto')
  })
})

describe('outsideRowLabel', () => {
  it('names a bank row by its date and text', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { date: '2026-10-03', description: 'Kortköp tele', merchant_name: 'Teleoperatören' } })

    await expect(outsideRowLabel(supabase as never, COMPANY, BANK_KEY, ROW)).resolves.toBe('2026-10-03 Kortköp tele')
    expect(findCall('transactions', 'select')).toEqual(['date, description, merchant_name'])
  })

  it('names a skattekonto row by its date and text', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { transaktionsdatum: '2026-10-12', transaktionstext: 'Arbetsgivaravgift' } })

    await expect(outsideRowLabel(supabase as never, COMPANY, 'skattekonto', ROW)).resolves.toBe('2026-10-12 Arbetsgivaravgift')
  })

  it('answers null for a row it cannot read, without a read for an id that is no row id', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: null })

    await expect(outsideRowLabel(supabase as never, COMPANY, BANK_KEY, ROW)).resolves.toBeNull()
    await expect(outsideRowLabel(supabase as never, COMPANY, 'skattekonto', 'not-an-id')).resolves.toBeNull()
    expect(findCall('skattekonto_transactions', 'select')).toBeUndefined()
  })
})

describe('the reconciliation titles', () => {
  const titles = [
    reconciliationMatchTitle('Lönekonto (1935)', 1, null),
    reconciliationMatchTitle('Lönekonto (1935)', 3, null),
    reconciliationMatchTitle('Skattekonto (1630)', 2, 4),
    reconciliationUnmatchTitle('Lönekonto (1935)', '2026-10-03 Kortköp tele'),
    reconciliationUnmatchTitle('Lönekonto (1935)', null),
    reconciliationUnmatchTitle('Skattekonto (1630)', 'settlement'),
    reconciliationSignoffTitle('Lönekonto (1935)', '2026-10-31'),
    reconciliationResidualTitle('Lönekonto (1935)', { amount: 12.5, currency: 'SEK', kind: 'bank_fee', rows: 1 }),
    reconciliationResidualTitle('Lönekonto (1935)', { amount: 0.4, currency: 'SEK', kind: 'rounding', rows: 2 }),
  ]

  it('read as sentences about the account, the row and the residual', () => {
    expect(titles).toEqual([
      'Koppla 1 rad på Lönekonto (1935)',
      'Koppla 3 rader på Lönekonto (1935)',
      'Koppla 4 verifikat mot varandra på Skattekonto (1630)',
      'Koppla bort rad på Lönekonto (1935): 2026-10-03 Kortköp tele',
      'Koppla bort en rad på Lönekonto (1935)',
      'Koppla bort verifikat som kopplats mot varandra på Skattekonto (1630)',
      'Markera Lönekonto (1935) som avstämt t.o.m. 2026-10-31',
      'Bokför restpost 12.5 SEK (bankavgift) på Lönekonto (1935) och koppla 1 rad',
      'Bokför restpost 0.4 SEK (öresavrundning) på Lönekonto (1935) och koppla 2 rader',
    ])
  })

  it('carry no key, id or code of ours', () => {
    for (const title of titles) expect(title).not.toMatch(INTERNAL)
  })
})

describe('gnubok_reconcile_signoff: the staged title', () => {
  const signoff = tools.find((t) => t.name === 'gnubok_reconcile_signoff')!

  it('stores the account by name and BAS account, with the key left in params', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    signoffMock.mockResolvedValue({
      dry_run: true,
      would_sign: { account_key: BANK_KEY, through_date: '2026-10-31', unexplained_difference: 0 },
    })
    enqueue({ data: { name: 'Lönekonto', ledger_account: '1935' } }) // cash_accounts: the title's account
    enqueue({ data: { id: 'op-signoff-1' } }) // pending_operations insert

    const result = (await signoff.execute(
      { account_key: BANK_KEY, through_date: '2026-10-31' },
      COMPANY, 'user-1', supabase as never, { type: 'api_key', id: 'key-1' } as never,
    )) as { staged: boolean }

    expect(result.staged).toBe(true)
    const [inserted] = findCall('pending_operations', 'insert') as [{ title: string; params: { account_key: string } }]
    expect(inserted.title).toBe('Markera Lönekonto (1935) som avstämt t.o.m. 2026-10-31')
    expect(inserted.title).not.toMatch(INTERNAL)
    expect(inserted.params.account_key).toBe(BANK_KEY)
  })

  it('reads no account name for a dry run, which stores no title', async () => {
    const { supabase, findCall } = createQueuedMockSupabase()
    signoffMock.mockResolvedValue({
      dry_run: true,
      would_sign: { account_key: BANK_KEY, through_date: '2026-10-31', unexplained_difference: 0 },
    })

    const result = (await signoff.execute(
      { account_key: BANK_KEY, through_date: '2026-10-31', dry_run: true },
      COMPANY, 'user-1', supabase as never, { type: 'api_key', id: 'key-1' } as never,
    )) as { staged: boolean; dry_run?: boolean }

    expect(result).toMatchObject({ staged: false, dry_run: true })
    expect(findCall('cash_accounts', 'select')).toBeUndefined()
  })
})
