import { describe, it, expect, vi, beforeEach } from 'vitest'
import { loadBankingSummary } from '../inputs'
import { selectAtoms, formatMagnitude, buildCurrencyUncertaintyNotes } from '../atom-selection'
import type { ComposerInputs } from '../inputs'

// The composer prompt is the INPUT to the model that writes a company's
// standing agent instructions. A magnitude that is wrong here does not
// mislead one answer, it gets baked into durable instructions. So the rule
// these tests pin is: a number is only ever printed as "kr" when it really is
// kronor, and a magnitude we cannot express in kronor is printed as unknown,
// never as a confident figure and never silently dropped.

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }))

vi.mock('../client', () => ({
  getAnthropic: () => ({ messages: { create: createMock } }),
  OPUS_MODEL: 'test-opus',
  SONNET_MODEL: 'test-sonnet',
  THINKING_BUDGET_STANDARD: 1,
  THINKING_BUDGET_DEEP: 1,
}))

// sv-SE thousands separators are non-breaking spaces; build expectations the
// same way the renderer does so the assertions are not whitespace-fragile.
const sv = (n: number) => n.toLocaleString('sv-SE')

interface TxRow {
  description: string | null
  amount: number
  currency?: string | null
  amount_sek?: number | null
  exchange_rate?: number | null
  date?: string
  journal_entry_id?: string | null
}

function buildSupabase(rows: TxRow[]) {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'gte', 'order', 'limit']) {
    chain[m] = () => chain
  }
  chain.then = (resolve: (v: unknown) => void) => resolve({ data: rows, error: null })
  return { from: vi.fn().mockReturnValue(chain) } as never
}

function tx(overrides: Partial<TxRow> & { description: string; amount: number }): TxRow {
  return {
    currency: 'SEK',
    amount_sek: null,
    exchange_rate: null,
    date: '2026-03-01',
    journal_entry_id: 'je-1',
    ...overrides,
  }
}

const ATOM_INDEX = [
  {
    id: 'horizontal/swedish-vat',
    tier: 'horizontal' as const,
    title: 'Moms',
    description: 'Svensk moms.',
    sni_prefixes: [],
    trigger_signals: {},
    estimated_tokens: 100,
    version: 1,
  },
]

function makeInputs(overrides: Partial<ComposerInputs> = {}): ComposerInputs {
  return {
    companyId: 'company-1',
    companyName: 'Testbolaget AB',
    entityType: 'aktiebolag',
    ticSnapshot: null,
    ticFetchedAt: null,
    companySettings: null,
    activeEmployees: null,
    sieSummary: null,
    bankingSummary: null,
    atomIndex: ATOM_INDEX,
    userIsConfirmedDirector: false,
    ...overrides,
  }
}

function mockSelectionResponse() {
  createMock.mockResolvedValue({
    content: [
      {
        type: 'tool_use',
        name: 'compose_agent_profile',
        input: {
          horizontal_atoms: ['horizontal/swedish-vat'],
          vertical_atoms: [],
          modifier_atoms: [],
          is_multi_vertical: false,
          verification_questions: ['Vad är er vanligaste kundtyp?'],
          uncertainty_notes: [],
        },
      },
    ],
  })
}

// Runs the real prompt builder and hands back the text the model would see.
async function renderPrompt(inputs: ComposerInputs): Promise<string> {
  mockSelectionResponse()
  await selectAtoms(inputs)
  const call = createMock.mock.calls[0][0] as { messages: { content: string }[] }
  return call.messages[0].content
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('loadBankingSummary currency handling', () => {
  it('keeps a SEK-only company on a single kr magnitude', async () => {
    const supabase = buildSupabase([
      tx({ description: 'ACME AB faktura', amount: -300000 }),
      tx({ description: 'ACME AB faktura', amount: -112000 }),
    ])

    const summary = await loadBankingSummary(supabase, 'company-1')

    expect(summary).not.toBeNull()
    expect(summary!.currencies).toEqual(['SEK'])
    expect(summary!.volume_rows_without_sek).toBe(0)
    expect(summary!.unconvertible_counterparties).toEqual([])
    expect(summary!.top_counterparties[0]).toMatchObject({
      name: 'ACME AB faktura',
      abs_amount: 412000,
      rows_without_sek: 0,
      by_currency: [{ currency: 'SEK', abs_amount: 412000 }],
    })
  })

  it('never folds a foreign amount into the SEK total when no rate is stored', async () => {
    const supabase = buildSupabase([
      tx({ description: 'ACME AB faktura', amount: -412000 }),
      tx({ description: 'Hetzner Online', amount: -30000, currency: 'EUR' }),
    ])

    const summary = await loadBankingSummary(supabase, 'company-1')

    const hetzner = summary!.top_counterparties.find((c) => c.name === 'Hetzner Online')!
    // The 30 000 is EUR. It must not appear anywhere as a SEK amount.
    expect(hetzner.abs_amount).toBe(0)
    expect(hetzner.rows_without_sek).toBe(1)
    expect(hetzner.by_currency).toEqual([{ currency: 'EUR', abs_amount: 30000 }])
    // Monthly volume counts the SEK row only, and says how much it left out.
    expect(summary!.monthly_volume).toBe(Math.round(412000 / 12))
    expect(summary!.volume_rows_with_sek).toBe(1)
    expect(summary!.volume_rows_without_sek).toBe(1)
    expect(summary!.currencies).toEqual(['EUR', 'SEK'])
  })

  it('uses the stored SEK equivalent for a foreign row when there is one', async () => {
    const supabase = buildSupabase([
      tx({ description: 'Hetzner Online', amount: -30000, currency: 'EUR', amount_sek: -345000 }),
    ])

    const summary = await loadBankingSummary(supabase, 'company-1')

    expect(summary!.top_counterparties[0]).toMatchObject({
      abs_amount: 345000,
      rows_without_sek: 0,
      by_currency: [{ currency: 'EUR', abs_amount: 30000 }],
    })
    expect(summary!.monthly_volume).toBe(Math.round(345000 / 12))
  })

  it('derives the SEK equivalent from exchange_rate when amount_sek is absent', async () => {
    const supabase = buildSupabase([
      tx({ description: 'Hetzner Online', amount: -1000, currency: 'EUR', exchange_rate: 11.5 }),
    ])

    const summary = await loadBankingSummary(supabase, 'company-1')

    expect(summary!.top_counterparties[0]).toMatchObject({
      abs_amount: 11500,
      rows_without_sek: 0,
    })
  })

  it('reports an unknown monthly volume rather than a zero when nothing converts', async () => {
    const supabase = buildSupabase([
      tx({ description: 'Stripe Inc', amount: -12000, currency: 'USD' }),
      tx({ description: 'Hetzner Online', amount: -30000, currency: 'EUR' }),
    ])

    const summary = await loadBankingSummary(supabase, 'company-1')

    expect(summary!.monthly_volume).toBeNull()
    expect(summary!.volume_rows_with_sek).toBe(0)
    expect(summary!.volume_rows_without_sek).toBe(2)
  })

  it('surfaces a rate-less counterparty that the SEK ranking would have dropped', async () => {
    // 20 SEK counterparties outrank the foreign one on the kr scale, so the
    // top-20 slice would silently swallow it.
    const rows: TxRow[] = []
    for (let i = 0; i < 20; i++) {
      rows.push(tx({ description: `Kund nummer ${String.fromCharCode(65 + i)}`, amount: 100000 + i }))
    }
    rows.push(tx({ description: 'Stripe Inc', amount: -12000, currency: 'USD' }))

    const summary = await loadBankingSummary(buildSupabase(rows), 'company-1')

    expect(summary!.top_counterparties.map((c) => c.name)).not.toContain('Stripe Inc')
    expect(summary!.unconvertible_counterparties.map((c) => c.name)).toEqual(['Stripe Inc'])
  })
})

describe('formatMagnitude', () => {
  it('renders plain SEK exactly as a bare kr figure', () => {
    expect(
      formatMagnitude({
        abs_amount: 412000,
        by_currency: [{ currency: 'SEK', abs_amount: 412000 }],
        rows_without_sek: 0,
      }),
    ).toBe(`${sv(412000)} kr`)
  })

  it('keeps each currency in its own unit and adds the SEK equivalent', () => {
    const out = formatMagnitude({
      abs_amount: 757000,
      by_currency: [
        { currency: 'SEK', abs_amount: 412000 },
        { currency: 'EUR', abs_amount: 30000 },
      ],
      rows_without_sek: 0,
    })
    expect(out).toBe(`${sv(412000)} SEK + ${sv(30000)} EUR (motsvarar ${sv(757000)} kr)`)
  })

  it('says the SEK value is unknown instead of printing 0 kr', () => {
    const out = formatMagnitude({
      abs_amount: 0,
      by_currency: [{ currency: 'EUR', abs_amount: 30000 }],
      rows_without_sek: 2,
    })
    expect(out).toContain(`${sv(30000)} EUR`)
    expect(out).toContain('SEK-motsvarighet OKÄND')
    // No number is ever labelled kronor here.
    expect(out).not.toMatch(/\d[\s ]*kr/)
  })

  it('marks a partially convertible magnitude as partial', () => {
    const out = formatMagnitude({
      abs_amount: 412000,
      by_currency: [
        { currency: 'SEK', abs_amount: 412000 },
        { currency: 'USD', abs_amount: 12000 },
      ],
      rows_without_sek: 1,
    })
    expect(out).toContain(`varav ${sv(412000)} kr har känd SEK-motsvarighet`)
    expect(out).toContain('saknar växelkurs')
  })
})

describe('composer prompt rendering', () => {
  it('renders a SEK-only company exactly as before', async () => {
    const summary = await loadBankingSummary(
      buildSupabase([
        tx({ description: 'ACME AB faktura', amount: -300000 }),
        tx({ description: 'ACME AB faktura', amount: -112000 }),
      ]),
      'company-1',
    )

    const prompt = await renderPrompt(makeInputs({ bankingSummary: summary }))

    expect(prompt).toContain(`Snittvolym per månad: ${sv(Math.round(412000 / 12))} kr`)
    expect(prompt).toContain(`ACME AB faktura: ${sv(412000)} kr (ut, bokförd)`)
    // No caveats invented for a company that has nothing to caveat.
    expect(prompt).not.toContain('GOLV')
    expect(prompt).not.toContain('Valutor i underlaget')
    expect(prompt).not.toContain('Motparter utan känd SEK-motsvarighet')
  })

  // KEY TEST: this is the finding. A 30 000 EUR counterparty was rendered as
  // "30 000 kr" and fed straight into durable instruction generation.
  it('does not give a multi-currency company a single misleading kr figure', async () => {
    const summary = await loadBankingSummary(
      buildSupabase([
        tx({ description: 'ACME AB faktura', amount: -412000 }),
        tx({ description: 'Hetzner Online', amount: -30000, currency: 'EUR' }),
      ]),
      'company-1',
    )

    const prompt = await renderPrompt(makeInputs({ bankingSummary: summary }))

    // The EUR magnitude must never be labelled kronor.
    expect(prompt).not.toContain(`${sv(30000)} kr`)
    expect(prompt).toContain(`${sv(30000)} EUR`)
    expect(prompt).toContain('SEK-motsvarighet OKÄND')
    // And the volume is honestly reported as a floor.
    expect(prompt).toContain(`Snittvolym per månad: ${sv(Math.round(412000 / 12))} kr (GOLV:`)
    expect(prompt).toContain('Valutor i underlaget: EUR, SEK')
  })

  it('keeps rate-less counterparties visible instead of dropping them at the slice', async () => {
    const rows: TxRow[] = []
    for (let i = 0; i < 20; i++) {
      rows.push(tx({ description: `Kund nummer ${String.fromCharCode(65 + i)}`, amount: 100000 + i }))
    }
    rows.push(tx({ description: 'Stripe Inc', amount: -12000, currency: 'USD' }))
    const summary = await loadBankingSummary(buildSupabase(rows), 'company-1')

    const prompt = await renderPrompt(makeInputs({ bankingSummary: summary }))

    expect(prompt).toContain('Motparter utan känd SEK-motsvarighet')
    expect(prompt).toContain(`Stripe Inc: ${sv(12000)} USD`)
    expect(prompt).not.toContain(`Stripe Inc: ${sv(12000)} kr`)
  })

  it('states that the monthly volume is unknown when no row converts', async () => {
    const summary = await loadBankingSummary(
      buildSupabase([
        tx({ description: 'Stripe Inc', amount: -12000, currency: 'USD' }),
        tx({ description: 'Hetzner Online', amount: -30000, currency: 'EUR' }),
      ]),
      'company-1',
    )

    const prompt = await renderPrompt(makeInputs({ bankingSummary: summary }))

    expect(prompt).toContain('Snittvolym per månad: OKÄND')
    expect(prompt).not.toMatch(/Snittvolym per månad: [\d\s ]+ kr/)
  })

  it('applies the same unit rule to the SIE counterparty rollup', async () => {
    const prompt = await renderPrompt(
      makeInputs({
        sieSummary: {
          year_count: 2,
          top_accounts: [{ account: '3011', abs_amount: 900000 }],
          top_counterparties: [
            {
              name: 'Hetzner Online',
              abs_amount: 0,
              by_currency: [{ currency: 'EUR', abs_amount: 30000 }],
              rows_without_sek: 3,
            },
          ],
          unconvertible_counterparties: [],
        },
      }),
    )

    expect(prompt).toContain(`Hetzner Online: ${sv(30000)} EUR`)
    expect(prompt).not.toContain(`Hetzner Online: ${sv(30000)} kr`)
    // Ledger balances are genuinely SEK and keep their bare kr rendering.
    expect(prompt).toContain(`${sv(900000)} kr`)
  })
})

describe('buildCurrencyUncertaintyNotes', () => {
  it('returns nothing for a SEK-only company', async () => {
    const summary = await loadBankingSummary(
      buildSupabase([tx({ description: 'ACME AB faktura', amount: -412000 })]),
      'company-1',
    )
    expect(buildCurrencyUncertaintyNotes(makeInputs({ bankingSummary: summary }))).toEqual([])
  })

  it('flags multi-currency data and the rows left out of the volume', async () => {
    const summary = await loadBankingSummary(
      buildSupabase([
        tx({ description: 'ACME AB faktura', amount: -412000 }),
        tx({ description: 'Hetzner Online', amount: -30000, currency: 'EUR' }),
      ]),
      'company-1',
    )

    const notes = buildCurrencyUncertaintyNotes(makeInputs({ bankingSummary: summary }))

    expect(notes.join(' ')).toContain('flera valutor')
    expect(notes.join(' ')).toContain('golv')
  })

  it('appends the caveats to the selection so they reach the durable profile', async () => {
    const summary = await loadBankingSummary(
      buildSupabase([
        tx({ description: 'ACME AB faktura', amount: -412000 }),
        tx({ description: 'Hetzner Online', amount: -30000, currency: 'EUR' }),
      ]),
      'company-1',
    )
    mockSelectionResponse()

    const selection = await selectAtoms(makeInputs({ bankingSummary: summary }))

    expect(selection.uncertainty_notes.join(' ')).toContain('flera valutor')
  })
})
