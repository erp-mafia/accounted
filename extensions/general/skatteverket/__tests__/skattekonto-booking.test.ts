import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { guessCounterAccount } from '../lib/skattekonto-booking'

/**
 * System seeds mirror supabase/migrations/20260519100000_skattekonto_rules.sql.
 * Kept in lockstep so the resolver behaves identically against mock and real DB.
 */
const SEED_RULES = [
  {
    id: 'sys-1', priority: 10, pattern: 'inbetalning bokförd,inbetalning,överföring från bank',
    amount_min: null, amount_max: null, company_type: 'all',
    counter_account: '__PRIMARY_SEK__', counter_account_ef: null,
    label: 'Inbetalning till skattekonto', active: true,
  },
  {
    id: 'sys-2', priority: 10, pattern: 'utbetalning,återbetalning',
    amount_min: null, amount_max: null, company_type: 'all',
    counter_account: '__PRIMARY_SEK__', counter_account_ef: null,
    label: 'Utbetalning från skattekonto', active: true,
  },
  {
    id: 'sys-3', priority: 20, pattern: 'debiterad preliminärskatt,preliminärskatt,f-skatt,fskatt',
    amount_min: null, amount_max: null, company_type: 'all',
    counter_account: '2510', counter_account_ef: '2012',
    label: 'Preliminär skatt', active: true,
  },
  {
    id: 'sys-4', priority: 20, pattern: 'arbetsgivaravgift,sociala avgifter,agi',
    amount_min: null, amount_max: null, company_type: 'all',
    counter_account: '2730', counter_account_ef: null,
    label: 'Arbetsgivaravgifter', active: true,
  },
  {
    id: 'sys-5', priority: 20, pattern: 'avdragen skatt,personalskatt,a-skatt',
    amount_min: null, amount_max: null, company_type: 'all',
    counter_account: '2710', counter_account_ef: null,
    label: 'Avdragen skatt anställda', active: true,
  },
  {
    id: 'sys-6', priority: 20, pattern: 'mervärdesskatt,moms,momsdeklaration',
    amount_min: null, amount_max: null, company_type: 'all',
    counter_account: '2650', counter_account_ef: null,
    label: 'Redovisningskonto för moms', active: true,
  },
  {
    id: 'sys-7', priority: 25, pattern: 'skattetillägg,förseningsavgift',
    amount_min: null, amount_max: null, company_type: 'all',
    counter_account: '6992', counter_account_ef: null,
    label: 'Ej avdragsgilla skatteavgifter', active: true,
  },
  {
    id: 'sys-8', priority: 30, pattern: 'kostnadsränta',
    amount_min: null, amount_max: null, company_type: 'all',
    counter_account: '8423', counter_account_ef: null,
    label: 'Kostnadsränta skattekonto', active: true,
  },
  {
    id: 'sys-9', priority: 30, pattern: 'intäktsränta',
    amount_min: null, amount_max: null, company_type: 'all',
    counter_account: '8314', counter_account_ef: null,
    label: 'Intäktsränta skattekonto', active: true,
  },
]

function makeSupabase() {
  return createQueuedMockSupabase()
}

/**
 * Queue setup helper. Each call to guessCounterAccount makes:
 *   1. skattekonto_rules query (always)
 *   2. cash_accounts query (only when a __PRIMARY_SEK__ rule matches)
 *
 * primarySekRow lets a test stub a cash_accounts.getPrimary result so the
 * sentinel resolves to that row's ledger_account. When omitted, the fallback
 * '1930' is used (sentinel hit but no row in cash_accounts).
 */
function enqueueRules(
  enqueue: ReturnType<typeof createQueuedMockSupabase>['enqueue'],
  rules = SEED_RULES,
  primarySekRow: { ledger_account: string } | null = null,
) {
  enqueue({ data: rules })
  enqueue({ data: primarySekRow }) // cash_accounts.maybeSingle()
  // anyPrimary fallback inside getPrimary triggers only when first lookup is null
  if (!primarySekRow) enqueue({ data: null })
}

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
    enqueueRules(enqueue, SEED_RULES, { ledger_account: '1932' })
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

  it('uses 2510 for AB preliminär skatt and 2012 for EF', async () => {
    const { supabase, enqueue } = makeSupabase()
    enqueue({ data: SEED_RULES })
    expect(
      (await guessCounterAccount(supabase as unknown as SupabaseClient, 'company-1', 'Debiterad preliminärskatt', 'aktiebolag'))?.account,
    ).toBe('2510')

    enqueue({ data: SEED_RULES })
    expect(
      (await guessCounterAccount(supabase as unknown as SupabaseClient, 'company-1', 'Debiterad preliminärskatt', 'enskild_firma'))?.account,
    ).toBe('2012')
  })

  it('routes employer payroll taxes to 2730 (clearing/redovisningskonto, not 2731 accrual)', async () => {
    const { supabase, enqueue } = makeSupabase()
    enqueue({ data: SEED_RULES })
    expect(
      (await guessCounterAccount(supabase as unknown as SupabaseClient, 'company-1', 'Arbetsgivaravgifter januari', 'aktiebolag'))?.account,
    ).toBe('2730')

    enqueue({ data: SEED_RULES })
    expect(
      (await guessCounterAccount(supabase as unknown as SupabaseClient, 'company-1', 'Sociala avgifter Q1', 'aktiebolag'))?.account,
    ).toBe('2730')
  })

  it('routes deducted income tax to 2710', async () => {
    const { supabase, enqueue } = makeSupabase()
    enqueue({ data: SEED_RULES })
    expect(
      (await guessCounterAccount(supabase as unknown as SupabaseClient, 'company-1', 'Avdragen skatt anställda', 'aktiebolag'))?.account,
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
    // Förseningsavgift contains the substring "förseningsavgift". The "moms" suffix
    // would also match a lower-priority rule (2650), but priority 25 (penalty)
    // beats priority 20 (moms): penalty routing wins.
    expect(
      (await guessCounterAccount(supabase as unknown as SupabaseClient, 'company-1', 'Förseningsavgift arbetsgivardeklaration', 'aktiebolag'))?.account,
    ).toBe('6992')
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
