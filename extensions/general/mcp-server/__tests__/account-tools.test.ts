/**
 * Unit tests for the staged kontoplan tools: gnubok_create_account and
 * gnubok_update_account. Covers registration/scope/risk-tier wiring, the
 * BAS 2026 prefill (resolve-don't-guess), the duplicate/inactive pre-flight
 * gates, and dry-run staging behaviour. Executor-side coverage
 * (commitCreateAccount / commitUpdateAccount) lives in
 * lib/pending-operations/__tests__/account-and-note-executors.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { tools } from '../server'
import { TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'
import { OPERATION_RISK_TIERS } from '@/lib/pending-operations/risk-tiers'
import { getBASReference } from '@/lib/bookkeeping/bas-reference'

const createAccount = tools.find((t) => t.name === 'gnubok_create_account')!
const updateAccount = tools.find((t) => t.name === 'gnubok_update_account')!

/**
 * A 4-digit number guaranteed absent from the BAS 2026 catalog, in classes
 * 4-7 so the fixture's account_type 'expense' passes the class/type
 * consistency guard.
 */
function findNonBasNumber(): string {
  for (let n = 4000; n <= 7999; n++) {
    const candidate = String(n)
    if (!getBASReference(candidate)) return candidate
  }
  throw new Error('BAS catalog unexpectedly covers every 4-digit expense number')
}
const NON_BAS_NUMBER = findNonBasNumber()

const noopSupabase = { from: vi.fn() } as never

beforeEach(() => {
  vi.clearAllMocks()
})

describe('kontoplan tools: registration', () => {
  it('both tools exist, stage, and declare strict schemas', () => {
    for (const tool of [createAccount, updateAccount]) {
      expect(tool).toBeDefined()
      expect((tool.inputSchema as { additionalProperties?: boolean }).additionalProperties).toBe(false)
      const out = tool.outputSchema as { properties?: Record<string, unknown>; required?: string[] }
      expect(out?.properties?.staged).toBeDefined()
      expect(out?.required).toContain('staged')
      expect(tool.description).toMatch(/stag(e|es|ing)/i)
      expect(tool.annotations.readOnlyHint).toBe(false)
      expect(tool.annotations.destructiveHint).toBe(false)
    }
  })

  it('only requires account_number', () => {
    expect((createAccount.inputSchema as { required?: string[] }).required).toEqual(['account_number'])
    expect((updateAccount.inputSchema as { required?: string[] }).required).toEqual(['account_number'])
  })

  it('is mapped to bookkeeping:write scope and low risk tier', () => {
    expect(TOOL_SCOPE_MAP.gnubok_create_account).toBe('bookkeeping:write')
    expect(TOOL_SCOPE_MAP.gnubok_update_account).toBe('bookkeeping:write')
    expect(OPERATION_RISK_TIERS.create_account).toBe('low')
    expect(OPERATION_RISK_TIERS.update_account).toBe('low')
  })
})

describe('gnubok_create_account: validation gates', () => {
  it('rejects a non-4-digit account number before any DB call', async () => {
    await expect(
      createAccount.execute({ account_number: '193' }, 'company-1', 'user-1', noopSupabase),
    ).rejects.toThrow(/4 digits/)
    await expect(
      createAccount.execute({ account_number: '19300' }, 'company-1', 'user-1', noopSupabase),
    ).rejects.toThrow(/4 digits/)
  })

  it('rejects when the account already exists and is active', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { account_number: '5410', account_name: 'Förbrukningsinventarier', is_active: true } })
    await expect(
      createAccount.execute({ account_number: '5410' }, 'company-1', 'user-1', supabase as never),
    ).rejects.toThrow(/finns redan/)
  })

  it('points to gnubok_update_account when the account exists but is inactive', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { account_number: '5410', account_name: 'Förbrukningsinventarier', is_active: false } })
    await expect(
      createAccount.execute({ account_number: '5410' }, 'company-1', 'user-1', supabase as never),
    ).rejects.toThrow(/inaktivt.*is_active=true/s)
  })

  it('rejects a non-BAS number without name/type/balance', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null }) // no existing row
    await expect(
      createAccount.execute({ account_number: NON_BAS_NUMBER }, 'company-1', 'user-1', supabase as never),
    ).rejects.toThrow(/not in the BAS 2026 catalog/)
  })

  it('rejects a percent-style default_vat_rate (must be a fraction)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })
    await expect(
      createAccount.execute(
        { account_number: '5410', default_vat_rate: 25 },
        'company-1', 'user-1', supabase as never,
      ),
    ).rejects.toThrow(/fraction, not percent/)
  })

  it('rejects an account_type inconsistent with the BAS class digit', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null }) // no existing row
    await expect(
      createAccount.execute(
        { account_number: '2999', account_name: 'Fel', account_type: 'expense', normal_balance: 'debit' },
        'company-1', 'user-1', supabase as never,
      ),
    ).rejects.toThrow(/BAS class 2/)
  })

  it('exposes untaxed_reserves in the input schema enum (21xx round-trip)', () => {
    const props = (createAccount.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties
    expect(props.account_type.enum).toContain('untaxed_reserves')
  })
})

describe('gnubok_create_account: staging behaviour (dry_run)', () => {
  it('prefills name/type/balance/SRU from the BAS catalog', async () => {
    const ref = getBASReference('5410')!
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null }) // no existing row
    const result = (await createAccount.execute(
      { account_number: '5410', dry_run: true },
      'company-1', 'user-1', supabase as never,
    )) as { dry_run?: boolean; preview: Record<string, unknown> }

    expect(result.dry_run).toBe(true)
    expect(result.preview).toMatchObject({
      account_number: '5410',
      account_name: ref.account_name,
      account_type: ref.account_type,
      normal_balance: ref.normal_balance,
      plan_type: 'full_bas',
      source: 'bas_2026',
    })
  })

  it('explicit args win over the BAS prefill', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })
    const result = (await createAccount.execute(
      { account_number: '5410', account_name: 'Verktyg och maskiner', dry_run: true },
      'company-1', 'user-1', supabase as never,
    )) as { preview: Record<string, unknown> }

    expect(result.preview.account_name).toBe('Verktyg och maskiner')
    expect(result.preview.source).toBe('bas_2026')
  })

  it('stages a fully-specified custom account as plan_type k1 / source custom', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })
    const result = (await createAccount.execute(
      {
        account_number: NON_BAS_NUMBER,
        account_name: 'Eget specialkonto',
        account_type: 'expense',
        normal_balance: 'debit',
        dry_run: true,
      },
      'company-1', 'user-1', supabase as never,
    )) as { preview: Record<string, unknown> }

    expect(result.preview).toMatchObject({
      account_number: NON_BAS_NUMBER,
      account_name: 'Eget specialkonto',
      account_type: 'expense',
      normal_balance: 'debit',
      plan_type: 'k1',
      source: 'custom',
    })
  })
})

describe('list tools: PostgREST 1000-row cap (fetchAllRows paging)', () => {
  const listAccounts = tools.find((t) => t.name === 'gnubok_list_accounts')!
  const listCustomers = tools.find((t) => t.name === 'gnubok_list_customers')!
  const listSuppliers = tools.find((t) => t.name === 'gnubok_list_suppliers')!
  const listArticles = tools.find((t) => t.name === 'gnubok_list_articles')!

  function makeChartRow(n: number, sortOrder: number | null = n) {
    return {
      account_number: String(n),
      account_name: `Konto ${n}`,
      account_class: Math.floor(n / 1000),
      account_group: String(n).slice(0, 2),
      account_type: 'asset',
      normal_balance: 'debit',
      is_active: true,
      description: null,
      sort_order: sortOrder,
    }
  }

  it('gnubok_list_accounts returns all 1290 accounts across two pages, ordered on account_number', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    // Page 1: exactly PAGE_SIZE rows so fetchAllRows requests a second page.
    // Account 1000 gets a null sort_order (custom account): the JS re-sort
    // must put it last (Postgres nulls-last semantics).
    const page1 = Array.from({ length: 1000 }, (_, i) =>
      makeChartRow(1000 + i, i === 0 ? null : 1000 + i),
    )
    const page2 = Array.from({ length: 290 }, (_, i) => makeChartRow(2000 + i))
    enqueue({ data: page1 })
    enqueue({ data: page2 })

    const result = (await listAccounts.execute({}, 'company-1', 'user-1', supabase as never)) as {
      accounts: { account_number: string }[]
      count: number
    }

    expect(result.count).toBe(1290)
    expect(result.accounts).toHaveLength(1290)
    // Paging invariant: ordered on the UNIQUE account_number, two ranges.
    expect(findCalls('chart_of_accounts', 'order')).toEqual([
      ['account_number', { ascending: true }],
      ['account_number', { ascending: true }],
    ])
    expect(findCalls('chart_of_accounts', 'range')).toEqual([
      [0, 999],
      [1000, 1999],
    ])
    // Visible order: sort_order ascending with nulls last, as before the fix.
    expect(result.accounts[0].account_number).toBe('1001')
    expect(result.accounts[1288].account_number).toBe('2289')
    expect(result.accounts[1289].account_number).toBe('1000')
    // sort_order was fetched only for the re-sort and must not leak out.
    expect('sort_order' in result.accounts[0]).toBe(false)
  })

  it('gnubok_list_customers pages on id and re-sorts by name', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    // Names descend while ids ascend, so the output order proves the re-sort.
    const makeCustomer = (i: number) => ({
      id: `c${String(i).padStart(4, '0')}`,
      name: `Kund ${String(1002 - i).padStart(4, '0')}`,
    })
    enqueue({ data: Array.from({ length: 1000 }, (_, i) => makeCustomer(i)) })
    enqueue({ data: Array.from({ length: 2 }, (_, i) => makeCustomer(1000 + i)) })

    const result = (await listCustomers.execute({}, 'company-1', 'user-1', supabase as never)) as {
      customers: { id: string; name: string }[]
      count: number
    }

    expect(result.count).toBe(1002)
    expect(findCalls('customers', 'order')).toEqual([
      ['id', { ascending: true }],
      ['id', { ascending: true }],
    ])
    expect(findCalls('customers', 'range')).toEqual([
      [0, 999],
      [1000, 1999],
    ])
    expect(result.customers[0].name).toBe('Kund 0001')
    expect(result.customers[1001].name).toBe('Kund 1002')
  })

  it('gnubok_list_suppliers pages on id and re-sorts by name', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    const makeSupplier = (i: number) => ({
      id: `s${String(i).padStart(4, '0')}`,
      name: `Leverantör ${String(1002 - i).padStart(4, '0')}`,
    })
    enqueue({ data: Array.from({ length: 1000 }, (_, i) => makeSupplier(i)) })
    enqueue({ data: Array.from({ length: 2 }, (_, i) => makeSupplier(1000 + i)) })

    const result = (await listSuppliers.execute({}, 'company-1', 'user-1', supabase as never)) as {
      suppliers: { id: string; name: string }[]
      count: number
    }

    expect(result.count).toBe(1002)
    expect(findCalls('suppliers', 'order')).toEqual([
      ['id', { ascending: true }],
      ['id', { ascending: true }],
    ])
    expect(findCalls('suppliers', 'range')).toEqual([
      [0, 999],
      [1000, 1999],
    ])
    expect(result.suppliers[0].name).toBe('Leverantör 0001')
  })

  it('gnubok_list_articles pages on id and re-sorts by name', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    const makeArticle = (i: number) => ({
      id: `a${String(i).padStart(4, '0')}`,
      name: `Artikel ${String(1002 - i).padStart(4, '0')}`,
    })
    enqueue({ data: Array.from({ length: 1000 }, (_, i) => makeArticle(i)) })
    enqueue({ data: Array.from({ length: 2 }, (_, i) => makeArticle(1000 + i)) })

    const result = (await listArticles.execute({}, 'company-1', 'user-1', supabase as never)) as {
      articles: { id: string; name: string }[]
      count: number
    }

    expect(result.count).toBe(1002)
    expect(findCalls('articles', 'order')).toEqual([
      ['id', { ascending: true }],
      ['id', { ascending: true }],
    ])
    expect(findCalls('articles', 'range')).toEqual([
      [0, 999],
      [1000, 1999],
    ])
    expect(result.articles[0].name).toBe('Artikel 0001')
  })

  it('gnubok_list_accounts returns a single short page unchanged', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [makeChartRow(1930), makeChartRow(1910)] })

    const result = (await listAccounts.execute(
      { account_class: 1 },
      'company-1', 'user-1', supabase as never,
    )) as { accounts: { account_number: string }[]; count: number }

    expect(result.count).toBe(2)
    // One page only: 2 < PAGE_SIZE stops the loop.
    expect(findCalls('chart_of_accounts', 'range')).toEqual([[0, 999]])
    // Filters still applied inside the paged query builder.
    expect(findCalls('chart_of_accounts', 'eq')).toEqual(
      expect.arrayContaining([
        ['company_id', 'company-1'],
        ['is_active', true],
        ['account_class', 1],
      ]),
    )
    // Re-sorted by sort_order: 1910 before 1930.
    expect(result.accounts.map((a) => a.account_number)).toEqual(['1910', '1930'])
  })
})

describe('gnubok_update_account', () => {
  it('rejects a non-4-digit account number before any DB call', async () => {
    await expect(
      updateAccount.execute({ account_number: 'abcd' }, 'company-1', 'user-1', noopSupabase),
    ).rejects.toThrow(/4 digits/)
  })

  it('points to gnubok_create_account when the account does not exist', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })
    await expect(
      updateAccount.execute(
        { account_number: '5410', account_name: 'Nytt namn' },
        'company-1', 'user-1', supabase as never,
      ),
    ).rejects.toThrow(/finns inte.*gnubok_create_account/s)
  })

  it('rejects a call with no fields to change', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { account_number: '5410', account_name: 'Förbrukningsinventarier', is_active: true } })
    await expect(
      updateAccount.execute({ account_number: '5410' }, 'company-1', 'user-1', supabase as never),
    ).rejects.toThrow(/Nothing to update/)
  })

  it('dry-run preview carries current values and the requested changes', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: {
        account_number: '5410',
        account_name: 'Förbrukningsinventarier',
        description: null,
        default_vat_code: null,
        default_vat_rate: null,
        sru_code: '7321', // 5410's catalog value (lib/bookkeeping/bas-data)
        is_active: true,
      },
    })
    const result = (await updateAccount.execute(
      { account_number: '5410', account_name: 'Verktyg', is_active: false, dry_run: true },
      'company-1', 'user-1', supabase as never,
    )) as { dry_run?: boolean; preview: { current: Record<string, unknown>; changes: Record<string, unknown> } }

    expect(result.dry_run).toBe(true)
    expect(result.preview.current.account_name).toBe('Förbrukningsinventarier')
    expect(result.preview.changes).toEqual({ account_name: 'Verktyg', is_active: false })
  })

  it('preserves an existing booking rate when only treatment changes', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: {
        account_number: '4056', account_name: 'EU-varor', default_vat_rate: 0.12,
        default_vat_treatment: null, is_active: true,
      },
    })
    const result = (await updateAccount.execute(
      { account_number: '4056', default_vat_treatment: 'reverse_charge_eu_goods', dry_run: true },
      'company-1', 'user-1', supabase as never,
    )) as { preview: { changes: Record<string, unknown> } }

    expect(result.preview.changes).toEqual({
      default_vat_treatment: 'reverse_charge_eu_goods',
    })
  })

  it('can clear a treatment to restore BAS fallback', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: {
        account_number: '3041', account_name: 'Försäljning', default_vat_rate: 0.25,
        default_vat_treatment: 'standard_25', is_active: true,
      },
    })
    const result = (await updateAccount.execute(
      { account_number: '3041', default_vat_treatment: null, dry_run: true },
      'company-1', 'user-1', supabase as never,
    )) as { preview: { changes: Record<string, unknown> } }

    expect(result.preview.changes).toEqual({ default_vat_treatment: null })
  })
})
