import { describe, it, expect } from 'vitest'
import { createTranslator } from 'next-intl'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import { buildDecisionReceipt, type ReceiptContext, type SuggestionLogRow } from '../receipts'
import {
  MAX_OTHER_DECISIONS,
  bookingWhy,
  bookingWhyUserIds,
  compactDecisions,
  evidenceLevel,
  type BookingWhyData,
  type BookingWhyEntry,
  type BookingWhyOptions,
  type BookingWhyTranslate,
  type ReceiptLike,
} from '../receipt-display'
import { attributionWordsFrom } from '@/lib/attribution/format-actor'

const JE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const TX = '11111111-1111-4111-8111-111111111111'
const OP = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a'
const ANNA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const BERTIL = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function translator(locale: 'sv' | 'en'): BookingWhyTranslate {
  // A missing key throws instead of rendering its path, so every key the view asks for must exist.
  const t = createTranslator({ locale, messages: locale === 'sv' ? sv : en, namespace: 'booking_why', onError: (error) => { throw error } })
  return t as unknown as BookingWhyTranslate
}

function attributionWords(locale: 'sv' | 'en') {
  const t = createTranslator({ locale, messages: locale === 'sv' ? sv : en, namespace: 'attribution', onError: (error) => { throw error } })
  return attributionWordsFrom(t as unknown as (key: string, values?: Record<string, string>) => string)
}

const opts = (locale: 'sv' | 'en' = 'sv'): BookingWhyOptions => ({
  t: translator(locale),
  formatWhen: (iso) => `@${iso.slice(0, 10)}`,
  appName: 'Accounted',
  words: attributionWords(locale),
})

const rule = {
  source: 'rule',
  source_id: 'rule:r1',
  rank: 0,
  proposal: { booking: { kind: 'account', account: '5410', vat_treatment: 'standard_25', category: 'expense_equipment' }, debit_account: '5410', credit_account: '1930', vat_treatment: 'standard_25' },
  confidence: 0.92,
  model: null,
  prompt_sha256: null,
  matches_final: true,
}
const assistant = {
  source: 'assistant',
  source_id: `assistant:${TX}`,
  rank: 1,
  proposal: { booking: { kind: 'account', account: '6540', vat_treatment: 'standard_25', category: 'expense_software' }, debit_account: '6540', credit_account: '1930', vat_treatment: 'standard_25' },
  confidence: 0.64,
  model: 'claude-x',
  prompt_sha256: 'abc123',
  matches_final: false,
}
const counterpart = {
  source: 'counterparty_template',
  source_id: 'cp:t1',
  rank: 0,
  proposal: { booking: { kind: 'counterparty', counterparty_template_id: 't1' }, debit_account: '6110', credit_account: '1930', vat_treatment: 'standard_25' },
  confidence: 0.9,
  model: null,
  prompt_sha256: null,
  matches_final: true,
}

function bankRow(overrides: Partial<SuggestionLogRow> = {}): SuggestionLogRow {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    kind: 'bank_line',
    transaction_id: TX,
    inbox_item_id: null,
    document_id: null,
    suggestions: [rule, assistant],
    acted_on: 0,
    final: { journal_entry_id: JE, booking: null, account: '5410', vat_treatment: 'standard_25', lines: [] },
    outcome: 'accepted',
    actor_type: 'user',
    resolved_by: ANNA,
    created_at: '2026-10-12T09:00:00.000Z',
    ...overrides,
  }
}

const userEntryRow = { id: JE, voucher_series: 'A', voucher_number: 12, status: 'posted', committed_actor_type: 'user', committed_actor_label: null, commit_method: 'user_accept' }
const ctx = (entryRow: Record<string, unknown> = userEntryRow, op?: Record<string, unknown>): ReceiptContext => ({
  entries: new Map([[JE, entryRow as never]]),
  operations: op ? new Map([[JE, op as never]]) : new Map(),
})

const zapierOp = {
  id: OP,
  operation_type: 'categorize_transaction',
  actor_type: 'api_key',
  actor_id: 'key-1',
  actor_label: 'Claude',
  risk_level: 'low',
  agent_metadata: { model: 'claude-y', prompt_hash: 'p1' },
  created_at: '2026-10-12T08:58:00.000Z',
  resolved_at: '2026-10-12T09:00:01.000Z',
  journal_entry_id: JE,
  registration_journal_entry_id: null,
}

function entry(overrides: Partial<BookingWhyEntry> = {}): BookingWhyEntry {
  return {
    status: 'posted',
    source_type: 'bank_transaction',
    committed_at: '2026-10-12T09:00:02.000Z',
    committed_actor_type: 'user',
    committed_actor_label: null,
    commit_method: 'user_accept',
    user_id: ANNA,
    ...overrides,
  }
}

const people = {
  [ANNA]: { name: 'Anna Svensson', byra: false, byra_name: null },
  [BERTIL]: { name: 'Bertil Ek', byra: true, byra_name: 'Siffror AB' },
}

/** `receipts` (newest first, as the reader returns them) go through compactDecisions, as the route does; null is "could not be read". */
function data(overrides: Partial<BookingWhyData> & { receipts?: ReceiptLike[] | null } = {}): BookingWhyData {
  const { receipts = [], ...rest } = overrides
  return { entry: entry(), decisions: receipts === null ? null : compactDecisions(receipts), people, ...rest }
}

const rowItems = (view: ReturnType<typeof bookingWhy>, id: string) => view.rows.find((r) => r.id === id)?.items

function rowMap(view: ReturnType<typeof bookingWhy>): Record<string, string> {
  return Object.fromEntries(view.rows.map((r) => [r.id, r.value]))
}

describe('bookingWhy summary', () => {
  it('names the person who accepted a proposal, and when', () => {
    const r = buildDecisionReceipt(bankRow(), ctx())
    const view = bookingWhy(data({ receipts: [r] }), opts())
    expect(view.summary).toEqual({ text: 'Anna Svensson bokförde enligt förslaget', when: '@2026-10-12' })
    expect(bookingWhy(data({ receipts: [r] }), opts('en')).summary?.text).toBe('Anna Svensson booked it as proposed')
  })

  it('says a person changed the proposal, and what changed', () => {
    const r = buildDecisionReceipt(
      bankRow({ outcome: 'changed', final: { journal_entry_id: JE, booking: null, account: '6110', vat_treatment: 'standard_25', lines: [] } }),
      ctx(),
    )
    const view = bookingWhy(data({ receipts: [r] }), opts())
    expect(view.summary?.text).toBe('Anna Svensson ändrade förslaget och bokförde')
    expect(rowMap(view).changes).toBe('Konto 5410 → 6110')
    expect(rowMap(view).grounds).toBe('Ditt val')
  })

  it('says booked by hand when a person acted on no suggestion', () => {
    const r = buildDecisionReceipt(bankRow({ outcome: 'manual', acted_on: null }), ctx())
    const view = bookingWhy(data({ receipts: [r] }), opts())
    expect(view.summary?.text).toBe('Anna Svensson bokförde för hand')
    expect(rowMap(view).proposal).toBe('Inget av 2 förslag användes')
    expect(rowMap(view).grounds).toBe('Ditt val')
  })

  it('names the agent whose staged proposal a person approved', () => {
    const r = buildDecisionReceipt(bankRow(), ctx(userEntryRow, zapierOp))
    const view = bookingWhy(data({ receipts: [r] }), opts())
    expect(view.summary?.text).toBe('Anna Svensson godkände ett förslag från Claude')
    expect(rowMap(view).proposal).toBe('Regel · konto 5410 · från Claude')
  })

  it('names the person the agent staged the proposal for', () => {
    const op = { ...zapierOp, actor_label: 'Claude (Anthropic)', user_id: BERTIL }
    const r = buildDecisionReceipt(bankRow(), ctx(userEntryRow, op))
    const d = data({ receipts: [r] })
    expect(bookingWhyUserIds(d.entry, d.decisions)).toEqual([ANNA, BERTIL])
    const view = bookingWhy(d, opts())
    expect(view.summary?.text).toBe('Anna Svensson godkände ett förslag från Claude åt Bertil Ek')
    expect(rowMap(view).proposal).toBe('Regel · konto 5410 · från Claude åt Bertil Ek')
    expect(bookingWhy(d, opts('en')).summary?.text).toBe('Anna Svensson approved a proposal from Claude for Bertil Ek')
  })

  it("shows the agent's reason as recorded, under its label, right after the proposal", () => {
    const reason = 'Telia every month on 6212; the OCR matches the last eleven.'
    const r = buildDecisionReceipt(bankRow({ pending_operation_id: OP, agent_reason: reason }), ctx(userEntryRow, zapierOp))
    const view = bookingWhy(data({ receipts: [r] }), opts())
    const row = view.rows.find((x) => x.id === 'reason')
    expect(row).toEqual({ id: 'reason', label: 'Agentens motivering', value: reason })
    expect(view.rows.map((x) => x.id).slice(0, 3)).toEqual(['decision', 'proposal', 'reason'])
    expect(bookingWhy(data({ receipts: [r] }), opts('en')).rows.find((x) => x.id === 'reason')?.label).toBe("Agent's reason")
  })

  it('leaves the reason row out when none was recorded', () => {
    const r = buildDecisionReceipt(bankRow(), ctx(userEntryRow, zapierOp))
    expect(bookingWhy(data({ receipts: [r] }), opts()).rows.some((x) => x.id === 'reason')).toBe(false)
    const blank: ReceiptLike = { ...r, agent_reason: '   ' }
    expect(bookingWhy(data({ receipts: [blank] }), opts()).rows.some((x) => x.id === 'reason')).toBe(false)
  })

  it('names an API key and a connected AI by their own name, without the credential wording', () => {
    const apiEntry = { ...userEntryRow, committed_actor_type: 'api_key', committed_actor_label: 'Zapier', commit_method: 'api_key' }
    const r = buildDecisionReceipt(bankRow({ actor_type: 'api_key', resolved_by: null }), ctx(apiEntry))
    const view = bookingWhy(data({ receipts: [r], entry: entry({ committed_actor_type: 'api_key', committed_actor_label: 'Zapier', commit_method: 'api_key' }) }), opts())
    expect(view.summary?.text).toBe('Zapier bokförde enligt förslaget')
    expect(rowMap(view).decision).toBe('Zapier · via API · @2026-10-12')

    const mcpEntry = { ...apiEntry, committed_actor_type: 'mcp_oauth', committed_actor_label: 'Claude (Anthropic)' }
    const m = buildDecisionReceipt(bankRow({ actor_type: 'mcp_oauth', resolved_by: null }), ctx(mcpEntry))
    const mView = bookingWhy(data({ receipts: [m] }), opts())
    expect(mView.summary?.text).toBe('Claude bokförde enligt förslaget')
    expect(rowMap(mView).decision).toBe('Claude · via MCP-anslutning · @2026-10-12')
  })

  it('names the person a key or a connected AI booked for', () => {
    const mcpEntry = { ...userEntryRow, committed_actor_type: 'mcp_oauth', committed_actor_label: 'Claude (Anthropic)', commit_method: 'api_key' }
    const m = buildDecisionReceipt(bankRow({ actor_type: 'mcp_oauth', resolved_by: ANNA }), ctx(mcpEntry))
    const d = data({ receipts: [m] })
    expect(bookingWhyUserIds(d.entry, d.decisions)).toEqual([ANNA])
    const view = bookingWhy(d, opts())
    expect(view.summary?.text).toBe('Claude åt Anna Svensson bokförde enligt förslaget')
    expect(rowMap(view).decision).toBe('Claude åt Anna Svensson · via MCP-anslutning · @2026-10-12')
    // The entry alone (no receipt): the entry's user is the key's owner.
    const alone = bookingWhy(data({ entry: entry({ committed_actor_type: 'api_key', committed_actor_label: 'MCP-klient (OAuth)', commit_method: 'api_key' }) }), opts())
    expect(alone.summary?.text).toBe('Bokförd av AI-anslutning åt Anna Svensson')
  })

  it("names a service account's booking as the account, and the sponsor it answers to", () => {
    const saEntry = { ...userEntryRow, committed_actor_type: 'service_account', committed_actor_label: 'Billo', commit_method: 'api_key' }
    const r = buildDecisionReceipt(bankRow({ actor_type: 'service_account', resolved_by: null }), ctx(saEntry))
    const view = bookingWhy(data({ receipts: [r], entry: entry({ committed_actor_type: 'service_account', committed_actor_label: 'Billo', commit_method: 'api_key' }) }), opts())
    expect(view.summary?.text).toBe('Tjänstekontot Billo bokförde enligt förslaget')
    const sponsored = buildDecisionReceipt(bankRow({ actor_type: 'service_account', resolved_by: BERTIL }), ctx(saEntry))
    expect(bookingWhy(data({ receipts: [sponsored] }), opts()).summary?.text).toBe('Tjänstekontot Billo åt Bertil Ek bokförde enligt förslaget')
  })

  it('does not call an API key booking without a suggestion "by hand"', () => {
    const r = buildDecisionReceipt(bankRow({ actor_type: 'api_key', resolved_by: null, outcome: 'manual', acted_on: null }), ctx({ ...userEntryRow, committed_actor_type: 'api_key', committed_actor_label: 'Zapier' }))
    const view = bookingWhy(data({ receipts: [r] }), opts())
    expect(view.summary?.text).toBe('Bokförd av Zapier')
    // Neither a person's choice nor recorded grounds: no grounds row.
    expect(rowMap(view).grounds).toBeUndefined()
  })

  it('names a byrå user with their byrå', () => {
    const r = buildDecisionReceipt(bankRow({ resolved_by: BERTIL }), ctx())
    expect(bookingWhy(data({ receipts: [r] }), opts()).summary?.text).toBe('Bertil Ek på Siffror AB bokförde enligt förslaget')
    expect(bookingWhy(data({ receipts: [r] }), opts('en')).summary?.text).toBe('Bertil Ek at Siffror AB booked it as proposed')
    const noName = { ...people, [BERTIL]: { name: 'Bertil Ek', byra: true, byra_name: null } }
    expect(bookingWhy(data({ receipts: [r], people: noName }), opts()).summary?.text).toBe('Bertil Ek (byrå) bokförde enligt förslaget')
  })

  it('reads the entry alone when nothing was recorded, without claiming how', () => {
    const view = bookingWhy(data({ entry: entry({ source_type: 'manual' }), receipts: [] }), opts())
    expect(view.summary).toEqual({ text: 'Bokförd av Anna Svensson', when: '@2026-10-12' })
    expect(view.rows.map((r) => r.id)).toEqual(['decision'])
    expect(rowMap(view).decision).toBe('Anna Svensson · i Accounted · @2026-10-12')
  })

  it('reads the entry alone when the receipts could not be read', () => {
    const view = bookingWhy(data({ receipts: null }), opts())
    expect(view.summary?.text).toBe('Bokförd av Anna Svensson')
    expect(view.rows.map((r) => r.id)).toEqual(['decision'])
  })

  it('says what the app booked by itself, under its brand name', () => {
    const view = bookingWhy(data({ entry: entry({ committed_actor_type: 'cron', commit_method: null, user_id: null }) }), { ...opts(), appName: 'Byråns Bokföring' })
    expect(view.summary?.text).toBe('Bokförd av Byråns Bokföring')
    expect(rowMap(view).decision).toBe('Byråns Bokföring · @2026-10-12')
  })

  it('says imported, naming the person only when known', () => {
    expect(bookingWhy(data({ entry: entry({ source_type: 'import', commit_method: null }) }), opts()).summary?.text).toBe('Importerad av Anna Svensson')
    expect(bookingWhy(data({ entry: entry({ source_type: 'import', commit_method: null, user_id: null }) }), opts()).summary?.text).toBe('Importerad')
    expect(bookingWhy(data({ entry: entry({ commit_method: 'migration' }), people: {} }), opts()).summary?.text).toBe('Importerad')
  })

  it('falls back to "a user" when the person could not be resolved', () => {
    expect(bookingWhy(data({ people: {} }), opts()).summary?.text).toBe('Bokförd av en användare')
  })

  it('reads an entry from before the actor columns the way behandlingshistoriken does', () => {
    const view = bookingWhy(data({ entry: entry({ committed_actor_type: null, commit_method: 'api_key', committed_actor_label: 'Gammal nyckel' }) }), opts())
    expect(view.summary?.text).toBe('Bokförd av Gammal nyckel åt Anna Svensson')
  })

  it('shows nothing for an entry that is not booked', () => {
    expect(bookingWhy(data({ entry: entry({ status: 'draft' }) }), opts())).toEqual({ summary: null, rows: [] })
    expect(bookingWhy(data({ entry: entry({ status: 'cancelled' }) }), opts())).toEqual({ summary: null, rows: [] })
  })
})

describe('bookingWhy detail rows', () => {
  it('lists the changed fields of an underlag decision', () => {
    const r = buildDecisionReceipt(
      bankRow({
        kind: 'inbox_item',
        transaction_id: null,
        suggestions: [{ source: 'extraction', source_id: 'doc-1', rank: 0, proposal: { fields: { accounts: ['6110'] } }, confidence: 0.97, model: 'reader-1', prompt_sha256: null, matches_final: false }],
        outcome: 'changed',
        final: { supplier_invoice_id: null, journal_entry_id: JE, fields: {}, lines: [], changed_fields: ['supplier_name', 'total', 'something_new'] },
      }),
      ctx(),
    )
    const rows = rowMap(bookingWhy(data({ receipts: [r] }), opts()))
    expect(rows.changes).toBe('Leverantör, belopp, something_new')
    expect(rows.proposal).toBe('Läst ur underlaget · konto 6110')
    // The model's own score never reaches the view.
    expect(Object.values(rows).join(' ')).not.toMatch(/97|0\.97/)
  })

  it('describes the newest decision on a samlingsverifikat and lists the others', () => {
    const newest = buildDecisionReceipt(bankRow({ id: '33333333-3333-4333-8333-333333333333', created_at: '2026-10-13T09:00:00.000Z' }), ctx())
    const older = buildDecisionReceipt(bankRow({ resolved_by: BERTIL }), ctx())
    const byKey = buildDecisionReceipt(bankRow({ id: '44444444-4444-4444-8444-444444444444', created_at: '2026-10-11T09:00:00.000Z', actor_type: 'api_key', resolved_by: null, outcome: 'manual', acted_on: null }), ctx({ ...userEntryRow, committed_actor_label: 'Zapier' }))
    const view = bookingWhy(data({ receipts: [newest, older, byKey] }), opts())
    expect(view.summary?.when).toBe('@2026-10-13')
    expect(rowMap(view).more).toBe('3 beslut på verifikatet, det senaste visas')
    expect(rowItems(view, 'more')).toEqual([
      '@2026-10-12 · Bertil Ek på Siffror AB · regel',
      // No suggestion acted on: no source.
      '@2026-10-11 · Zapier',
    ])
  })

  it('counts what the list of other decisions leaves out', () => {
    const many = Array.from({ length: 13 }, (_, i) =>
      buildDecisionReceipt(bankRow({ id: `5555555${i.toString(16)}-5555-4555-8555-555555555555`, created_at: `2026-10-${String(20 - i).padStart(2, '0')}T09:00:00.000Z` }), ctx()),
    )
    const view = bookingWhy(data({ receipts: many }), opts())
    const items = rowItems(view, 'more') ?? []
    expect(rowMap(view).more).toBe('13 beslut på verifikatet, det senaste visas')
    expect(items).toHaveLength(MAX_OTHER_DECISIONS + 1)
    expect(items[0]).toBe('@2026-10-19 · Anna Svensson · regel')
    expect(items.at(-1)).toBe('och 2 till')
    expect(rowItems(bookingWhy(data({ receipts: many }), opts('en')), 'more')?.at(-1)).toBe('and 2 more')
  })

  it('leaves out a proposal row when no suggestion was recorded', () => {
    const r = buildDecisionReceipt(bankRow({ suggestions: [], acted_on: null, outcome: 'manual' }), ctx())
    const rows = rowMap(bookingWhy(data({ receipts: [r] }), opts()))
    expect(rows.proposal).toBeUndefined()
    expect(rows.checks).toBeUndefined()
    expect(rows.policy).toBeUndefined()
  })

  it('shows the step-2 rules version, checks and policy verdict when recorded', () => {
    const base = buildDecisionReceipt(bankRow({ suggestions: [counterpart], acted_on: 0 }), ctx())
    const r: ReceiptLike = {
      ...base,
      rule_version: 'bank-proposals.2+0f3c9e1',
      policy_version: 'direct-booking.1;assistant_sure=0.8;counterpart_seen=3;calibrator=none',
      confidence_band: 'direct',
      checks: [
        { id: 'already_booked', result: 'pass', detail: null },
        { id: 'duplicate', result: 'warn', detail: 'force:journal_entry:x' },
        { id: 'period_lock', result: 'pass', detail: null },
        { id: 'brand_new_check', result: 'fail', detail: null },
      ],
    }
    const rows = rowMap(bookingWhy(data({ receipts: [r] }), opts()))
    expect(rows.proposal).toBe('Tidigare bokningar · konto 6110 · regelversion bank-proposals.2')
    expect(rows.grounds).toBe('Stark · så har motparten bokförts förut')
    expect(rows.checks).toBe('inte redan bokförd, dubbletter (varning), öppen period, brand_new_check (underkänd)')
    expect(rows.policy).toBe('Fick bokföras utan granskning · direct-booking.1')

    const enRows = rowMap(bookingWhy(data({ receipts: [{ ...r, confidence_band: 'review' }] }), opts('en')))
    expect(enRows.policy).toBe('Required review · direct-booking.1')
    expect(enRows.grounds).toBe('Likely · how this counterpart was booked before')
  })

  it('keeps the row order fixed', () => {
    const base = buildDecisionReceipt(bankRow({ outcome: 'changed', final: { journal_entry_id: JE, booking: null, account: '6110', vat_treatment: 'reduced_12', lines: [] } }), ctx())
    const r: ReceiptLike = { ...base, checks: [{ id: 'chart', result: 'pass' }], confidence_band: 'review', policy_version: 'direct-booking.1' }
    const view = bookingWhy(data({ receipts: [r, base] }), opts())
    expect(view.rows.map((x) => x.id)).toEqual(['decision', 'proposal', 'grounds', 'changes', 'checks', 'policy', 'more'])
    expect(rowMap(view).changes).toBe('Konto 5410 → 6110, momsbehandling')
    expect(view.rows.find((x) => x.id === 'grounds')?.label).toBe('Grund')
  })

  it('renders every row in English too', () => {
    const r = buildDecisionReceipt(bankRow({ outcome: 'manual', acted_on: null }), ctx(userEntryRow, zapierOp))
    const view = bookingWhy(data({ receipts: [r] }), opts('en'))
    expect(view.summary?.text).toBe('Anna Svensson approved a proposal from Claude')
    expect(rowMap(view)).toMatchObject({
      decision: 'Anna Svensson · in Accounted · @2026-10-12',
      proposal: 'None of the 2 proposals was used · from Claude',
    })
  })
})

describe('evidenceLevel', () => {
  const accepted = (source: string, band?: string) => ({
    ...buildDecisionReceipt(bankRow(), ctx()),
    chosen: { ...buildDecisionReceipt(bankRow(), ctx()).chosen!, source: source as never },
    confidence_band: band ?? null,
  })

  it('maps guesses and readings to likely, whatever the score', () => {
    for (const s of ['assistant', 'extraction', 'catalog', 'recent']) {
      expect(evidenceLevel(accepted(s, 'direct'))?.level).toBe('likely')
    }
  })

  it('maps a rule to strong unless the recorded band asked for a review', () => {
    expect(evidenceLevel(accepted('rule'))?.level).toBe('strong')
    expect(evidenceLevel(accepted('rule', 'direct'))?.level).toBe('strong')
    expect(evidenceLevel(accepted('rule', 'review'))?.level).toBe('likely')
  })

  it('calls counterpart history strong only when the band says it was settled', () => {
    expect(evidenceLevel(accepted('counterparty_template', 'direct'))?.level).toBe('strong')
    expect(evidenceLevel(accepted('counterparty_template', 'review'))?.level).toBe('likely')
    expect(evidenceLevel(accepted('counterparty_template'))).toBeNull()
  })

  it("is the person's choice when a person booked without or against a suggestion", () => {
    expect(evidenceLevel(buildDecisionReceipt(bankRow({ outcome: 'manual', acted_on: null }), ctx()))?.level).toBe('your_choice')
    expect(evidenceLevel(buildDecisionReceipt(bankRow({ outcome: 'changed' }), ctx()))?.level).toBe('your_choice')
  })

  it('records no level for an agent or an approved agent choice it cannot see the grounds of', () => {
    expect(evidenceLevel(buildDecisionReceipt(bankRow({ outcome: 'manual', acted_on: null, actor_type: 'api_key' }), ctx()))).toBeNull()
    expect(evidenceLevel(buildDecisionReceipt(bankRow({ outcome: 'manual', acted_on: null }), ctx(userEntryRow, zapierOp)))).toBeNull()
  })
})

describe('compactDecisions', () => {
  it('keeps the newest booked receipt in full and the others as when, who and source', () => {
    const newest = buildDecisionReceipt(bankRow({ id: '33333333-3333-4333-8333-333333333333', created_at: '2026-10-13T09:00:00.000Z' }), ctx())
    const dismissed = buildDecisionReceipt(bankRow({ id: '66666666-6666-4666-8666-666666666666', outcome: 'dismissed', final: null, acted_on: null }), ctx())
    const older = buildDecisionReceipt(bankRow({ resolved_by: BERTIL }), ctx())
    const d = compactDecisions([newest, dismissed, older])
    expect(d.latest).toBe(newest)
    expect(d.total).toBe(2)
    // Nothing but what the list renders: no candidates, accounts or models.
    expect(d.others).toEqual([{ decided_at: '2026-10-12T09:00:00.000Z', decided_by: { actor_type: 'user', user_id: BERTIL, label: null }, source: 'rule' }])
  })

  it('lists at most ten others and counts all of them', () => {
    const many = Array.from({ length: 30 }, () => buildDecisionReceipt(bankRow(), ctx()))
    const d = compactDecisions(many)
    expect(d.others).toHaveLength(MAX_OTHER_DECISIONS)
    expect(d.total).toBe(30)
  })

  it('answers no latest for no receipts', () => {
    expect(compactDecisions([])).toEqual({ latest: null, others: [], total: 0 })
  })
})

describe('bookingWhyUserIds', () => {
  it('asks for the deciding person, or the entry user without a receipt', () => {
    const r = buildDecisionReceipt(bankRow({ resolved_by: BERTIL }), ctx())
    expect(bookingWhyUserIds(entry(), compactDecisions([r]))).toEqual([BERTIL])
    expect(bookingWhyUserIds(entry(), compactDecisions([]))).toEqual([ANNA])
    expect(bookingWhyUserIds(entry(), null)).toEqual([ANNA])
  })

  it('also asks for the people behind the other decisions, once each, the person a key acted for included', () => {
    const newest = buildDecisionReceipt(bankRow({ resolved_by: ANNA }), ctx())
    const others = [BERTIL, ANNA, BERTIL].map((id) => buildDecisionReceipt(bankRow({ resolved_by: id }), ctx()))
    const byKey = buildDecisionReceipt(bankRow({ actor_type: 'api_key', resolved_by: 'key-user' }), ctx())
    expect(bookingWhyUserIds(entry(), compactDecisions([newest, ...others, byKey]))).toEqual([ANNA, BERTIL, 'key-user'])
  })

  it('asks for no one when an API key with no recorded person or the app decided', () => {
    const r = buildDecisionReceipt(bankRow({ actor_type: 'api_key', resolved_by: null }), ctx())
    expect(bookingWhyUserIds(entry(), compactDecisions([r]))).toEqual([])
    expect(bookingWhyUserIds(entry({ committed_actor_type: 'system' }), compactDecisions([]))).toEqual([])
  })
})
