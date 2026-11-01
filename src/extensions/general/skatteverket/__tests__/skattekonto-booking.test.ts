import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'

// The company's skattekonto account (lib/skatteverket/skattekonto-account.ts):
// 1630 here, what every company resolved to before the setting existed.
vi.mock('@/lib/skatteverket/skattekonto-account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/skatteverket/skattekonto-account')>()),
  resolveSkattekontoAccount: vi.fn(async () => '1630'),
}))

// The 1650 balance behind the VAT-refund routing (floor + sum); both are
// covered in lib/reconciliation/__tests__/gl-balance.test.ts, and one test
// below runs the real pair end to end.
const sumAccountBalanceMock = vi.fn()
const findOpeningBalanceFloorMock = vi.fn()
vi.mock('@/lib/reconciliation/gl-balance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/reconciliation/gl-balance')>()
  return {
    ...actual,
    sumAccountBalance: (...args: unknown[]) => sumAccountBalanceMock(...args),
    findOpeningBalanceFloor: (...args: unknown[]) => findOpeningBalanceFloorMock(...args),
  }
})

import { attachBookingSuggestions, guessCounterAccount } from '../lib/skattekonto-booking'

beforeEach(() => {
  sumAccountBalanceMock.mockReset()
  findOpeningBalanceFloorMock.mockReset()
  findOpeningBalanceFloorMock.mockResolvedValue(null)
})

/**
 * System seeds mirror supabase/migrations/20260519100000_skattekonto_rules.sql
 * plus the follow-up corrections 20260817120100 (EF preliminärskatt 2012 ->
 * 2013), 20260819200100 (requires_employer on the 'avdragen skatt' rule),
 * 20261018132300 (the rot/rut kvittning rule ahead of utbetalning) and
 * 20261027190100 (the penalty rule ahead of the tax rules, with 'förs.avgift').
 * Kept in lockstep, in the database's priority order, so the resolver behaves
 * identically against mock and real DB.
 */
const SEED_RULES = [
  {
    id: 'sys-0', priority: 5, pattern: 'kvittning av utbetalning för rot,kvittning av utbetalning för rut',
    amount_min: null, amount_max: null, company_type: 'all',
    counter_account: '1513', counter_account_ef: null,
    label: 'Rot/rut-utbetalning kvittad på skattekontot', active: true, requires_employer: false,
  },
  {
    id: 'sys-1', priority: 10, pattern: 'inbetalning bokförd,inbetalning,överföring från bank',
    amount_min: null, amount_max: null, company_type: 'all',
    counter_account: '__PRIMARY_SEK__', counter_account_ef: null,
    label: 'Inbetalning till skattekonto', active: true, requires_employer: false,
  },
  {
    id: 'sys-2', priority: 10, pattern: 'utbetalning,återbetalning',
    amount_min: null, amount_max: null, company_type: 'all',
    counter_account: '__PRIMARY_SEK__', counter_account_ef: null,
    label: 'Utbetalning från skattekonto', active: true, requires_employer: false,
  },
  {
    id: 'sys-7', priority: 15, pattern: 'skattetillägg,förseningsavgift,förs.avgift',
    amount_min: null, amount_max: null, company_type: 'all',
    counter_account: '6992', counter_account_ef: null,
    label: 'Ej avdragsgilla skatteavgifter', active: true, requires_employer: false,
  },
  {
    id: 'sys-3', priority: 20, pattern: 'debiterad preliminärskatt,preliminärskatt,f-skatt,fskatt',
    amount_min: null, amount_max: null, company_type: 'all',
    counter_account: '2510', counter_account_ef: '2013',
    label: 'Preliminär skatt', active: true, requires_employer: false,
  },
  {
    id: 'sys-4', priority: 20, pattern: 'arbetsgivaravgift,sociala avgifter,agi',
    amount_min: null, amount_max: null, company_type: 'all',
    counter_account: '2731', counter_account_ef: null,
    label: 'Arbetsgivaravgifter', active: true, requires_employer: false,
  },
  {
    id: 'sys-5', priority: 20, pattern: 'avdragen skatt,personalskatt,a-skatt',
    amount_min: null, amount_max: null, company_type: 'all',
    counter_account: '2710', counter_account_ef: null,
    label: 'Avdragen skatt anställda', active: true, requires_employer: true,
  },
  {
    id: 'sys-6', priority: 20, pattern: 'mervärdesskatt,moms,momsdeklaration',
    amount_min: null, amount_max: null, company_type: 'all',
    counter_account: '2650', counter_account_ef: null,
    label: 'Redovisningskonto för moms', active: true, requires_employer: false,
  },
  {
    id: 'sys-8', priority: 30, pattern: 'kostnadsränta',
    amount_min: null, amount_max: null, company_type: 'all',
    counter_account: '8423', counter_account_ef: null,
    label: 'Kostnadsränta skattekonto', active: true, requires_employer: false,
  },
  {
    id: 'sys-9', priority: 30, pattern: 'intäktsränta',
    amount_min: null, amount_max: null, company_type: 'all',
    counter_account: '8314', counter_account_ef: null,
    label: 'Intäktsränta skattekonto', active: true, requires_employer: false,
  },
]

function makeSupabase() {
  return createQueuedMockSupabase()
}

/**
 * Queue setup helper. Each call to guessCounterAccount makes:
 *   1. skattekonto_rules query (always)
 *   2. cash_accounts queries (only when a __PRIMARY_SEK__ rule matches)
 *
 * primarySekRow lets a test stub the is_primary row resolvePrimaryBankAccount
 * reads, so the sentinel resolves to that row's ledger_account. When omitted,
 * the fallback '1930' is used (sentinel hit but no row in cash_accounts).
 */
function enqueueRules(
  enqueue: ReturnType<typeof createQueuedMockSupabase>['enqueue'],
  rules = SEED_RULES,
  primarySekRow: { ledger_account: string; enabled: boolean; currency: string } | null = null,
) {
  enqueue({ data: rules })
  enqueue({ data: primarySekRow }) // cash_accounts.maybeSingle()
  // The enabled SEK listing behind it runs only when there is no usable primary
  if (!primarySekRow) enqueue({ data: [] })
}

const AB_ONLY_RULE = {
  id: 'ab-1', priority: 15, pattern: 'slutlig skatt',
  amount_min: null, amount_max: null, company_type: 'aktiebolag',
  counter_account: '2510', counter_account_ef: null,
  label: 'Slutlig skatt (bolagsskatt)', active: true, requires_employer: false,
}

describe('guessCounterAccount: rules scoped to a legal form', () => {
  it('applies an aktiebolag rule to an ekonomisk förening (same bolagsskatt on 2510, IL 65 kap. 10 §)', async () => {
    const { supabase, enqueue } = makeSupabase()
    enqueueRules(enqueue, [AB_ONLY_RULE, ...SEED_RULES])
    const guess = await guessCounterAccount(
      supabase as unknown as SupabaseClient, 'company-1', 'Slutlig skatt 2025', 'ekonomisk_forening',
    )
    expect(guess?.account).toBe('2510')
  })

  it('keeps an aktiebolag rule away from forms that do not book their own income tax', async () => {
    for (const entityType of ['enskild_firma', 'ideell_forening'] as const) {
      const { supabase, enqueue } = makeSupabase()
      enqueueRules(enqueue, [AB_ONLY_RULE, ...SEED_RULES])
      const guess = await guessCounterAccount(
        supabase as unknown as SupabaseClient, 'company-1', 'Slutlig skatt 2025', entityType,
      )
      expect(guess?.account, entityType).not.toBe('2510')
    }
  })
})

describe('guessCounterAccount', () => {
  it('routes "Inbetalning bokförd" via __PRIMARY_SEK__ sentinel to 1930 fallback', async () => {
    const { supabase, enqueue } = makeSupabase()
    enqueueRules(enqueue)
    const guess = await guessCounterAccount(
      supabase as unknown as SupabaseClient, 'company-1', 'Inbetalning bokförd 240412', 'aktiebolag',
    )
    expect(guess?.account).toBe('1930')
  })

  it('resolves __PRIMARY_SEK__ to the cash_accounts.is_primary row when present', async () => {
    const { supabase, enqueue } = makeSupabase()
    enqueueRules(enqueue, SEED_RULES, { ledger_account: '1932', enabled: true, currency: 'SEK' })
    const guess = await guessCounterAccount(
      supabase as unknown as SupabaseClient, 'company-1', 'Inbetalning bokförd', 'aktiebolag',
    )
    expect(guess?.account).toBe('1932')
  })

  it('routes refund-style descriptions via __PRIMARY_SEK__ sentinel', async () => {
    const { supabase, enqueue } = makeSupabase()
    enqueueRules(enqueue)
    expect(
      (await guessCounterAccount(supabase as unknown as SupabaseClient, 'company-1', 'Utbetalning 1234', 'aktiebolag'))?.account,
    ).toBe('1930')

    enqueueRules(enqueue)
    expect(
      (await guessCounterAccount(supabase as unknown as SupabaseClient, 'company-1', 'Återbetalning av moms', 'aktiebolag'))?.account,
    ).toBe('1930')
  })

  it('uses 2510 for AB preliminär skatt and 2013 for EF (regression: 2012 is not standard BAS)', async () => {
    const { supabase, enqueue } = makeSupabase()
    enqueue({ data: SEED_RULES })
    expect(
      (await guessCounterAccount(supabase as unknown as SupabaseClient, 'company-1', 'Debiterad preliminärskatt', 'aktiebolag'))?.account,
    ).toBe('2510')

    enqueue({ data: SEED_RULES })
    expect(
      (await guessCounterAccount(supabase as unknown as SupabaseClient, 'company-1', 'Debiterad preliminärskatt', 'enskild_firma'))?.account,
    ).toBe('2013')
  })

  // 2731 matches the salary module's AVGIFTER_LIABILITY credit so the SKV draw
  // clears the same account (issue #1870); the accrual account is 2940, not 2731.
  it('routes employer payroll taxes to 2731 (same account the salary module credits)', async () => {
    const { supabase, enqueue } = makeSupabase()
    enqueue({ data: SEED_RULES })
    expect(
      (await guessCounterAccount(supabase as unknown as SupabaseClient, 'company-1', 'Arbetsgivaravgifter januari', 'aktiebolag'))?.account,
    ).toBe('2731')

    enqueue({ data: SEED_RULES })
    expect(
      (await guessCounterAccount(supabase as unknown as SupabaseClient, 'company-1', 'Sociala avgifter Q1', 'aktiebolag'))?.account,
    ).toBe('2731')
  })

  it('routes deducted income tax to 2710 for an aktiebolag', async () => {
    const { supabase, enqueue } = makeSupabase()
    enqueue({ data: SEED_RULES })
    // requires_employer only gates enskild_firma: an AB with a personalskatt
    // line by definition has payroll, so 2710 stays unconditional.
    expect(
      (await guessCounterAccount(supabase as unknown as SupabaseClient, 'company-1', 'Avdragen skatt anställda', 'aktiebolag'))?.account,
    ).toBe('2710')
  })

  it('returns null for "avdragen skatt" on an enskild firma without employer registration', async () => {
    const { supabase, enqueue } = makeSupabase()
    enqueue({ data: SEED_RULES })
    // The EF's skattekonto is the owner's PERSONAL account: "Avdragen skatt"
    // there is almost always A-skatt an outside employer withheld from the
    // owner's private salary. Auto-crediting 2710 would fabricate a payroll
    // liability, so the gate forces the NO_COUNTER_ACCOUNT path instead.
    expect(
      await guessCounterAccount(supabase as unknown as SupabaseClient, 'company-1', 'Avdragen skatt', 'enskild_firma'),
    ).toBeNull()
  })

  it('keeps 2710 for "avdragen skatt" on an employer-registered enskild firma', async () => {
    const { supabase, enqueue } = makeSupabase()
    enqueue({ data: SEED_RULES })
    // An EF that genuinely runs payroll (employer_registered) withholds tax
    // from real third-party employees: 2710 is then correct, same as an AB.
    expect(
      (await guessCounterAccount(supabase as unknown as SupabaseClient, 'company-1', 'Avdragen skatt', 'enskild_firma', undefined, true))?.account,
    ).toBe('2710')
  })

  it('routes VAT settlements to 2650', async () => {
    const { supabase, enqueue } = makeSupabase()
    enqueue({ data: SEED_RULES })
    expect(
      (await guessCounterAccount(supabase as unknown as SupabaseClient, 'company-1', 'Mervärdesskatt mars', 'aktiebolag'))?.account,
    ).toBe('2650')

    enqueue({ data: SEED_RULES })
    expect(
      (await guessCounterAccount(supabase as unknown as SupabaseClient, 'company-1', 'Moms Q1 2025', 'aktiebolag'))?.account,
    ).toBe('2650')
  })

  it('routes interest to 8423 (kostnadsränta) and 8314 (skattefri intäktsränta)', async () => {
    const { supabase, enqueue } = makeSupabase()
    enqueue({ data: SEED_RULES })
    expect(
      (await guessCounterAccount(supabase as unknown as SupabaseClient, 'company-1', 'Kostnadsränta skattekonto', 'aktiebolag'))?.account,
    ).toBe('8423')

    enqueue({ data: SEED_RULES })
    // Skattekontoräntan är skattefri per IL 8 kap 7 §: 8314, inte 8313.
    expect(
      (await guessCounterAccount(supabase as unknown as SupabaseClient, 'company-1', 'Intäktsränta skattekonto', 'aktiebolag'))?.account,
    ).toBe('8314')
  })

  it('routes skattetillägg and förseningsavgift to 6992 (non-deductible)', async () => {
    const { supabase, enqueue } = makeSupabase()
    enqueue({ data: SEED_RULES })
    expect(
      (await guessCounterAccount(supabase as unknown as SupabaseClient, 'company-1', 'Skattetillägg 20%', 'aktiebolag'))?.account,
    ).toBe('6992')

    enqueue({ data: SEED_RULES })
    expect(
      (await guessCounterAccount(supabase as unknown as SupabaseClient, 'company-1', 'Förseningsavgift arbetsgivardeklaration', 'aktiebolag'))?.account,
    ).toBe('6992')
  })

  it('routes a penalty that names its tax to 6992, ahead of the tax rule (20261027190100)', async () => {
    // Skatteverket's own texts: the late fee abbreviates "Förs.avgift" and names
    // the moms declaration, so the moms rule (2650) matched it first until the
    // penalty rule moved ahead of the tax rules.
    for (const text of ['Förs.avgift moms/arbetsgivardeklaration', 'Skattetillägg moms jul', 'Skattetillägg arbetsgivaravgift mars']) {
      const { supabase, enqueue } = makeSupabase()
      enqueue({ data: SEED_RULES })
      expect((await guessCounterAccount(supabase as unknown as SupabaseClient, 'company-1', text, 'aktiebolag'))?.account).toBe('6992')
    }
  })

  it('does NOT route plain omprövning to 6992: underlying tax rules win', async () => {
    const { supabase, enqueue } = makeSupabase()
    enqueue({ data: SEED_RULES })
    // "Omprövning av momsdeklaration" should route to moms (2650), because
    // omprövning is a re-assessment of the underlying tax, not a penalty.
    expect(
      (await guessCounterAccount(supabase as unknown as SupabaseClient, 'company-1', 'Omprövning av momsdeklaration', 'aktiebolag'))?.account,
    ).toBe('2650')
  })

  it('returns null for anstånd: SKV-side deferral, GL does not move', async () => {
    const { supabase, enqueue } = makeSupabase()
    enqueue({ data: SEED_RULES })
    expect(
      await guessCounterAccount(supabase as unknown as SupabaseClient, 'company-1', 'Anstånd med skattebetalning', 'aktiebolag'),
    ).toBeNull()
  })

  it('returns null when no keyword matches', async () => {
    const { supabase, enqueue } = makeSupabase()
    enqueue({ data: SEED_RULES })
    expect(
      await guessCounterAccount(supabase as unknown as SupabaseClient, 'company-1', 'Något konstigt vi inte känner igen', 'aktiebolag'),
    ).toBeNull()
  })

  it('matches case-insensitively (via __PRIMARY_SEK__ sentinel)', async () => {
    const { supabase, enqueue } = makeSupabase()
    enqueueRules(enqueue)
    expect(
      (await guessCounterAccount(supabase as unknown as SupabaseClient, 'company-1', 'INBETALNING BOKFÖRD 240412', 'aktiebolag'))?.account,
    ).toBe('1930')
  })

  it('returns null when the rules table is empty', async () => {
    const { supabase, enqueue } = makeSupabase()
    enqueue({ data: [] })
    expect(
      await guessCounterAccount(supabase as unknown as SupabaseClient, 'company-1', 'Inbetalning bokförd', 'aktiebolag'),
    ).toBeNull()
  })
})

// Agent feedback seq 975032: the momsavräkning books a net VAT receivable as
// D 1650, and the seed rule sent Skatteverket's refund to K 2650, leaving 1650
// open and a phantom VAT debt on 2650. The refund now clears 1650 while 1650
// holds a debit balance on the event date.
describe('guessCounterAccount: a VAT refund clears the 1650 receivable', () => {
  const refundText = 'Moms juli 2026 - sept 2026'
  const guess = (supabase: unknown, text: string, belopp: number) =>
    guessCounterAccount(supabase as SupabaseClient, 'company-1', text, 'aktiebolag', belopp, false, '2026-10-05')

  it('credits 1650 when the settlement left a receivable there', async () => {
    const { supabase, enqueue } = makeSupabase()
    enqueue({ data: SEED_RULES })
    sumAccountBalanceMock.mockResolvedValue(1240)

    const match = await guess(supabase, refundText, 1240)

    expect(match).toEqual({ account: '1650', label: 'Momsfordran' })
    expect(sumAccountBalanceMock).toHaveBeenCalledWith(supabase, 'company-1', '1650', { cutoffDate: '2026-10-05' })
  })

  it('keeps 2650 when 1650 holds no receivable', async () => {
    const { supabase, enqueue } = makeSupabase()
    enqueue({ data: SEED_RULES })
    sumAccountBalanceMock.mockResolvedValue(0)

    expect((await guess(supabase, refundText, 1240))?.account).toBe('2650')
  })

  it('keeps 2650 for a VAT charge (negative event) without reading 1650', async () => {
    const { supabase, enqueue } = makeSupabase()
    enqueue({ data: SEED_RULES })
    sumAccountBalanceMock.mockResolvedValue(1240)

    expect((await guess(supabase, refundText, -1240))?.account).toBe('2650')
    expect(sumAccountBalanceMock).not.toHaveBeenCalled()
  })

  it('keeps 2650 for an omprövning or beslut, which re-assesses an earlier period', async () => {
    sumAccountBalanceMock.mockResolvedValue(1240)
    for (const text of ['Omprövning av momsdeklaration', 'Beslut moms 2026-06']) {
      const { supabase, enqueue } = makeSupabase()
      enqueue({ data: SEED_RULES })
      expect((await guess(supabase, text, 1240))?.account).toBe('2650')
    }
    expect(sumAccountBalanceMock).not.toHaveBeenCalled()
  })

  it('keeps 2650 when the 1650 read fails', async () => {
    const { supabase, enqueue } = makeSupabase()
    enqueue({ data: SEED_RULES })
    sumAccountBalanceMock.mockResolvedValue(null)

    expect((await guess(supabase, refundText, 1240))?.account).toBe('2650')
  })

  it('reads 1650 from the latest ingående balans, never over the years it restates', async () => {
    const { supabase, enqueue } = makeSupabase()
    enqueue({ data: SEED_RULES })
    findOpeningBalanceFloorMock.mockResolvedValue({ date: '2026-01-01', amount: 3000, entryIds: ['ib-2026'] })
    sumAccountBalanceMock.mockResolvedValue(1240)

    expect((await guess(supabase, refundText, 1240))?.account).toBe('1650')
    expect(findOpeningBalanceFloorMock).toHaveBeenCalledWith(supabase, 'company-1', '1650', '2026-10-05')
    expect(sumAccountBalanceMock).toHaveBeenCalledWith(supabase, 'company-1', '1650', {
      fromDate: '2026-01-01',
      cutoffDate: '2026-10-05',
    })
  })

  it('keeps 2650 without summing when the IB read fails', async () => {
    const { supabase, enqueue } = makeSupabase()
    enqueue({ data: SEED_RULES })
    findOpeningBalanceFloorMock.mockRejectedValue(new Error('statement timeout'))
    sumAccountBalanceMock.mockResolvedValue(1240)

    expect((await guess(supabase, refundText, 1240))?.account).toBe('2650')
    expect(sumAccountBalanceMock).not.toHaveBeenCalled()
  })

  it('clears 1650 within 1 kr either way and carries the gap as 3740 rounding', async () => {
    const cases: Array<[number, number, { account: string; oreRounding?: number }]> = [
      // [refund, receivable on 1650, expected]
      [1241, 1240, { account: '1650', oreRounding: 1 }], // refund 1 kr above: K 3740
      [1239, 1240, { account: '1650', oreRounding: -1 }], // refund 1 kr below: D 3740
      [1240.3, 1240, { account: '1650', oreRounding: 0.3 }],
      [1240, 1240, { account: '1650' }], // exact: no rounding line
      [1242, 1240, { account: '2650' }], // 2 kr above: no rounding, rule account
      [1238, 1240, { account: '2650' }], // 2 kr below
      [1240, 3000, { account: '2650' }], // a receivable far larger than the refund
    ]
    for (const [refund, receivable, expected] of cases) {
      const { supabase, enqueue } = makeSupabase()
      enqueue({ data: SEED_RULES })
      sumAccountBalanceMock.mockResolvedValue(receivable)
      const match = await guess(supabase, refundText, refund)
      expect({ account: match?.account, oreRounding: match?.oreRounding }, `${refund} vs ${receivable}`).toEqual({
        account: expected.account,
        oreRounding: expected.oreRounding,
      })
    }
  })

  it("keeps a company's own rule that points at 2650: only the system seed is re-routed", async () => {
    const { supabase, enqueue } = makeSupabase()
    enqueue({
      data: [
        {
          id: 'own-1', company_id: 'company-1', priority: 5, pattern: 'moms',
          amount_min: null, amount_max: null, company_type: 'all',
          counter_account: '2650', counter_account_ef: null,
          label: 'Egen momsregel', active: true, requires_employer: false,
        },
        ...SEED_RULES,
      ],
    })
    sumAccountBalanceMock.mockResolvedValue(1240)

    expect(await guess(supabase, refundText, 1240)).toEqual({ account: '2650', label: 'Egen momsregel' })
    expect(sumAccountBalanceMock).not.toHaveBeenCalled()
  })

  // Review of MR !34: an unfloored sum counts the year an IB restates twice.
  // FY2025 left D 3000 on 1650, the IB repeats it on 2026-01-01, and a refund
  // in February cleared it. The floored balance on a later refund is 0 (the
  // unfloored one would still say 3000), so the later refund keeps 2650.
  it('end to end with the real floor and sum: a receivable a refund already cleared is not found again', async () => {
    const actual = await vi.importActual<typeof import('@/lib/reconciliation/gl-balance')>('@/lib/reconciliation/gl-balance')
    findOpeningBalanceFloorMock.mockImplementation(actual.findOpeningBalanceFloor)
    sumAccountBalanceMock.mockImplementation(actual.sumAccountBalance)
    const { supabase, enqueue, findCalls } = makeSupabase()
    enqueue({ data: SEED_RULES })
    // findOpeningBalanceFloor: the IB on 1650 as public.account_ib_floor answers it.
    enqueue({ data: { floor_date: '2026-01-01', amount: 3000, entry_ids: ['ib-2026'] } })
    // sumAccountBalance from the IB date: the IB and the February refund.
    enqueue({ data: [{ id: 'ib-2026' }, { id: 'refund-feb' }] })
    enqueue({
      data: [
        { id: 'l1', journal_entry_id: 'ib-2026', debit_amount: 3000, credit_amount: 0 },
        { id: 'l2', journal_entry_id: 'refund-feb', debit_amount: 0, credit_amount: 3000 },
      ],
    })

    expect((await guess(supabase, refundText, 1240))?.account).toBe('2650')
    expect(supabase.rpc).toHaveBeenCalledWith('account_ib_floor', {
      p_company_id: 'company-1',
      p_account_number: '1650',
      p_through: '2026-10-05',
    })
    expect(findCalls('journal_entries', 'gte')).toContainEqual(['entry_date', '2026-01-01'])
    expect(findCalls('journal_entries', 'lte')).toContainEqual(['entry_date', '2026-10-05'])
  })
})

// crm#1255: Skatteverket sets a rot/rut payout off on the skattekonto when the
// company owes tax ("Kvittning av utbetalning för rot- och rutarbeten"). The
// text contains "utbetalning", so the generic payout rule booked it against
// the bank although no money reached it, and left the 1513 receivable open.
// The kvittning clears the receivable instead (swedish-invoice-compliance:
// SKV's payout is Debit 1930 / Credit 1513; set off, 1630 takes the debit).
describe('guessCounterAccount: a rot/rut kvittning clears the receivable, never the bank', () => {
  const kvittningText = 'Kvittning av utbetalning för rot- och rutarbeten'

  it('books the kvittning against 1513 without touching the bank (regression)', async () => {
    const { supabase, enqueue, findCalls } = makeSupabase()
    enqueueRules(enqueue)

    expect(
      await guessCounterAccount(supabase as unknown as SupabaseClient, 'company-1', kvittningText, 'aktiebolag', 7202),
    ).toEqual({ account: '1513', label: 'Rot/rut-utbetalning kvittad på skattekontot' })
    // The primary bank account is never even looked up.
    expect(findCalls('cash_accounts', 'select')).toEqual([])
  })

  it('books it the same way for an enskild firma', async () => {
    const { supabase, enqueue } = makeSupabase()
    enqueueRules(enqueue)

    expect(
      (await guessCounterAccount(supabase as unknown as SupabaseClient, 'company-1', kvittningText, 'enskild_firma', 4447))?.account,
    ).toBe('1513')
  })

  it('keeps an ordinary payout and a returned payout on the bank', async () => {
    const { supabase, enqueue } = makeSupabase()
    enqueueRules(enqueue)
    expect(
      (await guessCounterAccount(supabase as unknown as SupabaseClient, 'company-1', 'Utbetalning', 'aktiebolag', -15000))?.account,
    ).toBe('1930')

    enqueueRules(enqueue)
    expect(
      (await guessCounterAccount(supabase as unknown as SupabaseClient, 'company-1', 'Återsänd utbetalning från bank', 'aktiebolag', 9000))?.account,
    ).toBe('1930')
  })

  it("leaves a private buyer's preliminär skattereduktion unmatched", async () => {
    const { supabase, enqueue } = makeSupabase()
    enqueueRules(enqueue)
    expect(
      await guessCounterAccount(
        supabase as unknown as SupabaseClient, 'company-1', 'Preliminär skattereduktion för rot/rut/grön teknik', 'enskild_firma', -7500,
      ),
    ).toBeNull()
  })
})

// accounted#68: the seed rule sent every avgift draw to 2731 while a company
// whose payroll books the liability on the group account 2730 (another payroll
// system, the SIE history it brought) carried it there, so 2730 and 2731 drifted
// apart with opposite balances. The seed's 2731 now follows the account the
// company's own liability was last booked on (swedish-payroll bas-7xxx.md:
// 2731 or 2730 consistently, never both in one company).
describe('guessCounterAccount: the avgift draw clears the account the liability sits on', () => {
  const drawText = 'Arbetsgivaravgift sept 2026'
  const guess = (supabase: unknown, text = drawText, belopp = -22319) =>
    guessCounterAccount(supabase as SupabaseClient, 'company-1', text, 'aktiebolag', belopp, false, '2026-10-12')
  const liabilityBooking = (account: string, entryDate = '2026-09-25') => ({
    entry_date: entryDate,
    journal_entry_lines: [
      { account_number: '7510', debit_amount: 22319, credit_amount: 0 },
      { account_number: account, debit_amount: 0, credit_amount: 22319 },
    ],
  })

  it('debits 2730 when the payroll books the liability there (regression)', async () => {
    const { supabase, enqueue, findCall } = makeSupabase()
    enqueue({ data: SEED_RULES })
    enqueue({ data: [liabilityBooking('2730')] })

    expect(await guess(supabase)).toEqual({ account: '2730', label: 'Arbetsgivaravgifter' })
    // Read up to the event date: the draw clears what was booked before it.
    expect(findCall('journal_entries', 'lte')).toEqual(['entry_date', '2026-10-12'])
  })

  it('keeps 2731 when the salary run here books the liability on 2731', async () => {
    const { supabase, enqueue } = makeSupabase()
    enqueue({ data: SEED_RULES })
    enqueue({ data: [liabilityBooking('2731')] })

    expect((await guess(supabase))?.account).toBe('2731')
  })

  it('keeps 2731 when no liability booking is found', async () => {
    const { supabase, enqueue } = makeSupabase()
    enqueue({ data: SEED_RULES })
    enqueue({ data: [] })

    expect((await guess(supabase))?.account).toBe('2731')
  })

  it('keeps 2731 when the liability read fails', async () => {
    const { supabase, enqueue } = makeSupabase()
    enqueue({ data: SEED_RULES })
    enqueue({ error: { message: 'timeout' } })

    expect((await guess(supabase))?.account).toBe('2731')
  })

  it('follows the liability on a positive avgift decision too', async () => {
    const { supabase, enqueue } = makeSupabase()
    enqueue({ data: SEED_RULES })
    enqueue({ data: [liabilityBooking('2730')] })

    expect((await guess(supabase, 'Beslut 260703 arbetsgivaravgift mars 2026', 1200))?.account).toBe('2730')
  })

  it('does not read the liability for other events', async () => {
    const { supabase, enqueue, findCalls } = makeSupabase()
    enqueue({ data: SEED_RULES })

    expect((await guess(supabase, 'Avdragen skatt sept 2026', -5000))?.account).toBe('2710')
    expect(findCalls('journal_entries', 'select')).toEqual([])
  })

  it("keeps a company's own avgift rule: only the system seed is re-routed", async () => {
    const { supabase, enqueue, findCalls } = makeSupabase()
    enqueue({
      data: [
        {
          id: 'own-1', company_id: 'company-1', priority: 5, pattern: 'arbetsgivaravgift',
          amount_min: null, amount_max: null, company_type: 'all',
          counter_account: '2731', counter_account_ef: null,
          label: 'Egen avgiftsregel', active: true, requires_employer: false,
        },
        ...SEED_RULES,
      ],
    })
    enqueue({ data: [liabilityBooking('2730')] })

    expect(await guess(supabase)).toEqual({ account: '2731', label: 'Egen avgiftsregel' })
    expect(findCalls('journal_entries', 'select')).toEqual([])
  })

  it('suggests the same account in the list', async () => {
    const { supabase, enqueue } = makeSupabase()
    enqueue({ data: SEED_RULES })
    enqueue({ data: { entity_type: 'aktiebolag', employer_registered: true } })
    enqueue({ data: [liabilityBooking('2730')] })

    const [row] = await attachBookingSuggestions(supabase as unknown as SupabaseClient, 'company-1', [
      {
        transaktionstext: drawText,
        belopp_skatteverket: -22319,
        journal_entry_id: null,
        status: 'booked',
        transaktionsdatum: '2026-10-12',
      },
    ])

    expect(row.booking_suggestion).toMatchObject({ account: '2730', label: 'Arbetsgivaravgifter' })
  })
})

// One resolver behind every door (resolveCounterAccount): the single-event
// guess and the list's suggestion must name the same account for the same
// event, rules and company, including the employer gate, the primary-SEK
// sentinel and the 1650 refund routing. The booking path is the third caller;
// skattekonto-booking-batch.test.ts covers it against the same seeds.
describe('one counter-account resolver: guess and suggestion agree', () => {
  const cases: Array<{
    name: string
    text: string
    belopp: number
    entityType: 'aktiebolag' | 'enskild_firma'
    employer?: boolean
    receivable?: number
    expected: string | null
  }> = [
    { name: 'interest income', text: 'Intäktsränta', belopp: 12, entityType: 'aktiebolag', expected: '8314' },
    { name: 'EF preliminärskatt', text: 'Debiterad preliminärskatt', belopp: -900, entityType: 'enskild_firma', expected: '2013' },
    { name: 'AB preliminärskatt', text: 'Debiterad preliminärskatt', belopp: -900, entityType: 'aktiebolag', expected: '2510' },
    { name: 'EF A-skatt without employer (gated)', text: 'Avdragen skatt', belopp: -500, entityType: 'enskild_firma', expected: null },
    { name: 'EF A-skatt as employer', text: 'Avdragen skatt', belopp: -500, entityType: 'enskild_firma', employer: true, expected: '2710' },
    { name: 'payout to the primary SEK account', text: 'Utbetalning', belopp: 3000, entityType: 'aktiebolag', expected: '1931' },
    { name: 'rot/rut payout set off on the skattekonto', text: 'Kvittning av utbetalning för rot- och rutarbeten', belopp: 7202, entityType: 'aktiebolag', expected: '1513' },
    { name: 'VAT charged', text: 'Mervärdesskatt mars', belopp: -3000, entityType: 'aktiebolag', expected: '2650' },
    { name: 'VAT refund clearing 1650', text: 'Moms juli 2026 - sept 2026', belopp: 1240, entityType: 'aktiebolag', receivable: 1240, expected: '1650' },
  ]

  for (const c of cases) {
    it(c.name, async () => {
      sumAccountBalanceMock.mockResolvedValue(c.receivable ?? 0)
      const primary = { ledger_account: '1931', enabled: true, currency: 'SEK' }

      const single = makeSupabase()
      enqueueRules(single.enqueue, SEED_RULES, primary)
      const guess = await guessCounterAccount(
        single.supabase as unknown as SupabaseClient,
        'company-1',
        c.text,
        c.entityType,
        c.belopp,
        c.employer ?? false,
        '2026-10-05',
      )

      const list = makeSupabase()
      list.enqueue({ data: SEED_RULES })
      list.enqueue({ data: { entity_type: c.entityType, employer_registered: c.employer ?? false } })
      list.enqueue({ data: primary })
      const [row] = await attachBookingSuggestions(list.supabase as unknown as SupabaseClient, 'company-1', [
        {
          transaktionstext: c.text,
          belopp_skatteverket: c.belopp,
          journal_entry_id: null,
          status: 'booked',
          transaktionsdatum: '2026-10-05',
        },
      ])

      expect(guess?.account ?? null).toBe(c.expected)
      expect(row.booking_suggestion?.account ?? null).toBe(c.expected)
    })
  }
})
