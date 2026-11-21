import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { AuditLogEntry } from '@/types'
import {
  AUDITED_TABLES,
  EMPLOYEE_PAY_FIELDS,
  GLOBAL_ACTIONS,
  actorWithVerified,
  appReleaseEvent,
  appReleaseEvents,
  auditRowToEvent,
  buildBehandlingshistorikExport,
  collapseBursts,
  collectionCaseEvents,
  collectionDecisionEvent,
  commitEventFromEntry,
  decisionEvents,
  diffFields,
  formatActorLabel,
  formatStockholmTimestamp,
  formatVerifiedLabel,
  generateBehandlingshistorik,
  rattelseEvent,
  sieImportEvents,
  sortEvents,
  type RawBehandlingshistorikEvent,
} from '../behandlingshistorik'
import { SOURCE_TYPE_LABELS_SV } from '../systemdokumentation'
import { JournalEntrySourceTypeSchema } from '@/lib/api/schemas'
import { buildDecisionReceipts, type SuggestionLogRow } from '@/lib/suggestion-log/receipts'

// ============================================================
// Fixtures
// ============================================================

let seq = 0
function auditRow(overrides: Partial<AuditLogEntry>): AuditLogEntry {
  seq += 1
  return {
    id: `audit-${seq}`,
    user_id: 'user-1',
    company_id: 'company-1',
    action: 'UPDATE',
    table_name: 'journal_entries',
    record_id: 'rec-1',
    actor_id: 'user-1',
    actor_type: 'user',
    actor_label: null,
    old_state: null,
    new_state: null,
    description: null,
    created_at: '2026-03-10T10:00:00.000Z',
    ...overrides,
  }
}

function rawEvent(overrides: Partial<RawBehandlingshistorikEvent>): RawBehandlingshistorikEvent {
  seq += 1
  return {
    id: `ev-${seq}`,
    occurred_at: '2026-03-10T10:00:00.000Z',
    category: 'kontoplan',
    code: 'account.created',
    event: 'Konto tillagt',
    object: '1930 Företagskonto',
    actor: { type: 'user', user_id: 'user-1', actor_label: null },
    details: [],
    source: 'audit_log',
    count: 1,
    ...overrides,
  }
}

const baseEntry = {
  id: 'entry-1',
  voucher_series: 'A',
  voucher_number: 12,
  entry_date: '2026-03-09',
  description: 'Hyra mars',
  source_type: 'manual',
  status: 'posted',
  committed_at: '2026-03-10T09:30:00.000Z',
  user_id: 'user-1',
  committed_actor_type: null,
  committed_actor_label: null,
  commit_method: 'user_accept',
  reverses_id: null,
  correction_of_id: null,
}

// ============================================================
// audit_log row selection: the SQL function must track the constants
// ============================================================

/** The newest migration that (re)defines behandlingshistorik_sources: the live definition. */
function liveSourcesMigration(): string {
  const dir = path.join(__dirname, '..', '..', '..', '..', 'supabase', 'migrations')
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) => readFileSync(path.join(dir, f), 'utf-8').includes('FUNCTION public.behandlingshistorik_sources('))
  expect(files.length).toBeGreaterThan(0)
  return readFileSync(path.join(dir, files[files.length - 1]), 'utf-8')
}

/** The string literals of the first `<column> = ANY (ARRAY[...])` in the SQL. */
function arrayLiteral(sql: string, column: string): string[] {
  const match = sql.match(new RegExp(`a\\.${column} = ANY \\(ARRAY\\[([^\\]]*)\\]\\)`))
  expect(match).not.toBeNull()
  return [...match![1].matchAll(/'([^']+)'/g)].map((m) => m[1])
}

describe('behandlingshistorik_sources: the rows it selects', () => {
  it('reads exactly AUDITED_TABLES and GLOBAL_ACTIONS', () => {
    const sql = liveSourcesMigration()
    expect(arrayLiteral(sql, 'table_name')).toEqual([...AUDITED_TABLES])
    expect(arrayLiteral(sql, 'action')).toEqual([...GLOBAL_ACTIONS])
  })

  // The function leaves these rows in the database because no event can come
  // from them; if a normaliser ever renders one, the SQL must stop excluding it.
  it('leaves out only rows auditRowToEvent turns into nothing', () => {
    const states = [
      null,
      { status: 'draft', voucher_series: 'A', voucher_number: 1, description: 'x', entry_date: '2026-03-01' },
      { status: 'posted', voucher_series: 'A', voucher_number: 1, description: 'x', entry_date: '2026-03-01' },
      { status: 'reversed', voucher_series: 'A', voucher_number: 1 },
      { file_name: 'kvitto.pdf', journal_entry_id: 'entry-1' },
    ]
    for (const old_state of states) {
      for (const new_state of states) {
        for (const action of ['INSERT', 'COMMIT'] as const) {
          expect(auditRowToEvent(auditRow({ table_name: 'journal_entries', action, old_state, new_state }))).toBeNull()
        }
        for (const action of ['INSERT', 'UPDATE'] as const) {
          expect(auditRowToEvent(auditRow({ table_name: 'document_attachments', action, old_state, new_state }))).toBeNull()
        }
      }
    }
    // A draft being edited: neither state posted or reversed.
    for (const status of [undefined, null, 'draft', 'cancelled', 5, true]) {
      const draft = { status, voucher_series: 'A', voucher_number: 1, description: 'före', entry_date: '2026-03-01', notes: 'a' }
      expect(auditRowToEvent(auditRow({
        table_name: 'journal_entries', action: 'UPDATE', old_state: draft, new_state: { ...draft, description: 'efter', notes: 'b' },
      }))).toBeNull()
    }
    // ...while an UPDATE of a posted verifikat still renders.
    const posted = { status: 'posted', voucher_series: 'A', voucher_number: 1, description: 'före' }
    expect(auditRowToEvent(auditRow({
      table_name: 'journal_entries', action: 'UPDATE', old_state: posted, new_state: { ...posted, description: 'efter' },
    }))).not.toBeNull()
  })

  it('excludes those classes, and only those, in the SQL', () => {
    const sql = liveSourcesMigration()
    expect(sql).toContain("(a.table_name = 'journal_entries' AND a.action IN ('INSERT', 'COMMIT'))")
    expect(sql).toContain("(a.table_name = 'document_attachments' AND a.action IN ('INSERT', 'UPDATE'))")
    expect(sql).toContain("coalesce(a.old_state->>'status', '') NOT IN ('posted', 'reversed')")
  })
})

// ============================================================
// diffFields
// ============================================================

describe('diffFields', () => {
  it('reports only allow-listed keys that changed, in allow-list order', () => {
    const { lines, keys } = diffFields(
      { a: 1, b: 'x', c: true, noise: 1 },
      { a: 1, b: 'y', c: false, noise: 2 },
      { c: 'C-etikett', b: 'B-etikett' },
    )
    expect(keys).toEqual(['c', 'b'])
    expect(lines).toEqual(['C-etikett: Ja → Nej', 'B-etikett: x → y'])
  })

  it('renders null/empty as (tomt) and maps known setting values to Swedish', () => {
    const { lines } = diffFields(
      { accounting_method: null },
      { accounting_method: 'cash' },
      { accounting_method: 'Redovisningsmetod' },
    )
    expect(lines).toEqual(['Redovisningsmetod: (tomt) → Kontantmetoden'])
  })
})

// ============================================================
// commitEventFromEntry
// ============================================================

describe('commitEventFromEntry', () => {
  it('turns a posted entry into a bokförd event with registreringsdatum = committed_at', () => {
    const ev = commitEventFromEntry(baseEntry)!
    expect(ev).toMatchObject({
      id: 'entry:entry-1',
      occurred_at: '2026-03-10T09:30:00.000Z',
      category: 'verifikation',
      code: 'journal_entry.committed',
      event: 'Verifikation bokförd',
      object: 'A12',
      source: 'journal_entries',
      actor: { type: 'user', user_id: 'user-1' },
    })
    expect(ev.details).toEqual([
      'Datum: 2026-03-09',
      'Text: Hyra mars',
      'Källa: Manuell verifikation',
      'Bokföringssätt: Godkänd av användare',
    ])
  })

  it('skips drafts and cancelled entries', () => {
    expect(commitEventFromEntry({ ...baseEntry, status: 'draft', committed_at: null })).toBeNull()
    expect(commitEventFromEntry({ ...baseEntry, status: 'cancelled' })).toBeNull()
  })

  it('carries the machine actor from committed_actor_type / label', () => {
    const ev = commitEventFromEntry({
      ...baseEntry,
      committed_actor_type: 'api_key',
      committed_actor_label: 'Zapier',
      commit_method: 'api_key',
    })!
    expect(ev.actor).toEqual({ type: 'api_key', user_id: 'user-1', actor_label: 'Zapier' })
  })

  it('names an SIE-imported verifikat and who submitted the import', () => {
    const ev = commitEventFromEntry({
      ...baseEntry,
      source_type: 'import',
      commit_method: 'migration',
      committed_actor_type: 'mcp_oauth',
      committed_actor_label: 'SIE import: Claude (Anthropic)',
    })!
    expect(ev.details).toContain('Bokföringssätt: Importerad (SIE)')
    expect(ev.actor).toEqual({ type: 'mcp_oauth', user_id: 'user-1', actor_label: 'SIE import: Claude (Anthropic)' })
  })

  it('names the storno of an SIE undo apart from an import, and who asked for the undo (20261016005200)', () => {
    const ev = commitEventFromEntry({
      ...baseEntry,
      source_type: 'storno',
      reverses_id: 'imported-1',
      commit_method: 'migration',
      committed_actor_type: 'api_key',
      committed_actor_label: 'SIE undo: Byrånyckel',
    })!
    expect(ev.details).toContain('Bokföringssätt: Makulering av importerad verifikation (SIE)')
    expect(ev.details).not.toContain('Bokföringssätt: Importerad (SIE)')
    expect(ev.details).toContain('Vändningsverifikation (storno)')
    expect(ev.actor).toEqual({ type: 'api_key', user_id: 'user-1', actor_label: 'SIE undo: Byrånyckel' })
  })

  it('carries the principal the database verified next to the asserted actor (20261016110000)', () => {
    const ev = commitEventFromEntry({
      ...baseEntry,
      committed_actor_type: 'cron',
      committed_actor_label: 'bank-sync',
      committed_auth_role: 'service_role',
      committed_auth_uid: null,
    })!
    expect(ev.actor).toEqual({ type: 'cron', user_id: 'user-1', actor_label: 'bank-sync' })
    expect(ev.verified).toEqual({ role: 'service_role', user_id: null })

    const byUser = commitEventFromEntry({ ...baseEntry, committed_auth_role: 'authenticated', committed_auth_uid: 'user-2' })!
    expect(byUser.verified).toEqual({ role: 'authenticated', user_id: 'user-2' })
  })

  it('leaves a verifikat posted before the stamp exactly as it was: no verified key at all', () => {
    expect(commitEventFromEntry(baseEntry)).not.toHaveProperty('verified')
    expect(commitEventFromEntry({ ...baseEntry, committed_auth_role: null, committed_auth_uid: null })).not.toHaveProperty('verified')
  })

  it('marks storno and rättelse vouchers', () => {
    const storno = commitEventFromEntry({ ...baseEntry, reverses_id: 'x', source_type: 'storno' })!
    expect(storno.details).toContain('Vändningsverifikation (storno)')
    const corr = commitEventFromEntry({ ...baseEntry, correction_of_id: 'x', source_type: 'correction' })!
    expect(corr.details).toContain('Rättelseverifikation')
  })

  // Iterates the runtime allowlist that the DB CHECK is pinned to
  // (source-type-constraint.pg.test.ts), so a new source type without a
  // Swedish label fails here instead of printing its raw code in the PDF.
  it.each(JournalEntrySourceTypeSchema.options)('labels source_type %s in Swedish, never the raw code', (sourceType) => {
    const label = SOURCE_TYPE_LABELS_SV[sourceType]
    expect(label).toBeTruthy()
    expect(label).not.toBe(sourceType)
    const ev = commitEventFromEntry({ ...baseEntry, source_type: sourceType })!
    expect(ev.details).toContain(`Källa: ${label}`)
  })
})

// ============================================================
// auditRowToEvent
// ============================================================

describe('auditRowToEvent: journal_entries', () => {
  it('renders the exact voucher identities and hash of a compact SIE receipt', () => {
    const event = auditRowToEvent(auditRow({ table_name: 'sie_import_chunks', action: 'COMMIT', new_state: {
      import_id: 'batch-1', phase: 'vouchers', chunk_no: 2, payload_hash: 'hash-1',
      entries: [{ id: 'entry-7', series: 'A', voucherNumber: 7 }],
    } }))!
    expect(event.code).toBe('sie_import.chunk_committed')
    expect(event.object).toBe('batch-1')
    expect(event.details.join(' ')).toContain('entry-7')
    expect(event.details.join(' ')).toContain('hash-1')
  })
  it('ignores COMMIT rows (the bokföringspost comes from journal_entries)', () => {
    expect(auditRowToEvent(auditRow({ action: 'COMMIT', new_state: { status: 'posted' } }))).toBeNull()
  })

  it('emits REVERSE as makulerad with the voucher label', () => {
    const ev = auditRowToEvent(
      auditRow({ action: 'REVERSE', old_state: { voucher_series: 'A', voucher_number: 5, status: 'posted' }, new_state: { voucher_series: 'A', voucher_number: 5, status: 'reversed' } }),
    )!
    expect(ev).toMatchObject({ code: 'journal_entry.reversed', object: 'A5', category: 'verifikation' })
  })

  it('names who reversed from the storno, not the booker the REVERSE row carries', () => {
    // The trigger row: the original's user_id and, over PostgREST, actor 'user'.
    const reverse = auditRow({
      action: 'REVERSE',
      record_id: 'entry-1',
      user_id: 'booker',
      actor_id: 'booker',
      old_state: { voucher_series: 'A', voucher_number: 5, status: 'posted' },
      new_state: { voucher_series: 'A', voucher_number: 5, status: 'reversed', reversed_by_id: 'storno-1' },
    })
    type EntryRow = Parameters<typeof commitEventFromEntry>[0]
    const storno: EntryRow = { ...baseEntry, id: 'storno-1', source_type: 'storno', reverses_id: 'entry-1', user_id: 'reverser' }
    const ctx = (entry: EntryRow) => ({ rattelseMetadataAt: new Map<string, number[]>(), entryById: new Map([[entry.id, entry]]) })

    // The storno records the credential (commit_journal_entry): it wins.
    const byKey = auditRowToEvent(reverse, ctx({ ...storno, committed_actor_type: 'api_key', committed_actor_label: 'Bokföringsagent' }))!
    expect(byKey.actor).toEqual({ type: 'api_key', user_id: 'reverser', actor_label: 'Bokföringsagent' })

    // An older storno without the stamp: still the reverser, never the booker.
    const byPerson = auditRowToEvent(reverse, ctx(storno))!
    expect(byPerson.actor).toEqual({ type: 'user', user_id: 'reverser', actor_label: null })

    // An actor on the row itself (an SIE undo) wins over an unstamped storno.
    const byUndo = auditRowToEvent({ ...reverse, actor_type: 'cron', actor_label: 'cron.x' }, ctx(storno))!
    expect(byUndo.actor).toEqual({ type: 'cron', user_id: 'booker', actor_label: 'cron.x' })

    // No storno in the report: the row speaks for itself, as before.
    const alone = auditRowToEvent(reverse)!
    expect(alone.actor).toEqual({ type: 'user', user_id: 'booker', actor_label: null })
  })

  it('emits DELETE only for booked entries', () => {
    expect(auditRowToEvent(auditRow({ action: 'DELETE', old_state: { status: 'draft', voucher_series: 'A', voucher_number: null } }))).toBeNull()
    const ev = auditRowToEvent(
      auditRow({ action: 'DELETE', old_state: { status: 'posted', voucher_series: 'A', voucher_number: 7, entry_date: '2026-01-02', description: 'Fel' } }),
    )!
    expect(ev).toMatchObject({ code: 'journal_entry.deleted', object: 'A7' })
    expect(ev.details).toEqual(['Datum: 2026-01-02', 'Text: Fel'])
  })

  it('emits UPDATE diffs on booked entries and skips draft edits / no-op updates', () => {
    const draft = auditRow({ action: 'UPDATE', old_state: { status: 'draft', description: 'a' }, new_state: { status: 'draft', description: 'b' } })
    expect(auditRowToEvent(draft)).toBeNull()

    const noop = auditRow({ action: 'UPDATE', old_state: { status: 'posted', updated_at: '1' }, new_state: { status: 'posted', updated_at: '2' } })
    expect(auditRowToEvent(noop)).toBeNull()

    const ev = auditRowToEvent(
      auditRow({
        action: 'UPDATE',
        old_state: { status: 'posted', voucher_series: 'A', voucher_number: 3, notes: null },
        new_state: { status: 'posted', voucher_series: 'A', voucher_number: 3, notes: 'Kvitto saknas' },
      }),
    )!
    expect(ev).toMatchObject({ code: 'journal_entry.updated', object: 'A3' })
    expect(ev.details).toEqual(['Notering: (tomt) → Kvitto saknas'])
  })

  it('suppresses the trigger UPDATE row that duplicates a metadata rättelse', () => {
    const row = auditRow({
      action: 'UPDATE',
      record_id: 'entry-9',
      created_at: '2026-03-10T10:00:05.000Z',
      old_state: { status: 'posted', description: 'a', voucher_series: 'A', voucher_number: 9 },
      new_state: { status: 'posted', description: 'b', voucher_series: 'A', voucher_number: 9 },
    })
    const ctx = {
      rattelseMetadataAt: new Map([['entry-9', [Date.parse('2026-03-10T10:00:00.000Z')]]]),
      entryById: new Map(),
    }
    expect(auditRowToEvent(row, ctx)).toBeNull()
    // A different entry, or a change that is not just description/date, is kept.
    expect(auditRowToEvent({ ...row, record_id: 'entry-8' }, ctx)).not.toBeNull()
  })

  it('emits COMMITTED_AT_OVERRIDE with preset vs wall clock', () => {
    const ev = auditRowToEvent(
      auditRow({
        action: 'COMMITTED_AT_OVERRIDE',
        actor_type: 'system',
        new_state: { preset_committed_at: '2025-01-01T00:00:00Z', wall_clock: '2026-08-17T10:00:00Z', jwt_role: 'service_role' },
      }),
    )!
    expect(ev.code).toBe('journal_entry.committed_at_override')
    expect(ev.actor.type).toBe('system')
    expect(ev.details[0]).toContain('2025-01-01')
  })
})

describe('auditRowToEvent: bypassed guards (issue #2366)', () => {
  const bypassRow = (state: Record<string, unknown>) =>
    auditRow({
      action: 'GUARD_BYPASSED',
      table_name: 'supplier_invoices',
      record_id: 'si-1',
      description: 'Duplicate-payment guard bypassed with force on supplier invoice LF-7',
      new_state: {
        guard: 'supplier_invoice_duplicate_payment',
        reason: 'force',
        supplier_invoice_id: 'si-1',
        supplier_invoice_number: 'LF-7',
        payment_amount: 1000,
        payment_currency: 'SEK',
        payment_date: '2026-05-12',
        payment_account: '1930',
        journal_entry_id: 'entry-1',
        detector_failed: false,
        candidate_count: 0,
        candidates: [],
        ...state,
      },
    })

  const ctxWithEntries = (entries: Array<Record<string, unknown>>) => ({
    rattelseMetadataAt: new Map<string, number[]>(),
    entryById: new Map(entries.map((e) => [e.id as string, { ...baseEntry, ...e }])),
  })

  it('labels the override in Swedish and hangs it on the payment voucher', () => {
    const ev = auditRowToEvent(
      bypassRow({}),
      ctxWithEntries([{ id: 'entry-1', voucher_series: 'B', voucher_number: 4 }]),
    )!
    expect(ev).toMatchObject({
      category: 'verifikation',
      code: 'supplier_invoice.duplicate_payment_guard_bypassed',
      event: 'Dubbelbetalningskontroll förbikopplad',
      object: 'B4',
    })
    expect(ev.details).toEqual([
      'Kontroll: möjlig dubbelbetalning av leverantörsfaktura LF-7',
      'Orsak: användaren valde att bokföra ändå (force)',
      'Betalning: 1\u00a0000,00 SEK, 2026-05-12, konto 1930',
      'Kontrollen hittade inga möjliga dubbletter vid bokföringstillfället.',
    ])
  })

  it('labels a customer invoice the same way: every door records one row', () => {
    const ev = auditRowToEvent(
      bypassRow({
        guard: 'invoice_duplicate_payment',
        supplier_invoice_number: undefined,
        invoice_number: 'F-7',
        journal_entry_id: null,
      }),
      ctxWithEntries([]),
    )!
    expect(ev).toMatchObject({
      code: 'invoice.duplicate_payment_guard_bypassed',
      event: 'Dubbelbetalningskontroll förbikopplad',
      object: 'Kundfaktura F-7',
    })
    expect(ev.details[0]).toBe('Kontroll: möjlig dubbelbetalning av kundfaktura F-7')
  })

  it('names each flagged bank row, and the verifikat an already-booked row carries', () => {
    const ev = auditRowToEvent(
      bypassRow({
        candidate_count: 2,
        candidates: [
          {
            transaction_id: 'tx-1',
            date: '2026-05-11',
            amount: -1000,
            match_reason: 'already_booked',
            match_confidence: 0.85,
            journal_entry_id: 'entry-2',
          },
          {
            transaction_id: 'tx-2',
            date: '2026-05-10',
            amount: -1000,
            match_reason: 'name_amount_fuzzy',
            match_confidence: 0.7,
            journal_entry_id: null,
          },
        ],
      }),
      ctxWithEntries([
        { id: 'entry-1', voucher_series: 'B', voucher_number: 4 },
        { id: 'entry-2', voucher_series: 'A', voucher_number: 9 },
      ]),
    )!
    expect(ev.details[3]).toBe(
      'Möjliga dubbletter vid bokföringstillfället (2): ' +
        '2026-05-11 1\u00a0000,00 (redan bokförd som egen verifikation, verifikation A9); ' +
        '2026-05-10 1\u00a0000,00 (motpart och belopp stämmer)',
    )
  })

  it('says so when the guard could not be re-run, rather than reading as "no duplicates"', () => {
    const ev = auditRowToEvent(bypassRow({ detector_failed: true }), ctxWithEntries([]))!
    expect(ev.object).toBe('Leverantörsfaktura LF-7')
    expect(ev.details[3]).toBe('Kontrollen kunde inte köras om vid bokföringstillfället.')
  })

  it('renders an accounting method corrected mid-year with its reason (PH 187)', () => {
    const ev = auditRowToEvent(
      auditRow({
        action: 'GUARD_BYPASSED',
        table_name: 'company_settings',
        record_id: 'settings-1',
        old_state: { accounting_method: 'accrual' },
        new_state: {
          guard: 'accounting_method_mid_year',
          from: 'accrual',
          to: 'cash',
          reason: 'Fel metod valdes vid inflyttningen',
          fiscal_period_id: 'fp-2026',
          fiscal_year: 'Räkenskapsår 2026',
          posted_entries: 112,
          method_timed_entries: 1,
        },
      }),
      ctxWithEntries([]),
    )!
    expect(ev).toMatchObject({
      category: 'installningar',
      code: 'settings.accounting_method_corrected',
      event: 'Redovisningsmetod rättad under räkenskapsåret',
      object: 'Räkenskapsår 2026',
    })
    expect(ev.details).toEqual([
      'Redovisningsmetod: Faktureringsmetoden → Kontantmetoden',
      'Skäl: Fel metod valdes vid inflyttningen',
      'Bokförda verifikationer i räkenskapsåret vid rättelsen: 112',
      'Varav bokförda av fakturaflödet enligt tidigare metod: 1 (oförändrade)',
    ])
  })

  it('drops a row whose guard is unknown to this version rather than half-labelling it', () => {
    expect(auditRowToEvent(bypassRow({ guard: 'some_future_guard' }), ctxWithEntries([]))).toBeNull()
  })
})

describe('auditRowToEvent: system changes', () => {
  it('kontoplan: INSERT / UPDATE diff / DELETE, and no-op UPDATE is dropped', () => {
    const ins = auditRowToEvent(
      auditRow({ table_name: 'chart_of_accounts', action: 'INSERT', new_state: { account_number: '6540', account_name: 'IT-tjänster', account_type: 'expense', default_vat_code: '25' } }),
    )!
    expect(ins).toMatchObject({ category: 'kontoplan', code: 'account.created', object: '6540 IT-tjänster' })
    expect(ins.details).toEqual(['Typ: expense', 'Momskod: 25'])

    const upd = auditRowToEvent(
      auditRow({
        table_name: 'chart_of_accounts',
        action: 'UPDATE',
        old_state: { account_number: '6540', account_name: 'IT-tjänster', default_vat_code: '25', updated_at: 'x' },
        new_state: { account_number: '6540', account_name: 'Programvaror', default_vat_code: '25', updated_at: 'y' },
      }),
    )!
    expect(upd.details).toEqual(['Namn: IT-tjänster → Programvaror'])

    const noop = auditRowToEvent(
      auditRow({ table_name: 'chart_of_accounts', action: 'UPDATE', old_state: { account_number: '6540', sort_order: 1 }, new_state: { account_number: '6540', sort_order: 2 } }),
    )
    expect(noop).toBeNull()

    const del = auditRowToEvent(auditRow({ table_name: 'chart_of_accounts', action: 'DELETE', old_state: { account_number: '6540', account_name: 'X' } }))!
    expect(del.code).toBe('account.deleted')
  })

  it('company_settings: only processing-relevant keys produce an event', () => {
    const counter = auditRowToEvent(
      auditRow({ table_name: 'company_settings', action: 'UPDATE', old_state: { next_invoice_number: 10 }, new_state: { next_invoice_number: 11 } }),
    )
    expect(counter).toBeNull()

    const ev = auditRowToEvent(
      auditRow({
        table_name: 'company_settings',
        action: 'UPDATE',
        old_state: { moms_period: 'quarterly', accounting_method: 'invoice', invoice_footer_text: 'a' },
        new_state: { moms_period: 'yearly', accounting_method: 'invoice', invoice_footer_text: 'b' },
      }),
    )!
    expect(ev).toMatchObject({ category: 'installningar', code: 'settings.updated' })
    expect(ev.details).toEqual(['Momsperiod: Kvartal → Helår'])
  })

  it('company_settings: a lock date the automatic lock moved names the nightly job, not a person', () => {
    // The row write_audit_log writes for the job's UPDATE: the cron actor, and
    // in user_id the settings row's own user, who did nothing here.
    const ev = auditRowToEvent(
      auditRow({
        table_name: 'company_settings',
        action: 'UPDATE',
        user_id: 'user-1',
        actor_id: 'user-1',
        actor_type: 'cron',
        actor_label: 'cron.bookkeeping_auto_lock',
        old_state: { bookkeeping_locked_through: '2025-12-31', auto_lock_period_days: 30 },
        new_state: { bookkeeping_locked_through: '2026-09-30', auto_lock_period_days: 30 },
      }),
    )!
    expect(ev.details).toEqual(['Bokföringen låst till och med: 2025-12-31 → 2026-09-30'])
    expect(formatActorLabel(ev.actor, new Map([['user-1', 'anna@example.se']]))).toBe(
      'Schemalagd körning: cron.bookkeeping_auto_lock',
    )
  })

  it('fiscal_periods: lock, close, app-written unlock, closed externally', () => {
    const lock = auditRowToEvent(auditRow({ table_name: 'fiscal_periods', action: 'LOCK_PERIOD', new_state: { name: 'RÅ 2025' } }))!
    expect(lock).toMatchObject({ category: 'period', code: 'period.locked', object: 'RÅ 2025' })

    const close = auditRowToEvent(auditRow({ table_name: 'fiscal_periods', action: 'CLOSE_PERIOD', new_state: { name: 'RÅ 2025' } }))!
    expect(close.code).toBe('period.closed')

    const unlock = auditRowToEvent(
      auditRow({
        table_name: 'fiscal_periods',
        action: 'UPDATE',
        old_state: { locked_at: '2026-01-01T00:00:00Z' },
        new_state: { locked_at: null },
        description: 'Period unlocked: RÅ 2025 (2025-01-01 to 2025-12-31)',
      }),
    )!
    expect(unlock).toMatchObject({ code: 'period.unlocked', object: 'RÅ 2025 (2025-01-01 to 2025-12-31)' })

    const ext = auditRowToEvent(
      auditRow({
        table_name: 'fiscal_periods',
        action: 'UPDATE',
        old_state: { is_closed: false, closed_at: null, locked_at: null },
        new_state: { is_closed: true, closed_at: 'x', closed_externally: true, locked_at: 'y' },
      }),
    )!
    expect(ext.code).toBe('period.closed_externally')
  })

  it('api_keys: created with scopes, revoked, and usage-only updates dropped', () => {
    const created = auditRowToEvent(
      auditRow({ table_name: 'api_keys', action: 'INSERT', new_state: { name: 'Zapier', scopes: ['read', 'write'] } }),
    )!
    expect(created).toMatchObject({ category: 'atkomst', code: 'api_key.created', object: 'Zapier' })
    expect(created.details).toEqual(['Behörigheter: read, write'])

    const revoked = auditRowToEvent(
      auditRow({ table_name: 'api_keys', action: 'UPDATE', old_state: { name: 'Zapier', revoked_at: null }, new_state: { name: 'Zapier', revoked_at: 'now' } }),
    )!
    expect(revoked.code).toBe('api_key.revoked')

    const usage = auditRowToEvent(
      auditRow({ table_name: 'api_keys', action: 'UPDATE', old_state: { name: 'Zapier', request_count: 1 }, new_state: { name: 'Zapier', request_count: 2 } }),
    )
    expect(usage).toBeNull()
  })

  it('service_accounts: created and revoked, as the credential that acted', () => {
    const created = auditRowToEvent(
      auditRow({
        table_name: 'service_accounts',
        action: 'INSERT',
        actor_type: 'api_key',
        actor_label: 'Ägarens nyckel',
        new_state: { name: 'Nattlig synk', revoked_at: null },
      }),
    )!
    expect(created).toMatchObject({
      category: 'atkomst',
      code: 'service_account.created',
      event: 'Tjänstekonto skapat',
      object: 'Nattlig synk',
      actor: { type: 'api_key', actor_label: 'Ägarens nyckel' },
    })

    const revoked = auditRowToEvent(
      auditRow({
        table_name: 'service_accounts',
        action: 'UPDATE',
        old_state: { name: 'Nattlig synk', revoked_at: null },
        new_state: { name: 'Nattlig synk', revoked_at: '2026-10-16T10:00:00Z' },
      }),
    )!
    expect(revoked).toMatchObject({ code: 'service_account.revoked', event: 'Tjänstekonto återkallat' })
  })

  it('company_capability_config: a package switched on or off is a dated settings line, capability keys are not', () => {
    const on = auditRowToEvent(
      auditRow({
        table_name: 'company_capability_config',
        action: 'INSERT',
        actor_type: 'api_key',
        actor_label: 'Claude',
        new_state: { capability_key: 'package:payroll', enabled: true, source: 'suggestion' },
      }),
    )!
    expect(on).toMatchObject({
      category: 'installningar',
      code: 'package.switched_on',
      event: 'Paket påslaget',
      object: 'Lön',
      details: ['Källa: godkänt förslag'],
      actor: { type: 'api_key', actor_label: 'Claude' },
    })

    const off = auditRowToEvent(
      auditRow({
        table_name: 'company_capability_config',
        action: 'UPDATE',
        old_state: { capability_key: 'package:assets', enabled: true, source: 'suggestion' },
        new_state: { capability_key: 'package:assets', enabled: false, source: 'company' },
      }),
    )!
    expect(off).toMatchObject({ code: 'package.switched_off', event: 'Paket avstängt', object: 'Inventarier', details: ['Källa: företagets eget val'] })

    expect(
      auditRowToEvent(auditRow({ table_name: 'company_capability_config', action: 'UPDATE', new_state: { capability_key: 'ai', enabled: false } })),
    ).toBeNull()
  })

  it('company_capability_config: the company\'s own data choices are dated settings lines too', () => {
    const aiOff = auditRowToEvent(
      auditRow({
        table_name: 'company_capability_config',
        action: 'INSERT',
        new_state: { capability_key: 'ai', enabled: false, source: 'company' },
      }),
    )!
    expect(aiOff).toMatchObject({
      category: 'installningar',
      code: 'data_choice.switched_off',
      event: 'Inställning avstängd',
      object: 'AI-bearbetning',
      details: ['Källa: företagets eget val'],
    })

    const contributionOn = auditRowToEvent(
      auditRow({
        table_name: 'company_capability_config',
        action: 'INSERT',
        new_state: { capability_key: 'data:contribution', enabled: true, source: 'company' },
      }),
    )!
    expect(contributionOn).toMatchObject({ code: 'data_choice.switched_on', object: 'Innehåll till utvärdering och förbättring' })

    expect(
      auditRowToEvent(auditRow({ table_name: 'company_capability_config', action: 'UPDATE', new_state: { capability_key: 'data:pooling', enabled: false, source: 'company' } })),
    ).toMatchObject({ object: 'Anonyma mönster delas', event: 'Inställning avstängd' })
  })

  it('a commit by a service account names the account and its sponsor', () => {
    const event = commitEventFromEntry({
      ...baseEntry,
      id: 'e-sa',
      user_id: 'user-1',
      committed_actor_type: 'service_account',
      committed_actor_label: 'Nattlig synk',
    })!
    expect(event.actor).toEqual({ type: 'service_account', user_id: 'user-1', actor_label: 'Nattlig synk' })
  })

  it('global actions land in ovrigt regardless of table; registers are ignored', () => {
    const sec = auditRowToEvent(
      auditRow({ table_name: 'webhooks', action: 'SECURITY_EVENT', actor_type: 'system', description: 'Signature mismatch' }),
    )!
    expect(sec).toMatchObject({ category: 'ovrigt', code: 'security.event', details: ['Signature mismatch'] })

    expect(auditRowToEvent(auditRow({ table_name: 'supplier_invoices', action: 'INSERT', new_state: { id: 'x' } }))).toBeNull()
    expect(auditRowToEvent(auditRow({ table_name: 'document_attachments', action: 'INSERT', new_state: { file_name: 'a.pdf' } }))).toBeNull()
    expect(auditRowToEvent(auditRow({ table_name: 'document_attachments', action: 'DELETE', old_state: { file_name: 'a.pdf' } }))!.code).toBe('document.deleted')
  })
})

// ============================================================
// rattelseEvent
// ============================================================

describe('rattelseEvent', () => {
  it('describes struck and added lines with account and amount', () => {
    const ev = rattelseEvent(
      {
        id: 'r1',
        journal_entry_id: 'entry-1',
        rattelse_type: 'lines',
        old_description: null,
        new_description: null,
        old_entry_date: null,
        new_entry_date: null,
        struck_lines: [{ account_number: '6540', debit_amount: 1200, credit_amount: 0 }],
        added_lines: [{ account_number: '6550', debit_amount: 1200, credit_amount: 0 }],
        actor: 'user-2',
        created_at: '2026-03-11T08:00:00Z',
      },
      new Map([['entry-1', baseEntry]]),
    )
    expect(ev).toMatchObject({ code: 'journal_entry.corrected_lines', object: 'A12', actor: { user_id: 'user-2' } })
    expect(ev.details[0]).toContain('6540 D 1')
    expect(ev.details[1]).toContain('6550 D 1')
  })

  it('labels imported SIE correction history apart from a rättelse made here (#2427)', () => {
    const ev = rattelseEvent(
      {
        id: 'r3',
        journal_entry_id: 'entry-1',
        rattelse_type: 'lines',
        old_description: null,
        new_description: null,
        old_entry_date: null,
        new_entry_date: null,
        struck_lines: [{ account_number: '5010', debit_amount: 1200, credit_amount: 0 }],
        added_lines: [{ account_number: '6540', debit_amount: 1200, credit_amount: 0 }],
        actor: null,
        created_at: '2026-03-11T08:00:00Z',
        source: 'sie_import',
        sie_import_id: 'import-1',
        external_signature: 'EL',
      },
      new Map([['entry-1', baseEntry]]),
    )
    expect(ev).toMatchObject({
      code: 'journal_entry.imported_correction_history',
      event: 'Rättelsehistorik från källsystemet (SIE-import)',
      object: 'A12',
      actor: { type: 'system', user_id: null, actor_label: 'SIE-import' },
      source: 'rattelse_log',
    })
    expect(ev.details[0]).toContain('Strukna rader i källsystemet (1): 5010 D 1')
    expect(ev.details[1]).toContain('Tillagda rader i källsystemet (1): 6540 D 1')
    expect(ev.details[2]).toBe('Signatur i källsystemet: EL')
    expect(ev.details[3]).toContain('registrering vid SIE-import')
  })

  it('describes metadata changes', () => {
    const ev = rattelseEvent(
      {
        id: 'r2',
        journal_entry_id: 'missing',
        rattelse_type: 'metadata',
        old_description: 'Hyra',
        new_description: 'Hyra mars',
        old_entry_date: '2026-03-01',
        new_entry_date: '2026-03-01',
        struck_lines: null,
        added_lines: null,
        actor: 'user-2',
        created_at: '2026-03-11T08:00:00Z',
      },
      new Map(),
    )
    expect(ev.object).toBeNull()
    expect(ev.details).toEqual(['Beskrivning: Hyra → Hyra mars'])
    // A row from before 20261016005000 records no actor type: the user, as before.
    expect(ev.actor).toEqual({ type: 'user', user_id: 'user-2', actor_label: null })
  })

  it('names the API key, OAuth client or cron job that relayed the rättelse (20261016005000)', () => {
    const row = {
      id: 'r4',
      journal_entry_id: 'entry-1',
      rattelse_type: 'lines' as const,
      old_description: null,
      new_description: null,
      old_entry_date: null,
      new_entry_date: null,
      struck_lines: [{ account_number: '6540', debit_amount: 1200, credit_amount: 0 }],
      added_lines: [{ account_number: '6550', debit_amount: 1200, credit_amount: 0 }],
      actor: 'user-2',
      created_at: '2026-03-11T08:00:00Z',
    }
    const labels = new Map([['user-2', 'anna@example.se']])

    const byKey = rattelseEvent({ ...row, actor_type: 'api_key', actor_label: 'Bokföringsagent' }, new Map([['entry-1', baseEntry]]))
    expect(byKey.actor).toEqual({ type: 'api_key', user_id: 'user-2', actor_label: 'Bokföringsagent' })
    expect(formatActorLabel(byKey.actor, labels)).toBe('Bokföringsagent åt anna@example.se')

    const byConnector = rattelseEvent({ ...row, actor_type: 'mcp_oauth', actor_label: 'Claude (Anthropic)' }, new Map())
    expect(formatActorLabel(byConnector.actor, labels)).toBe('Claude åt anna@example.se')

    const byPerson = rattelseEvent({ ...row, actor_type: 'user', actor_label: null }, new Map())
    expect(formatActorLabel(byPerson.actor, labels)).toBe('anna@example.se')
  })
})

// ============================================================
// collapse + sort + labels
// ============================================================

describe('collapseBursts', () => {
  it('collapses a run of same-actor account inserts into one event and keeps short runs', () => {
    const t0 = Date.parse('2026-03-10T10:00:00.000Z')
    const burst = Array.from({ length: 12 }, (_, i) =>
      rawEvent({ occurred_at: new Date(t0 + i * 1000).toISOString(), object: `${1000 + i} Konto ${i}` }),
    )
    const other = rawEvent({
      code: 'settings.updated',
      category: 'installningar',
      event: 'Företagsinställningar ändrade',
      occurred_at: new Date(t0 + 20_000).toISOString(),
      object: null,
    })
    const small = Array.from({ length: 3 }, (_, i) =>
      rawEvent({ occurred_at: new Date(t0 + 30_000 + i * 1000).toISOString(), object: `20${i}0 Konto` }),
    )
    const out = collapseBursts(sortEvents([...burst, other, ...small]))
    expect(out).toHaveLength(1 + 1 + 3)
    expect(out[0]).toMatchObject({ code: 'account.created.bulk', event: 'Kontoplan upplagd', object: '12 konton', count: 12 })
    expect(out[0].details).toEqual(['Konton 1000 till 1011'])
    expect(out[1].code).toBe('settings.updated')
  })

  it('splits runs on actor change and on a gap', () => {
    const t0 = Date.parse('2026-03-10T10:00:00.000Z')
    const a = Array.from({ length: 10 }, (_, i) => rawEvent({ occurred_at: new Date(t0 + i * 1000).toISOString() }))
    const b = Array.from({ length: 10 }, (_, i) =>
      rawEvent({ occurred_at: new Date(t0 + 10_000 + i * 1000).toISOString(), actor: { type: 'api_key', user_id: null, actor_label: 'Sync' } }),
    )
    const c = Array.from({ length: 10 }, (_, i) => rawEvent({ occurred_at: new Date(t0 + 600_000 + i * 1000).toISOString() }))
    const out = collapseBursts(sortEvents([...a, ...b, ...c]))
    expect(out.map((e) => e.count)).toEqual([10, 10, 10])
  })

  it('collapses bulk underlag deletions and lists the first file names', () => {
    const t0 = Date.parse('2026-08-10T12:40:45.000Z')
    const run = Array.from({ length: 7 }, (_, i) =>
      rawEvent({
        code: 'document.deleted',
        category: 'ovrigt',
        event: 'Underlag borttaget',
        occurred_at: new Date(t0 + i * 100).toISOString(),
        object: `Receipt-${Math.floor(i / 2)}.pdf`,
      }),
    )
    const two = run.slice(0, 2)
    expect(collapseBursts(two)).toHaveLength(2)
    const out = collapseBursts(run)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ code: 'document.deleted.bulk', event: 'Underlag borttagna', object: '7 underlag', category: 'ovrigt', count: 7 })
    expect(out[0].details).toEqual(['Receipt-0.pdf, Receipt-1.pdf, Receipt-2.pdf, Receipt-3.pdf'])
  })

  it('summarises which fields a bulk update touched', () => {
    const t0 = Date.parse('2026-03-10T10:00:00.000Z')
    const run = Array.from({ length: 10 }, (_, i) =>
      rawEvent({
        code: 'account.updated',
        event: 'Konto ändrat',
        occurred_at: new Date(t0 + i).toISOString(),
        details: [i % 2 ? 'Momskod: 25 → 12' : 'Namn: a → b'],
      }),
    )
    const out = collapseBursts(run)
    expect(out[0].details).toContain('Ändrade fält: Namn, Momskod')
  })
})

describe('formatActorLabel', () => {
  const labels = new Map([['user-1', 'anna@example.se']])
  it('maps every actor type', () => {
    expect(formatActorLabel({ type: 'user', user_id: 'user-1', actor_label: null }, labels)).toBe('anna@example.se')
    expect(formatActorLabel({ type: 'user', user_id: 'deadbeef-0000', actor_label: null }, labels)).toBe('Användare deadbeef')
    expect(formatActorLabel({ type: 'user', user_id: null, actor_label: null }, labels)).toBe('Okänd användare')
    // An agent is named with the person it acted for, never by its credential.
    expect(formatActorLabel({ type: 'api_key', user_id: 'user-1', actor_label: 'Zapier' }, labels)).toBe('Zapier åt anna@example.se')
    expect(formatActorLabel({ type: 'api_key', user_id: 'user-1', actor_label: 'Claude (Anthropic)' }, labels)).toBe('Claude åt anna@example.se')
    expect(formatActorLabel({ type: 'api_key', user_id: 'user-1', actor_label: 'MCP-klient (OAuth)' }, labels)).toBe('AI-anslutning åt anna@example.se')
    expect(formatActorLabel({ type: 'api_key', user_id: 'deadbeef-0000', actor_label: 'Zapier' }, labels)).toBe('Zapier åt Användare deadbeef')
    expect(formatActorLabel({ type: 'mcp_oauth', user_id: null, actor_label: null }, labels)).toBe('AI-anslutning')
    expect(formatActorLabel({ type: 'agent_chat', user_id: 'user-1', actor_label: null }, labels)).toBe('Assistenten åt anna@example.se')
    expect(formatActorLabel({ type: 'cron', user_id: null, actor_label: null }, labels)).toBe('Schemalagd körning')
    expect(formatActorLabel({ type: 'system', user_id: null, actor_label: 'seed' }, labels)).toBe('Systemet: seed')
    // A service account acts for its sponsor, the user the row carries.
    expect(formatActorLabel({ type: 'service_account', user_id: 'user-1', actor_label: 'Nattlig synk' }, labels)).toBe(
      'Tjänstekontot Nattlig synk åt anna@example.se',
    )
    expect(formatActorLabel({ type: 'service_account', user_id: null, actor_label: null }, labels)).toBe('Ett tjänstekonto')
  })
})

describe('formatVerifiedLabel', () => {
  const labels = new Map([['user-1', 'anna@example.se']])
  it('names the role the request ran as, and the signed-in user', () => {
    expect(formatVerifiedLabel({ role: 'authenticated', user_id: 'user-1' }, labels)).toBe('Inloggad användare: anna@example.se')
    expect(formatVerifiedLabel({ role: 'authenticated', user_id: 'deadbeef-0000' }, labels)).toBe('Inloggad användare: Användare deadbeef')
    expect(formatVerifiedLabel({ role: 'authenticated', user_id: null }, labels)).toBe('Inloggad användare (inget användar-id)')
    expect(formatVerifiedLabel({ role: 'service_role', user_id: null }, labels)).toBe('Applikationsservern (service_role)')
    expect(formatVerifiedLabel({ role: 'anon', user_id: null }, labels)).toBe('Ej inloggad (anon)')
    expect(formatVerifiedLabel({ role: 'postgres', user_id: null }, labels)).toBe('Direkt databasanslutning (postgres)')
  })

  it('puts the verified principal beside the actor in the export cell, and leaves the actor alone without one', () => {
    const actor = { type: 'cron' as const, user_id: null, label: 'Schemalagd körning: bank-sync' }
    expect(actorWithVerified({ actor })).toBe('Schemalagd körning: bank-sync')
    expect(
      actorWithVerified({ actor, verified: { role: 'service_role', user_id: null, label: 'Applikationsservern (service_role)' } }),
    ).toBe('Schemalagd körning: bank-sync (verifierat av databasen: Applikationsservern (service_role))')
  })
})

describe('formatStockholmTimestamp', () => {
  it('renders Swedish local time', () => {
    expect(formatStockholmTimestamp('2026-03-10T10:00:00.000Z')).toBe('2026-03-10 11:00:00')
    expect(formatStockholmTimestamp('2026-07-10T10:00:00.000Z')).toBe('2026-07-10 12:00:00')
    expect(formatStockholmTimestamp('not a date')).toBe('not a date')
  })
})

// ============================================================
// generateBehandlingshistorik (table-keyed mock client)
// ============================================================

type MockResult = { data?: unknown; error?: unknown }
let mockResults: Record<string, MockResult[]>
/** RPC results by function name; an absent one answers one row of empty arrays. */
let rpcResults: Record<string, MockResult>

/** The row behandlingshistorik_sources() returns. */
function ledger(rows: { entries?: unknown[]; audit?: unknown[]; rattelse?: unknown[] }): MockResult {
  return { data: [{ entries: rows.entries ?? [], audit: rows.audit ?? [], rattelse: rows.rattelse ?? [] }], error: null }
}

function makeBuilder(table: string) {
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in', 'gte', 'lte', 'or', 'order', 'range']) {
    b[m] = vi.fn().mockReturnValue(b)
  }
  const consume = (): MockResult => {
    const queue = mockResults[table]
    if (!queue || queue.length === 0) return { data: null, error: null }
    return queue.shift()!
  }
  b.maybeSingle = vi.fn().mockImplementation(async () => consume())
  b.single = vi.fn().mockImplementation(async () => consume())
  b.then = (resolve: (v: unknown) => void) => resolve(consume())
  return b
}

function makeClient() {
  return {
    from: vi.fn().mockImplementation((table: string) => makeBuilder(table)),
    rpc: vi.fn().mockImplementation(async (fn: string) => rpcResults[fn] ?? { data: [{}], error: null }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

const period = { id: 'period-1', name: 'RÅ 2026', period_start: '2026-01-01', period_end: '2026-12-31' }

beforeEach(() => {
  mockResults = {}
  rpcResults = {}
})

describe('generateBehandlingshistorik', () => {
  it('returns null when the period does not belong to the company', async () => {
    mockResults = { fiscal_periods: [{ data: null }] }
    const report = await generateBehandlingshistorik(makeClient(), 'company-1', { periodId: 'nope' })
    expect(report).toBeNull()
  })

  it('assembles, sorts and labels events from every source in fiscal-year mode', async () => {
    const bokslut = { ...baseEntry, id: 'entry-2', voucher_number: 40, entry_date: '2026-12-31', committed_at: '2027-02-15T12:00:00.000Z', source_type: 'year_end', description: 'Bokslut' }
    rpcResults = {
      behandlingshistorik_sources: ledger({
        entries: [baseEntry, bokslut, { ...baseEntry, id: 'draft', status: 'draft', committed_at: null, voucher_number: null }],
        audit: [
          // logged inside the window
          auditRow({ id: 'a1', table_name: 'company_settings', action: 'UPDATE', created_at: '2026-02-01T08:00:00.000Z', old_state: { moms_period: 'quarterly' }, new_state: { moms_period: 'monthly' } }),
          auditRow({ id: 'a2', table_name: 'chart_of_accounts', action: 'INSERT', created_at: '2026-02-02T08:00:00.000Z', new_state: { account_number: '6540', account_name: 'IT' } }),
          // about one of the year's verifikat: the bokslut storno logged after period end
          auditRow({ id: 'a3', record_id: 'entry-2', action: 'REVERSE', created_at: '2027-03-01T09:00:00.000Z', old_state: { voucher_series: 'A', voucher_number: 40, status: 'posted' }, new_state: { voucher_series: 'A', voucher_number: 40, status: 'reversed' }, actor_type: 'api_key', actor_label: 'Revisorn' }),
        ],
      }),
    }
    mockResults = {
      fiscal_periods: [{ data: period }],
      company_settings: [{ data: { company_name: 'Testbolaget AB', org_number: '556000-0001' } }],
      company_migration_resets: [{ data: [] }, { data: [] }],
      app_releases: [{ data: [] }],
      sie_imports: [
        {
          data: [
            { id: 's1', user_id: 'user-3', filename: 'bokio.se', sie_type: 4, fiscal_year_start: '2025-01-01', fiscal_year_end: '2025-12-31', accounts_count: 120, transactions_count: 900, status: 'completed', error_message: null, imported_at: '2026-01-05T10:00:00.000Z', created_at: '2026-01-05T09:55:00.000Z', replaced_at: null },
            { id: 's0', user_id: 'user-3', filename: 'old.se', sie_type: 4, fiscal_year_start: null, fiscal_year_end: null, accounts_count: null, transactions_count: null, status: 'completed', error_message: null, imported_at: '2025-06-01T10:00:00.000Z', created_at: '2025-06-01T10:00:00.000Z', replaced_at: null },
          ],
        },
      ],
      bank_file_imports: [
        { data: [{ id: 'b1', user_id: 'user-1', filename: 'seb.csv', file_format: 'seb', transaction_count: 40, imported_count: 38, duplicate_count: 2, status: 'completed', error_message: null, date_from: '2026-01-01', date_to: '2026-01-31', created_at: '2026-02-03T08:00:00.000Z' }] },
      ],
    }
    const resolve = vi.fn().mockResolvedValue(new Map([['user-1', 'anna@example.se'], ['user-3', 'kim@example.se']]))

    const client = makeClient()
    const report = await generateBehandlingshistorik(client, 'company-1', { periodId: 'period-1' }, {
      resolveUserLabels: resolve,
      appVersion: 'abc1234',
      now: new Date('2026-08-21T12:00:00.000Z'),
    })

    // One round trip each for the ledger history and the decisions, scoped to
    // the company and period, with the record-id unions (fiscal-year mode).
    const window = { p_company_id: 'company-1', p_period_id: 'period-1', p_from: '2026-01-01T00:00:00.000Z', p_to: '2026-12-31T23:59:59.999Z', p_fiscal_year: true }
    expect(client.rpc.mock.calls).toEqual([['behandlingshistorik_sources', window], ['behandlingshistorik_decisions', window]])
    for (const table of ['journal_entries', 'audit_log', 'journal_entry_rattelse_log', 'suggestion_log', 'pending_operations']) {
      expect(client.from).not.toHaveBeenCalledWith(table)
    }
    expect(report).not.toBeNull()
    expect(report!.mode).toBe('fiscal_year')
    expect(report!.company).toEqual({ name: 'Testbolaget AB', org_number: '556000-0001' })
    expect(report!.app_version).toBe('abc1234')
    expect(report!.range).toEqual({ from: '2026-01-01', to: '2026-12-31' })
    // Both booked entries (bokslut entry committed after period end included), no draft.
    const codes = report!.events.map((e) => e.code)
    expect(codes).toEqual([
      'sie_import.completed',
      'settings.updated',
      'account.created',
      'bank_file_import.completed',
      'journal_entry.committed',
      'journal_entry.committed',
      'journal_entry.reversed',
    ])
    expect(report!.total_events).toBe(7)
    expect(report!.by_category).toMatchObject({ verifikation: 3, kontoplan: 1, installningar: 1, import: 2 })
    // Labels resolved through the injected resolver; a key named with the person it acted for.
    expect(resolve).toHaveBeenCalledWith(expect.arrayContaining(['user-1', 'user-3']))
    const byCode = Object.fromEntries(report!.events.map((e) => [e.id, e]))
    expect(byCode['entry:entry-1'].actor.label).toBe('anna@example.se')
    expect(byCode['sie:s1'].actor.label).toBe('kim@example.se')
    expect(byCode['audit:a3'].actor.label).toBe('Revisorn åt anna@example.se')
    // The sie import outside the window is not included.
    expect(byCode['sie:s0']).toBeUndefined()
  })

  it('date-range mode keeps only what was registered inside the window and filters categories', async () => {
    rpcResults = {
      behandlingshistorik_sources: ledger({
        // A verifikat the window's rows look up comes back too; only the one
        // committed inside the window is a bokföringspost of the window.
        entries: [baseEntry, { ...baseEntry, id: 'entry-2', voucher_number: 13, committed_at: '2026-05-02T10:00:00.000Z' }],
        audit: [auditRow({ id: 'a1', table_name: 'chart_of_accounts', action: 'DELETE', created_at: '2026-03-15T08:00:00.000Z', old_state: { account_number: '6540', account_name: 'IT' } })],
      }),
    }
    mockResults = {
      fiscal_periods: [{ data: period }],
      company_settings: [{ data: { company_name: 'T', org_number: null } }],
      company_migration_resets: [{ data: [] }, { data: [] }],
      app_releases: [{ data: [] }],
      sie_imports: [{ data: [] }],
      bank_file_imports: [{ data: [] }],
    }
    const client = makeClient()
    const report = await generateBehandlingshistorik(client, 'company-1', {
      periodId: 'period-1',
      fromDate: '2026-03-01',
      toDate: '2026-03-31',
      categories: ['verifikation'],
    })
    expect(report!.mode).toBe('date_range')
    expect(report!.events.map((e) => e.id)).toEqual(['entry:entry-1'])
    expect(report!.by_category.kontoplan).toBe(0)
    // No record-id union in date-range mode.
    const window = { p_company_id: 'company-1', p_period_id: 'period-1', p_from: '2026-03-01T00:00:00.000Z', p_to: '2026-03-31T23:59:59.999Z', p_fiscal_year: false }
    expect(client.rpc.mock.calls).toEqual([['behandlingshistorik_sources', window], ['behandlingshistorik_decisions', window]])
  })

  it('shows the verified principal beside the asserted actor, resolving its user, and nothing on older verifikat', async () => {
    const verifiedEntry = {
      ...baseEntry,
      id: 'entry-2',
      voucher_number: 13,
      committed_at: '2026-03-11T10:00:00.000Z',
      committed_actor_type: 'user',
      committed_auth_role: 'authenticated',
      committed_auth_uid: 'user-2',
    }
    mockResults = {
      fiscal_periods: [{ data: period }],
      company_settings: [{ data: { company_name: 'T', org_number: null } }],
    }
    rpcResults = { behandlingshistorik_sources: ledger({ entries: [baseEntry, verifiedEntry] }) }
    const resolve = vi.fn().mockResolvedValue(new Map([['user-1', 'anna@example.se'], ['user-2', 'bo@example.se']]))

    const report = await generateBehandlingshistorik(makeClient(), 'company-1', { periodId: 'period-1' }, {
      resolveUserLabels: resolve,
    })

    expect(resolve).toHaveBeenCalledWith(expect.arrayContaining(['user-1', 'user-2']))
    const byId = Object.fromEntries(report!.events.map((e) => [e.id, e]))
    expect(byId['entry:entry-1']).not.toHaveProperty('verified')
    expect(byId['entry:entry-2'].actor.label).toBe('anna@example.se')
    expect(byId['entry:entry-2'].verified).toEqual({
      role: 'authenticated',
      user_id: 'user-2',
      label: 'Inloggad användare: bo@example.se',
    })
  })

  it('fails with the SQLSTATE when a read fails', async () => {
    for (const fn of ['behandlingshistorik_sources', 'behandlingshistorik_decisions']) {
      mockResults = {
        fiscal_periods: [{ data: period }],
        company_settings: [{ data: { company_name: 'T', org_number: null } }],
      }
      rpcResults = { [fn]: { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } } }
      await expect(generateBehandlingshistorik(makeClient(), 'company-1', { periodId: 'period-1' })).rejects.toMatchObject({
        code: '57014',
      })
    }
  })
})

// ============================================================
// SIE imports: the job is the lifecycle (#200)
// ============================================================

type SieRow = Parameters<typeof sieImportEvents>[0]

function sieRow(overrides: Partial<SieRow> = {}): SieRow {
  return {
    id: 's1',
    user_id: 'user-3',
    filename: 'bokio.se',
    sie_type: 4,
    fiscal_year_start: '2025-01-01',
    fiscal_year_end: '2025-12-31',
    accounts_count: 120,
    transactions_count: 900,
    status: 'completed',
    error_message: null,
    imported_at: '2026-01-05T10:00:00.000Z',
    created_at: '2026-01-05T09:55:00.000Z',
    replaced_at: null,
    ...overrides,
  }
}

/** A durable import job as complete_sie_import_job leaves it. */
const completedJob: Partial<SieRow> = { job_state: 'completed', job_kind: 'import', job_phase: 'finalize', undone_at: null }
/** The same job after undo_sie_import_chunk took its last chunk: status 'replaced', replaced_at never set. */
const undoneJob: Partial<SieRow> = {
  job_state: 'undone',
  job_kind: 'import',
  job_phase: 'undo',
  status: 'replaced',
  replaced_at: null,
  undone_at: '2026-02-10T08:30:00.000Z',
  execution_actor_id: 'user-4',
  undo_actor_type: 'api_key',
  undo_actor_label: 'SIE undo: Byrånyckel',
}

const summary = (events: RawBehandlingshistorikEvent[]) =>
  events.map((e) => ({ id: e.id, occurred_at: e.occurred_at, code: e.code, event: e.event }))

/** What support_remove_undone_sie_import leaves on the undone import, as read from job_result (crm#1954). */
function removal(overrides: Partial<NonNullable<SieRow['support_removal']>> = {}): NonNullable<SieRow['support_removal']> {
  return {
    removed_at: '2027-03-02T09:00:00.000Z',
    fiscal_period_id: 'period-1',
    imported_verifikat: 400,
    stornos: 400,
    reason: 'Den första importen var ofullständig.',
    actor_label: 'Support: Anna',
    series: [{
      series: 'A', mode: 'renumber', removed_numbers: [{ from: 1, to: 800 }], renumbered: 558,
      renumbered_from: { from: 801, to: 1358 }, renumbered_to: { from: 1, to: 558 }, gap_explanations: [],
    }],
    ...overrides,
  }
}

/** The same receipt as the migration stores it in job_result.support_removal. */
function storedRemoval(fiscalPeriodId: string) {
  return {
    ok: true, dry_run: false, import_id: 's1', filename: 'bokio.se',
    fiscal_period: { id: fiscalPeriodId, name: 'RÅ 2026', start: '2026-01-01', end: '2026-12-31', locked_at: '2027-01-10T08:00:00+00:00' },
    removed: { imported_verifikat: 400, stornos: 400, verifikat: 800, lines: 1600 },
    series: [{
      series: 'A', mode: 'renumber', not_renumbered_because: null, removed_numbers: [{ from: 1, to: 800 }],
      replacement_import_id: 's2', replacement_filename: 'full.se', renumbered: 558,
      renumbered_from: { from: 801, to: 1358 }, renumbered_to: { from: 1, to: 558 },
      last_number_before: 1358, last_number_after: 558, gap_explanations: [],
    }],
    reason: 'Den första importen var ofullständig.', actor_label: 'Support: Anna',
    removed_at: '2027-03-02T09:00:00.000+00:00',
  }
}

describe('sieImportEvents', () => {
  it('reads a completed durable import as imported, at imported_at', () => {
    const events = sieImportEvents(sieRow(completedJob))
    expect(summary(events)).toEqual([
      { id: 'sie:s1', occurred_at: '2026-01-05T10:00:00.000Z', code: 'sie_import.completed', event: 'SIE-fil importerad' },
    ])
    expect(events[0].details).toEqual(['Filtyp: SIE4', 'Räkenskapsår: 2025-01-01 till 2025-12-31', '120 konton, 900 transaktioner'])
  })

  it('reads an undone durable import as imported, then undone by storno at undone_at, by who asked', () => {
    const events = sieImportEvents(sieRow(undoneJob))
    expect(summary(events)).toEqual([
      { id: 'sie:s1', occurred_at: '2026-01-05T10:00:00.000Z', code: 'sie_import.completed', event: 'SIE-fil importerad' },
      {
        id: 'sie:s1:undone',
        occurred_at: '2026-02-10T08:30:00.000Z',
        code: 'sie_import.undone',
        event: 'SIE-import ångrad (importerade verifikationer makulerade med vändningsverifikationer (storno))',
      },
    ])
    expect(events[1].actor).toEqual({ type: 'api_key', user_id: 'user-4', actor_label: 'SIE undo: Byrånyckel' })
    // The import itself stays the importer's; the undo never says "raderade".
    expect(events[0].actor).toEqual({ type: 'user', user_id: 'user-3', actor_label: null })
    expect(events.map((e) => e.event).join(' ')).not.toContain('raderade')
  })

  it('reads an import support removed from the ledger as imported, undone, then removed, with what was renumbered', () => {
    const events = sieImportEvents(sieRow({ ...undoneJob, support_removal: removal() }))
    expect(events.map((e) => e.code)).toEqual(['sie_import.completed', 'sie_import.undone', 'sie_import.removed'])
    expect(events[2]).toMatchObject({
      id: 'sie:s1:removed',
      occurred_at: '2027-03-02T09:00:00.000Z',
      category: 'import',
      event: 'Ångrad SIE-import borttagen ur bokföringen av support',
      object: 'bokio.se',
      actor: { type: 'system', user_id: null, actor_label: 'Support: Anna' },
    })
    expect(events[2].details).toEqual([
      'Raderade: 400 importerade verifikationer och 400 vändningsverifikationer (A1-A800)',
      'Serie A: A801-A1358 omnumrerade till A1-A558, det tidigare systemets nummer',
      'Skäl: Den första importen var ofullständig.',
    ])
  })

  it('says a removal that renumbered nothing explained the freed numbers as a gap', () => {
    const events = sieImportEvents(sieRow({
      ...undoneJob,
      support_removal: removal({
        series: [{
          series: 'A', mode: 'gap_explanations', removed_numbers: [{ from: 1, to: 800 }], renumbered: 0,
          renumbered_from: null, renumbered_to: null, gap_explanations: [{ gap_start: 1, gap_end: 800 }],
        }],
      }),
    }))
    expect(events[2].details[1]).toBe('Serie A: inte omnumrerad, de borttagna numren är förklarade som lucka (A1-A800)')
  })

  it('names the user when the undo recorded no credential', () => {
    const [, undo] = sieImportEvents(sieRow({ ...undoneJob, undo_actor_type: null, undo_actor_label: null }))
    expect(undo.actor).toEqual({ type: 'user', user_id: 'user-4', actor_label: null })
  })

  it('says an undo before the time was recorded happened, without inventing a time', () => {
    const events = sieImportEvents(sieRow({ ...undoneJob, undone_at: null }))
    expect(summary(events)).toEqual([
      { id: 'sie:s1', occurred_at: '2026-01-05T10:00:00.000Z', code: 'sie_import.completed', event: 'SIE-fil importerad' },
    ])
    expect(events[0].details.at(-1)).toBe(
      'Senare ångrad: importerade verifikationer makulerade med vändningsverifikationer (storno). Tidpunkten för ångringen finns inte registrerad.',
    )
  })

  it('reads an undo in progress as the import with the undo pending, while status still says completed', () => {
    for (const job_state of ['undoing', 'reconciling', 'paused']) {
      const events = sieImportEvents(sieRow({ ...completedJob, job_state, job_phase: 'undo', status: 'completed' }))
      expect(events.map((e) => e.code)).toEqual(['sie_import.completed'])
      expect(events[0].details.at(-1)).toBe('Ångring pågår: importerade verifikationer makuleras med vändningsverifikationer (storno)')
    }
  })

  it('reads an import undone before it completed as started, then undone', () => {
    const events = sieImportEvents(sieRow({ ...undoneJob, imported_at: null }))
    expect(summary(events)).toEqual([
      { id: 'sie:s1', occurred_at: '2026-01-05T09:55:00.000Z', code: 'sie_import.started', event: 'SIE-import påbörjad' },
      expect.objectContaining({ code: 'sie_import.undone', occurred_at: '2026-02-10T08:30:00.000Z' }),
    ])
  })

  it('reads a running import as started and a failed one as failed, with the error', () => {
    expect(summary(sieImportEvents(sieRow({ job_state: 'running', job_kind: 'import', job_phase: 'vouchers', status: 'pending', imported_at: null })))).toEqual([
      { id: 'sie:s1', occurred_at: '2026-01-05T09:55:00.000Z', code: 'sie_import.started', event: 'SIE-import påbörjad' },
    ])
    const [failed] = sieImportEvents(sieRow({ job_state: 'failed', job_kind: 'import', job_phase: 'prepare', status: 'failed', imported_at: null, error_message: 'Obalanserad verifikation' }))
    expect(failed).toMatchObject({ code: 'sie_import.failed', event: 'SIE-import misslyckades', occurred_at: '2026-01-05T09:55:00.000Z' })
    expect(failed.details.at(-1)).toBe('Fel: Obalanserad verifikation')
  })

  it('reads a completed job as completed whatever status a fiscal-year reset wrote', () => {
    const events = sieImportEvents(sieRow({ ...completedJob, status: 'undone', replaced_at: '2026-03-01T12:00:00.000Z' }))
    expect(events.map((e) => e.code)).toEqual(['sie_import.completed'])
  })

  it('keeps a legacy import on status and replaced_at: its undo deleted the verifikationer', () => {
    const events = sieImportEvents(sieRow({ status: 'undone', replaced_at: '2026-03-01T12:00:00.000Z' }))
    expect(summary(events)).toEqual([
      { id: 'sie:s1', occurred_at: '2026-01-05T10:00:00.000Z', code: 'sie_import.completed', event: 'SIE-fil importerad' },
      { id: 'sie:s1:replaced', occurred_at: '2026-03-01T12:00:00.000Z', code: 'sie_import.undone', event: 'SIE-import ångrad (importerade verifikationer raderade)' },
    ])
  })

  describe('a reviewed duplicate repair', () => {
    const repair: Partial<SieRow> = {
      filename: 'Granskad rättelse av dubbla SIE-verifikationer',
      job_kind: 'duplicate_repair',
      job_phase: 'undo',
      accounts_count: 0,
      transactions_count: 3,
      imported_at: null,
    }

    it('reads as a repair, done at undone_at, never as an import', () => {
      const events = sieImportEvents(sieRow({ ...repair, job_state: 'undone', status: 'replaced', undone_at: '2026-02-10T08:30:00.000Z' }))
      expect(summary(events)).toEqual([
        { id: 'sie:s1', occurred_at: '2026-01-05T09:55:00.000Z', code: 'sie_import.repair_started', event: 'Granskad rättelse av dubbla SIE-verifikationer påbörjad' },
        {
          id: 'sie:s1:repaired',
          occurred_at: '2026-02-10T08:30:00.000Z',
          code: 'sie_import.repair_completed',
          event: 'Granskad rättelse av dubbla SIE-verifikationer slutförd (dubbletterna makulerade med vändningsverifikationer)',
        },
      ])
      expect(events[0].details).toEqual(['Räkenskapsår: 2025-01-01 till 2025-12-31', 'Dubbla verifikationer att makulera: 3'])
    })

    it('reads a stopped repair as stopped at its stop time, though its status says completed', () => {
      const events = sieImportEvents(sieRow({
        ...repair, job_state: 'completed', status: 'completed', repair_outcome: 'stopped', repair_stopped_at: '2026-02-09T16:00:00.123456+00:00',
      }))
      expect(summary(events)).toEqual([
        expect.objectContaining({ code: 'sie_import.repair_started' }),
        { id: 'sie:s1:stopped', occurred_at: '2026-02-09T16:00:00.123Z', code: 'sie_import.repair_stopped', event: 'Granskad rättelse av dubbla SIE-verifikationer avbruten' },
      ])
    })

    it('reads a repair in progress as started only', () => {
      expect(sieImportEvents(sieRow({ ...repair, job_state: 'undoing', status: 'pending' })).map((e) => e.code)).toEqual(['sie_import.repair_started'])
    })
  })
})

describe('generateBehandlingshistorik: SIE imports', () => {
  const base = () => ({
    fiscal_periods: [{ data: period }],
    company_settings: [{ data: { company_name: 'T', org_number: null } }],
    company_migration_resets: [{ data: [] }, { data: [] }],
    app_releases: [{ data: [] }],
    bank_file_imports: [{ data: [] }],
  })

  it('shows an undone durable import as undone, at undone_at', async () => {
    mockResults = { ...base(), sie_imports: [{ data: [sieRow({ ...undoneJob, imported_at: '2026-01-05T10:00:00.000Z' })] }] }
    const client = makeClient()
    const report = await generateBehandlingshistorik(client, 'company-1', { periodId: 'period-1' })
    expect(report!.events.filter((e) => e.source === 'sie_import').map((e) => e.code)).toEqual(['sie_import.completed', 'sie_import.undone'])
    const select = client.from.mock.results[client.from.mock.calls.findIndex(([t]: [string]) => t === 'sie_imports')].value.select
    expect(select.mock.calls[0][0]).toContain('job_state')
    expect(select.mock.calls[0][0]).toContain('undone_at')
  })

  it('reads the imports without undone_at until its migration has run', async () => {
    mockResults = {
      ...base(),
      sie_imports: [
        { data: null, error: { code: '42703', message: 'column sie_imports.undone_at does not exist' } },
        { data: [sieRow({ ...undoneJob, undone_at: undefined })] },
      ],
    }
    const client = makeClient()
    const report = await generateBehandlingshistorik(client, 'company-1', { periodId: 'period-1' })
    const sie = report!.events.filter((e) => e.source === 'sie_import')
    expect(sie.map((e) => e.code)).toEqual(['sie_import.completed'])
    expect(sie[0].details.at(-1)).toContain('Senare ångrad')
    const selects = client.from.mock.calls
      .map(([t]: [string], i: number) => (t === 'sie_imports' ? client.from.mock.results[i].value.select.mock.calls[0][0] : null))
      .filter(Boolean)
    expect(selects).toHaveLength(2)
    expect(selects[1]).not.toContain('undone_at')
  })

  it('reads a stopped repair from job_result in code, with no JSON-path select', async () => {
    mockResults = {
      ...base(),
      sie_imports: [{
        data: [{
          ...sieRow({
            filename: 'Granskad rättelse av dubbla SIE-verifikationer', job_kind: 'duplicate_repair', job_phase: 'undo',
            accounts_count: 0, transactions_count: 3, imported_at: null, created_at: '2026-01-05T09:55:00.000Z',
            job_state: 'completed', status: 'completed',
          }),
          job_result: { repairOutcome: 'stopped', stoppedAt: '2026-02-09T16:00:00.000Z' },
        }],
      }],
    }
    const client = makeClient()
    const report = await generateBehandlingshistorik(client, 'company-1', { periodId: 'period-1' })
    expect(report!.events.filter((e) => e.source === 'sie_import').map((e) => e.code)).toContain('sie_import.repair_stopped')
    const select = client.from.mock.results[client.from.mock.calls.findIndex(([t]: [string]) => t === 'sie_imports')].value.select
    expect(select.mock.calls[0][0]).toContain('job_result')
    expect(select.mock.calls[0][0]).not.toContain('->>')
  })

  it('shows a support removal in the import\'s own fiscal year, after the year ended, read from job_result', async () => {
    mockResults = {
      ...base(),
      sie_imports: [{ data: [{ ...sieRow(undoneJob), job_result: { success: true, support_removal: storedRemoval('period-1') } }] }],
    }
    const report = await generateBehandlingshistorik(makeClient(), 'company-1', { periodId: 'period-1' })
    const sie = report!.events.filter((e) => e.source === 'sie_import')
    expect(sie.map((e) => e.code)).toEqual(['sie_import.completed', 'sie_import.undone', 'sie_import.removed'])
    expect(sie[2].details).toContain('Serie A: A801-A1358 omnumrerade till A1-A558, det tidigare systemets nummer')
  })

  it('leaves out the removal of another year\'s import that happened outside the window', async () => {
    mockResults = {
      ...base(),
      sie_imports: [{ data: [{ ...sieRow(undoneJob), job_result: { support_removal: storedRemoval('period-0') } }] }],
    }
    const report = await generateBehandlingshistorik(makeClient(), 'company-1', { periodId: 'period-1' })
    expect(report!.events.filter((e) => e.source === 'sie_import').map((e) => e.code)).toEqual(['sie_import.completed', 'sie_import.undone'])
  })

  it('fails on any other read error', async () => {
    mockResults = { ...base(), sie_imports: [{ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }] }
    await expect(generateBehandlingshistorik(makeClient(), 'company-1', { periodId: 'period-1' })).rejects.toMatchObject({ code: '57014' })
  })
})

// ============================================================
// export
// ============================================================

describe('buildBehandlingshistorikExport', () => {
  const report = {
    company: { name: 'Testbolaget AB', org_number: '556000-0001' },
    period: { id: 'p', name: 'RÅ 2026', start: '2026-01-01', end: '2026-12-31' },
    range: { from: '2026-01-01', to: '2026-12-31' },
    mode: 'fiscal_year' as const,
    generated_at: '2026-08-21T12:00:00.000Z',
    app_version: 'abc1234',
    total_events: 1,
    by_category: { verifikation: 1, kontoplan: 0, installningar: 0, period: 0, import: 0, atkomst: 0, arkiv: 0, beslut: 0, ovrigt: 0 },
    events: [
      {
        id: 'entry:1',
        occurred_at: '2026-03-10T09:30:00.000Z',
        category: 'verifikation' as const,
        code: 'journal_entry.committed',
        event: 'Verifikation bokförd',
        object: 'A12',
        actor: { type: 'user' as const, user_id: 'u', label: 'anna@example.se' },
        details: ['Datum: 2026-03-09', 'Källa: Manuell'],
        source: 'journal_entries' as const,
        count: 1,
      },
    ],
  }

  it('csv carries a BOM, the header row and Swedish local time', async () => {
    const out = await buildBehandlingshistorikExport(report, 'csv')
    expect(out.contentType).toBe('text/csv; charset=utf-8')
    expect(out.filename).toBe('behandlingshistorik-testbolaget-ab-20261231.csv')
    const text = out.buffer.toString('utf-8')
    expect(text.charCodeAt(0)).toBe(0xfeff)
    // Exactly one BOM: SheetJS adds its own for csv, we must not double it.
    expect(text.charCodeAt(1)).not.toBe(0xfeff)
    expect(text.startsWith('﻿Tidpunkt,Kategori,Händelse,Objekt,Utförd av,Detaljer,Kod,Antal')).toBe(true)
    expect(text).toContain('2026-03-10 10:30:00')
    expect(text).toContain('Datum: 2026-03-09 | Källa: Manuell')
  })

  it('xlsx is a non-empty workbook with the xlsx mime type', async () => {
    const out = await buildBehandlingshistorikExport(report, 'xlsx')
    expect(out.contentType).toContain('spreadsheetml')
    expect(out.filename.endsWith('.xlsx')).toBe(true)
    expect(out.buffer.length).toBeGreaterThan(100)
  })
})

// ============================================================
// Behandlingsregler and program versions (BFNAR 2013:2 p. 9.16, 2nd paragraph)
// ============================================================

describe('auditRowToEvent: mailboxes the receipt hunt reads', () => {
  it('shows who connected which mailbox, with the access granted', () => {
    const event = auditRowToEvent(
      auditRow({
        table_name: 'mail_connections',
        action: 'INSERT',
        new_state: {
          email_address: 'ekonomi@example.se',
          provider: 'gmail',
          scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
        },
      }),
    )
    expect(event).toMatchObject({
      category: 'atkomst',
      code: 'mail_connection.connected',
      event: 'Brevlåda ansluten',
      object: 'ekonomi@example.se',
      details: ['Behörighet: https://www.googleapis.com/auth/gmail.readonly'],
      actor: { type: 'user', user_id: 'user-1' },
    })
  })

  it('shows a disconnect and whether the provider confirmed the access was withdrawn', () => {
    const event = auditRowToEvent(
      auditRow({
        table_name: 'mail_connections',
        action: 'DELETE',
        old_state: { email_address: 'ekonomi@example.se', provider: 'gmail' },
        new_state: { provider_revocation: 'revoked' },
      }),
    )
    expect(event).toMatchObject({
      category: 'atkomst',
      code: 'mail_connection.disconnected',
      event: 'Brevlåda frånkopplad',
      object: 'ekonomi@example.se',
      details: ['Återkallad hos leverantören: ja'],
    })
  })

  it('still shows a disconnect written before the outcome was recorded', () => {
    const event = auditRowToEvent(
      auditRow({
        table_name: 'mail_connections',
        action: 'DELETE',
        old_state: { email_address: 'ekonomi@example.se', provider: 'gmail' },
        new_state: null,
      }),
    )
    expect(event).toMatchObject({ code: 'mail_connection.disconnected', details: [] })
  })
})

describe('auditRowToEvent: the collections connection', () => {
  const base = { display_name: 'Acme Inkasso', state: 'connecting', minimum_amount: 100, default_start_step: 'reminder', clearing_account: '1689', terms_version: null }

  it('shows the consent that started an activation, with the terms version read', () => {
    const event = auditRowToEvent(
      auditRow({ table_name: 'collection_connections', action: 'INSERT', new_state: { ...base, catalogue_terms_version: 'v3', dpa_version: 'p1' } }),
    )
    expect(event).toMatchObject({
      category: 'atkomst',
      code: 'collection_connection.consented',
      object: 'Acme Inkasso',
      details: ['Villkor lästa och godkända i appen: version v3', 'Personuppgiftsvillkor: version p1'],
      actor: { type: 'user', user_id: 'user-1' },
    })
  })

  it('shows activation by the status poll as the system, and the end with the person', () => {
    const activated = auditRowToEvent(
      auditRow({
        table_name: 'collection_connections',
        action: 'UPDATE',
        user_id: null,
        actor_id: null,
        actor_type: 'system',
        old_state: base,
        new_state: { ...base, state: 'active' },
      }),
    )
    expect(activated).toMatchObject({ code: 'collection_connection.activated', actor: { type: 'system', user_id: null } })
    const ended = auditRowToEvent(
      auditRow({ table_name: 'collection_connections', action: 'UPDATE', old_state: { ...base, state: 'active' }, new_state: { ...base, state: 'disconnected' } }),
    )
    expect(ended).toMatchObject({ code: 'collection_connection.ended', event: 'Påminnelser och inkasso avslutat' })
  })

  it('shows accepted terms and diffs the rules with readable values', () => {
    const terms = auditRowToEvent(
      auditRow({ table_name: 'collection_connections', action: 'UPDATE', old_state: base, new_state: { ...base, terms_version: 'v4' } }),
    )
    expect(terms).toMatchObject({ code: 'collection_connection.terms_accepted', details: ['Version: v4'] })
    const rules = auditRowToEvent(
      auditRow({
        table_name: 'collection_connections',
        action: 'UPDATE',
        old_state: base,
        new_state: { ...base, default_start_step: 'collection', clearing_account: '1688' },
      }),
    )
    expect(rules).toMatchObject({
      category: 'installningar',
      code: 'collection_connection.updated',
      details: ['Första steget: Påminnelse → Inkassokrav direkt', 'Konto för inbetalningar via inkassobolaget: 1689 → 1688'],
    })
    expect(
      auditRowToEvent(auditRow({ table_name: 'collection_connections', action: 'UPDATE', old_state: base, new_state: { ...base, health: 'degraded' } })),
    ).toBeNull()
  })
})

describe('auditRowToEvent: behandlingsregler', () => {
  it('mapping_rules: a rule change names the rule and diffs the accounts', () => {
    const ins = auditRowToEvent(
      auditRow({ table_name: 'mapping_rules', action: 'INSERT', new_state: { rule_name: 'Spotify', debit_account: '6540', credit_account: '1930', is_active: true } }),
    )!
    expect(ins).toMatchObject({ category: 'installningar', code: 'mapping_rule.created', object: 'Spotify' })

    const upd = auditRowToEvent(
      auditRow({
        table_name: 'mapping_rules',
        action: 'UPDATE',
        old_state: { rule_name: 'Spotify', debit_account: '6540', updated_at: 'x' },
        new_state: { rule_name: 'Spotify', debit_account: '6212', updated_at: 'y' },
      }),
    )!
    expect(upd.code).toBe('mapping_rule.updated')
    expect(upd.details).toEqual(['Debetkonto: 6540 → 6212'])
  })

  it('cash_accounts: a verifikationsserie change names the account and diffs the series', () => {
    const upd = auditRowToEvent(
      auditRow({
        table_name: 'cash_accounts',
        action: 'UPDATE',
        old_state: { name: 'Företagskort', ledger_account: '1931', voucher_series: null, balance: 100, updated_at: 'x' },
        new_state: { name: 'Företagskort', ledger_account: '1931', voucher_series: 'M', balance: 250, updated_at: 'y' },
      }),
    )!
    expect(upd).toMatchObject({ category: 'installningar', code: 'cash_account.updated', object: 'Företagskort 1931' })
    expect(upd.details).toEqual(['Verifikationsserie: (tomt) → M'])

    // Bank-sync churn (balance, name) is not a behandlingsregel: no event.
    const churn = auditRowToEvent(
      auditRow({
        table_name: 'cash_accounts',
        action: 'UPDATE',
        old_state: { name: 'Företagskort', ledger_account: '1931', voucher_series: 'M', balance: 100 },
        new_state: { name: 'Företagskort', ledger_account: '1931', voucher_series: 'M', balance: 250 },
      }),
    )
    expect(churn).toBeNull()
  })

  // Migration 20260921070500 (desk crm#59): both flags redirect an automatic
  // account choice, so a change is a behandlingsregel change (BFNAR 2013:2
  // p. 9.16) and shows from/to with who did it.
  it('cash_accounts: turning an account off and moving the primary show from/to and the actor', () => {
    const disabled = auditRowToEvent(
      auditRow({
        table_name: 'cash_accounts',
        action: 'UPDATE',
        old_state: { name: 'Företagskonto', ledger_account: '1930', enabled: true, is_primary: false, balance: 0 },
        new_state: { name: 'Företagskonto', ledger_account: '1930', enabled: false, is_primary: false, balance: 0 },
      }),
    )!
    expect(disabled).toMatchObject({ category: 'installningar', code: 'cash_account.updated', object: 'Företagskonto 1930' })
    expect(disabled.details).toEqual(['Aktivt: Ja → Nej'])

    const primary = auditRowToEvent(
      auditRow({
        table_name: 'cash_accounts',
        action: 'UPDATE',
        old_state: { name: 'Bankkonto 1940', ledger_account: '1940', enabled: true, is_primary: false },
        new_state: { name: 'Bankkonto 1940', ledger_account: '1940', enabled: true, is_primary: true },
      }),
    )!
    expect(primary.details).toEqual(['Primärt bankkonto: Nej → Ja'])

    // A service-role write (bank sync, re-enable on ingest) is logged by the
    // trigger as actor_type 'system' with no user: the report says so.
    const system = auditRowToEvent(
      auditRow({
        table_name: 'cash_accounts',
        action: 'UPDATE',
        user_id: null,
        actor_id: null,
        actor_type: 'system',
        old_state: { name: 'Företagskonto', ledger_account: '1930', enabled: false },
        new_state: { name: 'Företagskonto', ledger_account: '1930', enabled: true },
      }),
    )!
    expect(system.actor).toMatchObject({ type: 'system', user_id: null })
    expect(system.details).toEqual(['Aktivt: Nej → Ja'])
  })

  // remove_cash_account (20260927212000, #3130): the removal names the
  // account from old_state and says how many unbooked rows went with it.
  it('cash_accounts: a user removal names the account and the unbooked rows that went', () => {
    const removed = auditRowToEvent(
      auditRow({
        table_name: 'cash_accounts',
        action: 'DELETE',
        old_state: { id: 'ca-1', name: 'Privatkonto', ledger_account: '1931', currency: 'SEK' },
        new_state: { name: 'Privatkonto', ledger_account: '1931', deleted_transactions: 162, released_underlag: 0 },
      }),
    )!
    expect(removed).toMatchObject({
      category: 'installningar',
      code: 'cash_account.deleted',
      event: 'Bankkonto borttaget',
      object: 'Privatkonto 1931',
    })
    expect(removed.details).toEqual(['Obokförda transaktioner borttagna: 162'])
  })

  it('categorization_templates: the learning columns never reach the report', () => {
    // The DB trigger filters these already (20260901103000 + 20260901200000);
    // the read model must not resurrect them if a row slips through, or every
    // booking would appear as a system change. counterparty_aliases counts as
    // learning: prod's first 30 minutes of trigger rows were 15/16 alias
    // noise, and those pre-fix rows are still in audit_log and must render as
    // no-ops.
    const learning = auditRowToEvent(
      auditRow({
        table_name: 'categorization_templates',
        action: 'UPDATE',
        old_state: { counterparty_name: 'Spotify AB', debit_account: '6540', occurrence_count: 4, confidence: 0.7, counterparty_aliases: ['SPOTIFY'] },
        new_state: { counterparty_name: 'Spotify AB', debit_account: '6540', occurrence_count: 5, confidence: 0.9, counterparty_aliases: ['SPOTIFY', 'SPOTIFY STOCKHOLM 4711'] },
      }),
    )
    expect(learning).toBeNull()

    const rule = auditRowToEvent(
      auditRow({
        table_name: 'categorization_templates',
        action: 'UPDATE',
        old_state: { counterparty_name: 'Spotify AB', debit_account: '6540' },
        new_state: { counterparty_name: 'Spotify AB', debit_account: '6212' },
      }),
    )!
    expect(rule).toMatchObject({ code: 'categorization_template.updated', object: 'Spotify AB' })
    expect(rule.details).toEqual(['Debetkonto: 6540 → 6212'])
  })

  it('salary_payroll_config: statutory constants are BFN\'s own automatkontering example', () => {
    const upd = auditRowToEvent(
      auditRow({
        table_name: 'salary_payroll_config',
        company_id: null,
        user_id: null,
        actor_type: 'system',
        action: 'UPDATE',
        old_state: { config_year: 2026, employer_fee_rate: 0.3142, created_at: 'x' },
        new_state: { config_year: 2026, employer_fee_rate: 0.3097, created_at: 'x' },
      }),
    )!
    expect(upd).toMatchObject({ category: 'installningar', code: 'payroll_config.updated', object: 'Löneår 2026' })
    expect(upd.details).toEqual(['employer_fee_rate: 0.3142 → 0.3097'])
    expect(upd.actor.type).toBe('system')
  })

  it('import logs only add what the rows themselves can no longer show: a deletion', () => {
    expect(auditRowToEvent(auditRow({ table_name: 'sie_imports', action: 'INSERT', new_state: { filename: 'bok.se' } }))).toBeNull()
    const del = auditRowToEvent(auditRow({ table_name: 'sie_imports', action: 'DELETE', old_state: { filename: 'bok.se' } }))!
    expect(del).toMatchObject({ category: 'import', code: 'sie_import.deleted', object: 'bok.se' })

    expect(auditRowToEvent(auditRow({ table_name: 'bank_file_imports', action: 'UPDATE', new_state: { filename: 'kontoutdrag.csv' } }))).toBeNull()
    const bankDel = auditRowToEvent(auditRow({ table_name: 'bank_file_imports', action: 'DELETE', old_state: { filename: 'kontoutdrag.csv' } }))!
    expect(bankDel.code).toBe('bank_file_import.deleted')
  })
})

describe('appReleaseEvent', () => {
  it('dates a program version as a system event with no human actor', () => {
    const ev = appReleaseEvent({ version: 'b643e6ce6d44', first_seen_at: '2026-03-10T10:00:00.000Z', source: 'runtime' })
    expect(ev).toMatchObject({
      category: 'ovrigt',
      code: 'system.release',
      object: 'b643e6ce6d44',
      event: 'Ny programversion i drift',
    })
    expect(ev.actor).toEqual({ type: 'system', user_id: null, actor_label: null })
  })

  it('names a non-runtime source rather than claiming the system saw it', () => {
    const ev = appReleaseEvent({ version: 'aaaaaaaaaaaa', first_seen_at: '2026-03-10T10:00:00.000Z', source: 'backfill' })
    expect(ev.details).toEqual(['Källa: backfill'])
  })
})

describe('appReleaseEvents: per-day roll-up', () => {
  const day = (h: number, v: string) => ({ version: v, first_seen_at: `2026-03-10T0${h}:00:00.000Z`, source: 'runtime' })

  it('keeps a single deploy as a single named version', () => {
    const out = appReleaseEvents([day(8, 'aaaaaaaaaaaa')])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ code: 'system.release', object: 'aaaaaaaaaaaa' })
  })

  it('collapses a day of deploys into one dated event that still names every build id', () => {
    // Truncating the list would defeat the entry: an auditor has to be able to
    // reconstruct which versions ran that day.
    const versions = ['a1', 'b2', 'c3', 'd4', 'e5', 'f6', 'g7']
    const out = appReleaseEvents(versions.map((v, i) => day(i + 1, v)))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ code: 'system.release.bulk', object: '7 versioner', count: 7 })
    expect(out[0].details).toEqual(['a1, b2, c3, d4, e5, f6, g7'])
  })

  it('never lets the deploy rate swamp the report: a year of merges stays one event per day', () => {
    // main takes ~570 merges a month; per-version events would be ~7 000 a year
    // and would trip the PDF's 4 000-event guard on their own.
    const rows = []
    for (let d = 0; d < 365; d++) {
      const date = new Date(Date.UTC(2026, 0, 1 + d, 9))
      for (let n = 0; n < 19; n++) rows.push({ version: `v${d}-${n}`, first_seen_at: date.toISOString(), source: 'runtime' })
    }
    expect(rows).toHaveLength(6935)
    expect(appReleaseEvents(rows)).toHaveLength(365)
  })

  it('groups on the Swedish calendar day, not UTC', () => {
    // Both timestamps are 2026-07-10 in UTC, but Stockholm is UTC+2 in July:
    // 21:00Z is the 10th at 23:00 and 23:00Z is already the 11th at 01:00.
    // Grouping on the raw ISO date would merge them into one event.
    const out = appReleaseEvents([
      { version: 'beforemidnight', first_seen_at: '2026-07-10T21:00:00.000Z', source: 'runtime' },
      { version: 'aftermidnight', first_seen_at: '2026-07-10T23:00:00.000Z', source: 'runtime' },
    ])
    expect(out).toHaveLength(2)
    expect(out.map((e) => e.object)).toEqual(['beforemidnight', 'aftermidnight'])
  })
})

describe('collection cases', () => {
  const caseRow = {
    id: 'case-1',
    invoice_id: 'inv-1',
    submission_status: 'registered',
    opened_by: 'user-1',
    opened_at: '2026-03-01T09:00:00.000Z',
    closed_at: '2026-04-02T07:00:00.000Z',
    close_reason: 'paid',
    provider_case_number: '205506',
    invoice: { invoice_number: '1042' },
  }

  it('lists a handover by the person who made it and the provider closing the case', () => {
    const [opened, closed] = collectionCaseEvents(caseRow)
    expect(opened).toMatchObject({
      code: 'collection_case.handed_over',
      category: 'ovrigt',
      event: 'Faktura lämnad till inkasso',
      object: 'Faktura 1042',
      actor: { type: 'user', user_id: 'user-1' },
      source: 'collection_case',
    })
    expect(opened.details).toEqual(['Ärendenummer: 205506', 'Accounted skickar inga egna påminnelser för fakturan medan ärendet är öppet'])
    expect(closed).toMatchObject({ code: 'collection_case.closed', occurred_at: '2026-04-02T07:00:00.000Z', details: ['Orsak: betald'], actor: { type: 'system' } })
  })

  it('leaves out a handover that never reached the provider', () => {
    expect(collectionCaseEvents({ ...caseRow, submission_status: 'failed' })).toEqual([])
    expect(collectionCaseEvents({ ...caseRow, submission_status: 'preparing', closed_at: null })).toEqual([])
    expect(collectionCaseEvents({ ...caseRow, submission_status: 'submitted', closed_at: null })).toHaveLength(1)
  })

  it('reads the invoice number from either embed shape', () => {
    expect(collectionCaseEvents({ ...caseRow, invoice: [{ invoice_number: '7' }] })[0].object).toBe('Faktura 7')
    expect(collectionCaseEvents({ ...caseRow, invoice: null })[0].object).toBe('Faktura')
  })

  it('names a decision, who took it and what was checked first', () => {
    const ev = collectionDecisionEvent(
      {
        id: 'ev-1',
        case_id: 'case-1',
        occurred_at: '2026-03-20T10:00:00.000Z',
        label: 'approve_step',
        actor_user_id: 'user-2',
        raw: { action: 'approve_step', channel: 'agent', bank_checked_at: '2026-03-20T09:59:00.000Z', bank_attested: false },
      },
      caseRow,
    )
    expect(ev).toMatchObject({ code: 'collection_case.decision', event: 'Inkassoärende: nästa steg godkänt', object: 'Faktura 1042', actor: { user_id: 'user-2' } })
    expect(ev.details).toEqual(['Banken kontrollerad: ingen obokförd inbetalning', 'Föreslaget av en agent eller API-nyckel'])
    const pause = collectionDecisionEvent(
      { id: 'ev-2', case_id: 'case-x', occurred_at: '2026-03-21T10:00:00.000Z', label: 'withdraw', actor_user_id: 'user-2', raw: { action: 'withdraw', withdraw_fee_acknowledged: true } },
      undefined,
    )
    expect(pause.event).toBe('Inkassoärende: ärendet återkallat')
    expect(pause.object).toBe('Faktura')
    expect(pause.details).toEqual(['Användaren godkände att återkallelsen kan kosta en avgift'])
  })

  it('reads cases and decisions into the report inside the window', async () => {
    mockResults = {
      fiscal_periods: [{ data: period }],
      company_settings: [{ data: { company_name: 'T', org_number: null } }],
      company_migration_resets: [{ data: [] }],
      app_releases: [{ data: [] }],
      sie_imports: [{ data: [] }],
      bank_file_imports: [{ data: [] }],
      collection_cases: [{ data: [caseRow, { ...caseRow, id: 'case-0', opened_at: '2025-11-01T09:00:00.000Z', closed_at: null }] }],
      collection_case_events: [
        { data: [{ id: 'ev-1', case_id: 'case-1', occurred_at: '2026-03-02T10:00:00.000Z', label: 'pause', actor_user_id: 'user-1', raw: { action: 'pause', until: '2026-03-31' } }] },
      ],
    }
    const client = makeClient()
    const report = await generateBehandlingshistorik(client, 'company-1', { periodId: 'period-1' })
    expect(report!.events.map((e) => e.code)).toEqual(['collection_case.handed_over', 'collection_case.decision', 'collection_case.closed'])
    expect(report!.events[1].details).toEqual(['Till och med 2026-03-31'])
    expect(report!.by_category.ovrigt).toBe(3)
    expect(client.from).toHaveBeenCalledWith('collection_case_events')
  })
})

// ============================================================
// Beslut och förslag (suggestion_log, read as decision receipts)
// ============================================================

describe('rules for automatic booking (grants)', () => {
  const grant = {
    id: 'g-1', counterparty_key: 'spotify', counterparty_label: 'Spotify AB', version: 1, account_number: '5420',
    vat_treatment: 'standard_25', line_accounts: ['1930', '2641', '5420'], amount_limit_sek: 5000, monthly_limit_sek: 10000,
    credential_scope: 'any', valid_from: '2026-10-12T08:00:00Z', revoked_at: null, revoked_reason: null,
  }

  it('dates the rule when it is accepted, saying what it permits', () => {
    const ev = auditRowToEvent(auditRow({ table_name: 'company_grants', action: 'INSERT', actor_type: 'api_key', actor_label: 'Claude', new_state: grant }))
    expect(ev).toMatchObject({
      category: 'installningar',
      code: 'grant.accepted',
      event: 'Regel för automatisk bokföring godkänd',
      object: 'Regel för automatisk bokföring: Spotify AB, upp till 5\u00a0000 kr',
    })
    expect(ev!.details).toEqual([
      'Version: 1',
      'Bokföring: konto 5420, moms 25 %',
      'Konton i verifikatet: 1930, 2641, 5420',
      'Högst per månad: 10\u00a0000 kr',
      'Gäller: alla nycklar i företaget',
      'Gäller från: 2026-10-12',
    ])
  })

  it('dates a revocation and a supersession, and nothing else that changes', () => {
    const revoked = auditRowToEvent(auditRow({
      table_name: 'company_grants', action: 'UPDATE', old_state: grant,
      new_state: { ...grant, revoked_at: '2026-10-20T08:00:00Z', revoked_reason: 'revoked' },
    }))
    expect(revoked).toMatchObject({ code: 'grant.revoked', event: 'Regel för automatisk bokföring återkallad', details: ['Version: 1'] })
    const superseded = auditRowToEvent(auditRow({
      table_name: 'company_grants', action: 'UPDATE', old_state: grant,
      new_state: { ...grant, revoked_at: '2026-10-20T08:00:00Z', revoked_reason: 'superseded' },
    }))
    expect(superseded).toMatchObject({ code: 'grant.superseded', event: 'Regel för automatisk bokföring ersatt av ny version' })
    expect(auditRowToEvent(auditRow({ table_name: 'company_grants', action: 'UPDATE', old_state: grant, new_state: grant }))).toBeNull()
  })

  it("dates a supplier's rule with its line bookings, its VAT treatment and what it covers", () => {
    const supplierGrant = {
      id: 'g-2', operation_type: 'create_supplier_invoice_from_inbox', counterparty_key: 'supplier:s-1', counterparty_label: 'Telia Sverige AB',
      supplier_id: 's-1', version: 1, account_number: null, category: null, item_lines: ['3740:0', '6212:25'], vat_treatment: 'standard_25',
      reverse_charge_kind: null, line_accounts: ['2440', '2641', '3740', '6212'], amount_limit_sek: 1500, monthly_limit_sek: null,
      credential_scope: 'any', valid_from: '2026-10-17T08:00:00Z', revoked_at: null, revoked_reason: null,
    }
    const ev = auditRowToEvent(auditRow({ table_name: 'company_grants', action: 'INSERT', actor_type: 'user', new_state: supplierGrant }))
    expect(ev).toMatchObject({
      code: 'grant.accepted',
      event: 'Regel för automatisk bokföring godkänd',
      object: 'Regel för automatisk bokföring av leverantörsfakturor: Telia Sverige AB, upp till 1\u00a0500 kr inklusive moms',
    })
    expect(ev!.details).toEqual([
      'Version: 1',
      'Leverantör: Telia Sverige AB (s-1)',
      'Fakturarader: konto 3740 utan moms, konto 6212 moms 25 %',
      'Momsbehandling: moms 25 %',
      'Gäller: fakturor från inkorgen i SEK med underlag, som bokförs när de registreras',
      'Konton i verifikatet: 2440, 2641, 3740, 6212',
      'Gäller: alla nycklar i företaget',
      'Gäller från: 2026-10-17',
    ])
    const reverseCharge = auditRowToEvent(auditRow({
      table_name: 'company_grants', action: 'INSERT',
      new_state: { ...supplierGrant, item_lines: ['6540:0'], vat_treatment: 'reverse_charge', reverse_charge_kind: 'eu_services' },
    }))
    expect(reverseCharge!.details).toContain('Momsbehandling: omvänd betalningsskyldighet (tjänster från EU)')
    const revoked = auditRowToEvent(auditRow({
      table_name: 'company_grants', action: 'UPDATE', old_state: supplierGrant,
      new_state: { ...supplierGrant, revoked_at: '2026-10-20T08:00:00Z', revoked_reason: 'revoked' },
    }))
    expect(revoked).toMatchObject({
      code: 'grant.revoked',
      object: 'Regel för automatisk bokföring av leverantörsfakturor: Telia Sverige AB, upp till 1\u00a0500 kr inklusive moms',
    })
  })

  it('dates the pause and the resumption of every rule', () => {
    expect(auditRowToEvent(auditRow({ table_name: 'company_grant_settings', action: 'INSERT', new_state: { paused: true } }))).toMatchObject({
      code: 'grants.paused',
      event: 'Automatisk bokföring enligt regler pausad',
      object: 'Alla regler för automatisk bokföring',
    })
    expect(auditRowToEvent(auditRow({ table_name: 'company_grant_settings', action: 'UPDATE', old_state: { paused: true }, new_state: { paused: false } }))).toMatchObject({
      code: 'grants.resumed',
    })
  })
})

describe('auditRowToEvent: the attest policy for supplier invoices (#124)', () => {
  const policy = {
    company_id: 'company-1',
    enabled: true,
    threshold_amount: 5000,
    mode: 'any',
    attesters: ['user-anna'],
    preparer_may_attest: false,
    updated_by: 'user-1',
  }

  it('states every rule when the policy is first saved', () => {
    expect(auditRowToEvent(auditRow({ table_name: 'company_attest_policies', action: 'INSERT', new_state: policy }))).toMatchObject({
      category: 'installningar',
      code: 'attest_policy.created',
      event: 'Attestregler för leverantörsfakturor sparade',
      object: 'Leverantörsfakturor',
      details: [
        'Attest krävs: Ja',
        'Från belopp: 5 000 kr',
        'Attest av: en attestant räcker',
        'Attestanter: 1 st',
        'Den som registrerat får attestera: Nej',
      ],
    })
  })

  it('lists only the rules a change touched, an attester swapped included', () => {
    const changed = { ...policy, threshold_amount: null, mode: 'all', attesters: ['user-bo'] }
    expect(auditRowToEvent(auditRow({ table_name: 'company_attest_policies', action: 'UPDATE', old_state: policy, new_state: changed }))).toMatchObject({
      code: 'attest_policy.updated',
      event: 'Attestregler för leverantörsfakturor ändrade',
      details: ['Från belopp: 5 000 kr → alla fakturor', 'Attest av: en attestant räcker → alla attestanter', 'Attestanter: 1 st → 1 st'],
    })
  })

  it('renders nothing for an update that changed no rule', () => {
    expect(auditRowToEvent(auditRow({ table_name: 'company_attest_policies', action: 'UPDATE', old_state: policy, new_state: { ...policy, updated_by: 'user-2' } }))).toBeNull()
  })
})

describe('auditRowToEvent: attest levels (#135)', () => {
  const limit = { id: 'limit-1', company_id: 'company-1', user_id: 'user-anna', scope: 'supplier_invoice', max_amount_sek: 50000, updated_by: 'user-1' }

  it('states a limit set, changed and removed', () => {
    expect(auditRowToEvent(auditRow({ table_name: 'company_attest_limits', action: 'INSERT', new_state: limit }))).toMatchObject({
      category: 'installningar',
      code: 'attest_limit.set',
      event: 'Attestgräns satt för leverantörsfakturor',
      object: 'Leverantörsfakturor',
      details: ['Gräns: 50 000 kr'],
    })
    expect(
      auditRowToEvent(auditRow({ table_name: 'company_attest_limits', action: 'UPDATE', old_state: limit, new_state: { ...limit, max_amount_sek: null } })),
    ).toMatchObject({ code: 'attest_limit.changed', details: ['Gräns: 50 000 kr → ingen gräns'] })
    expect(auditRowToEvent(auditRow({ table_name: 'company_attest_limits', action: 'DELETE', old_state: limit, new_state: null }))).toMatchObject({
      code: 'attest_limit.removed',
      event: 'Attestgräns borttagen för leverantörsfakturor',
      details: ['Gräns: 50 000 kr'],
    })
    expect(
      auditRowToEvent(auditRow({ table_name: 'company_attest_limits', action: 'UPDATE', old_state: limit, new_state: { ...limit, updated_by: 'user-2' } })),
    ).toBeNull()
  })

  it('names two attesters from an amount among the policy rules', () => {
    const policy = { company_id: 'company-1', enabled: true, threshold_amount: null, mode: 'any', attesters: ['a', 'b'], preparer_may_attest: false, two_step_from_sek: null }
    expect(
      auditRowToEvent(
        auditRow({ table_name: 'company_attest_policies', action: 'UPDATE', old_state: policy, new_state: { ...policy, two_step_from_sek: 100000 } }),
      ),
    ).toMatchObject({ code: 'attest_policy.updated', details: ['Två attestanter från: aldrig → 100 000 kr'] })
  })
})

describe('auditRowToEvent: förattest and substitutes (#192)', () => {
  const policy = {
    company_id: 'company-1',
    enabled: true,
    threshold_amount: null,
    mode: 'any',
    attesters: ['a', 'b'],
    preparer_may_attest: false,
    two_step_from_sek: null,
    pre_attesters: [],
    project_attesters: {},
  }

  it('states no förattest when the policy names none, and the change when it names one', () => {
    const created = auditRowToEvent(auditRow({ table_name: 'company_attest_policies', action: 'INSERT', new_state: policy }))
    expect(created?.details?.some((d) => d.startsWith('Förattest'))).toBe(false)
    expect(
      auditRowToEvent(
        auditRow({
          table_name: 'company_attest_policies',
          action: 'UPDATE',
          old_state: policy,
          new_state: { ...policy, pre_attesters: ['c'], project_attesters: { P100: ['d'], P200: ['d', 'e'] } },
        }),
      ),
    ).toMatchObject({
      code: 'attest_policy.updated',
      details: ['Förattest av fakturor utan projekt: 0 st → 1 st', 'Förattest per projekt: 0 projekt → 2 projekt'],
    })
  })

  it('states a substitute added and removed with its period', () => {
    const row = { id: 's-1', company_id: 'company-1', user_id: 'a', substitute_user_id: 'b', starts_on: '2026-12-21', ends_on: '2027-01-06', created_by: 'a' }
    expect(auditRowToEvent(auditRow({ table_name: 'company_attest_substitutes', action: 'INSERT', new_state: row }))).toMatchObject({
      category: 'installningar',
      code: 'attest_substitute.added',
      event: 'Ersättare för attest vald',
      object: 'Leverantörsfakturor',
      details: ['Period: 2026-12-21 till 2027-01-06'],
    })
    expect(auditRowToEvent(auditRow({ table_name: 'company_attest_substitutes', action: 'DELETE', old_state: row, new_state: null }))).toMatchObject({
      code: 'attest_substitute.removed',
      details: ['Period: 2026-12-21 till 2027-01-06'],
    })
  })
})

describe('auditRowToEvent: hard blocks (accounted#130)', () => {
  const block = {
    id: 'block-1',
    company_id: 'company-1',
    rule_id: 'block-1',
    version: 1,
    accounts: ['6250', '5410'],
    counterparty_key: 'google cloud',
    counterparty_label: 'Google Cloud',
    amount_from_sek: '5000.00',
    vat_treatment: 'reverse_charge',
    note: 'Kontrollanten granskar',
    valid_from: '2026-10-29T10:00:00Z',
    revoked_at: null,
    revoked_reason: null,
  }

  it('is an audited table', () => {
    expect(AUDITED_TABLES).toContain('booking_review_rules')
  })

  it('states what a block matches when it is added, dated', () => {
    const event = auditRowToEvent(auditRow({ table_name: 'booking_review_rules', action: 'INSERT', new_state: block }))
    expect(event).toMatchObject({
      category: 'installningar',
      code: 'booking_review_rule.created',
      event: 'Spärr för bokföring tillagd',
      details: [
        'Version: 1',
        'Gäller: bokningar av bankrader som spärren träffar bokförs bara av en person, från granskningen',
        'Anteckning: Kontrollanten granskar',
        'Gäller från: 2026-10-29',
      ],
    })
    expect(event?.object).toMatch(/^Spärr: konton 6250, 5410, Google Cloud, från 5.000 kr, omvänd betalningsskyldighet$/)
  })

  it('states an archive and a new version, and nothing else', () => {
    const archived = { ...block, revoked_at: '2026-10-30T09:00:00Z', revoked_reason: 'archived' }
    expect(
      auditRowToEvent(auditRow({ table_name: 'booking_review_rules', action: 'UPDATE', old_state: block, new_state: archived })),
    ).toMatchObject({ code: 'booking_review_rule.archived', event: 'Spärr för bokföring arkiverad', details: ['Version: 1'] })
    const superseded = { ...block, revoked_at: '2026-10-30T09:00:00Z', revoked_reason: 'superseded' }
    expect(
      auditRowToEvent(auditRow({ table_name: 'booking_review_rules', action: 'UPDATE', old_state: block, new_state: superseded })),
    ).toMatchObject({ code: 'booking_review_rule.superseded' })
    expect(
      auditRowToEvent(auditRow({ table_name: 'booking_review_rules', action: 'UPDATE', old_state: block, new_state: { ...block } })),
    ).toBeNull()
  })

  it('names a block on one account and no VAT in the singular', () => {
    const single = { ...block, accounts: ['6071'], counterparty_key: null, counterparty_label: null, amount_from_sek: null, vat_treatment: 'none' }
    expect(auditRowToEvent(auditRow({ table_name: 'booking_review_rules', action: 'INSERT', new_state: single }))?.object).toBe(
      'Spärr: konto 6071, utan moms',
    )
  })
})

describe('auditRowToEvent: employee pay basis (accounted#30)', () => {
  // What audit_employee_pay_basis writes: the pay-basis columns and the name.
  const basis = {
    first_name: 'Test',
    last_name: 'Testsson',
    employment_type: 'employee',
    personnel_category: 'tjansteman',
    employment_start: '2026-01-01',
    employment_end: null,
    employment_degree: 100,
    hours_per_week: 40,
    workdays_per_week: 5,
    salary_type: 'monthly',
    monthly_salary: 30000,
    hourly_rate: null,
    tax_table_number: 33,
    tax_column: 1,
    is_sidoinkomst: false,
    jamkning_percentage: null,
    jamkning_valid_from: null,
    jamkning_valid_to: null,
    extra_tax_amount: null,
    extra_tax_percentage: null,
    f_skatt_status: 'a_skatt',
    f_skatt_verified_at: null,
    vacation_rule: 'procentregeln',
    vacation_days_per_year: 25,
    vacation_days_saved: 0,
    vacation_pay_rate: null,
    semestertillagg_rate: 0.0043,
    housing_benefit_type: null,
    vaxa_stod_eligible: false,
    vaxa_stod_start: null,
    vaxa_stod_end: null,
    fora_fok_id: null,
    fora_fok_start_date: null,
    default_dimensions: {},
    is_active: true,
  }

  /** The newest migration that (re)defines audit_employee_pay_basis. */
  function liveTriggerMigration(): string {
    const dir = path.join(__dirname, '..', '..', '..', '..', 'supabase', 'migrations')
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .filter((f) => readFileSync(path.join(dir, f), 'utf-8').includes('FUNCTION public.audit_employee_pay_basis('))
    expect(files.length).toBeGreaterThan(0)
    return readFileSync(path.join(dir, files[files.length - 1]), 'utf-8')
  }

  it('is an audited table', () => {
    expect(AUDITED_TABLES).toContain('employees')
  })

  it('labels exactly the columns the trigger logs, and never an identifier, bank or contact column', () => {
    const match = liveTriggerMigration().match(/c_pay_keys CONSTANT text\[\] := ARRAY\[([^\]]*)\]/)
    expect(match).not.toBeNull()
    const triggerKeys = [...match![1].matchAll(/'([^']+)'/g)].map((m) => m[1])
    expect(Object.keys(EMPLOYEE_PAY_FIELDS)).toEqual(triggerKeys)
    for (const pii of ['personnummer', 'personnummer_last4', 'clearing_number', 'bank_account_number', 'email', 'phone', 'address_line1', 'postal_code', 'city', 'tax_municipality']) {
      expect(triggerKeys).not.toContain(pii)
    }
  })

  it('states the starting pay basis when an employee is created, without unset fields or a "no"', () => {
    const event = auditRowToEvent(auditRow({ table_name: 'employees', action: 'INSERT', new_state: basis }))
    expect(event).toMatchObject({
      category: 'installningar',
      code: 'employee.created',
      event: 'Anställd upplagd med lönegrunder',
      object: 'Test Testsson',
      details: [
        'Anställningstyp: Anställd',
        'Personalkategori: Tjänsteman',
        'Anställningsdatum: 2026-01-01',
        'Sysselsättningsgrad (%): 100',
        'Timmar per vecka: 40',
        'Arbetsdagar per vecka: 5',
        'Löneform: Månadslön',
        'Månadslön: 30000',
        'Skattetabell: 33',
        'Skattekolumn: 1',
        'Skatteform: A-skatt',
        'Semesterregel: Procentregeln',
        'Semesterdagar per år: 25',
        'Sparade semesterdagar: 0',
        'Semestertillägg, procentsats: 0.0043',
        'Aktiv: Ja',
      ],
    })
  })

  it('states each changed pay-basis field, old and new, under the employee', () => {
    const raised = { ...basis, monthly_salary: 32500, employment_degree: 80, vacation_rule: 'sammaloneregeln' }
    expect(auditRowToEvent(auditRow({ table_name: 'employees', action: 'UPDATE', old_state: basis, new_state: raised }))).toMatchObject({
      category: 'installningar',
      code: 'employee.pay_basis_updated',
      event: 'Lönegrunder ändrade',
      object: 'Test Testsson',
      details: [
        'Sysselsättningsgrad (%): 100 → 80',
        'Månadslön: 30000 → 32500',
        'Semesterregel: Procentregeln → Sammalöneregeln',
      ],
    })
  })

  it('a soft delete reads as the employee turned inactive', () => {
    expect(
      auditRowToEvent(auditRow({ table_name: 'employees', action: 'UPDATE', old_state: basis, new_state: { ...basis, is_active: false } }))?.details,
    ).toEqual(['Aktiv: Ja → Nej'])
  })

  it('renders nothing for a name-only change, and never a column outside the pay basis', () => {
    expect(
      auditRowToEvent(auditRow({ table_name: 'employees', action: 'UPDATE', old_state: basis, new_state: { ...basis, last_name: 'Annan' } })),
    ).toBeNull()
    // Rows only ever carry the pay basis; even if one carried more, it stays out.
    const leaked = auditRowToEvent(auditRow({
      table_name: 'employees',
      action: 'UPDATE',
      old_state: { ...basis, personnummer: 'old-ciphertext', bank_account_number: '1111' },
      new_state: { ...basis, personnummer: 'new-ciphertext', bank_account_number: '2222', hourly_rate: 250 },
    }))
    expect(leaked?.details).toEqual(['Timlön: (tomt) → 250'])
    expect(JSON.stringify(leaked)).not.toMatch(/ciphertext|1111|2222/)
  })
})

describe('auditRowToEvent: bank-anchor moves (#2407)', () => {
  // What write_audit_log stores: the whole bank row, and the whole link row.
  const tx = {
    id: 'tx-1',
    company_id: 'company-1',
    date: '2026-03-10',
    description: 'Kortköp Kontorsvaror',
    amount: -700,
    currency: 'SEK',
    journal_entry_id: 'entry-1',
    is_business: true,
  }
  const link = {
    id: 'link-1',
    company_id: 'company-1',
    transaction_id: 'tx-1',
    journal_entry_id: 'entry-1',
    allocated_amount: -700,
    role: 'bank_line',
  }
  const entries = new Map([
    ['entry-1', { id: 'entry-1', voucher_series: 'A', voucher_number: 12, source_type: 'bank_transaction', source_id: 'tx-1' }],
    ['entry-2', { id: 'entry-2', voucher_series: 'A', voucher_number: 14, source_type: 'manual', source_id: null }],
  ])
  const ctx = { rattelseMetadataAt: new Map(), entryById: new Map(), linkedEntryById: entries }
  const audit = (
    table_name: 'transactions' | 'transaction_voucher_links',
    old_state: Record<string, unknown> | null,
    new_state: Record<string, unknown> | null,
    action: AuditLogEntry['action'] = 'UPDATE',
  ) => auditRow({ table_name, record_id: String((old_state ?? new_state)?.id), action, old_state, new_state })

  it('both anchors are audited tables', () => {
    expect(AUDITED_TABLES).toContain('transactions')
    expect(AUDITED_TABLES).toContain('transaction_voucher_links')
  })

  it('a correction moving the bank row names the row and both verifikat', () => {
    expect(auditRowToEvent(audit('transactions', tx, { ...tx, journal_entry_id: 'entry-2' }), ctx)).toMatchObject({
      category: 'verifikation',
      code: 'bank_transaction.moved',
      event: 'Bankhändelse flyttad till annat verifikat',
      object: '2026-03-10 Kortköp Kontorsvaror',
      details: ['Verifikat: A12 → A14', 'Belopp: −700,00 SEK'],
      actor: { type: 'user', user_id: 'user-1' },
    })
  })

  it('a storno releasing the bank row names the verifikat it left', () => {
    expect(auditRowToEvent(audit('transactions', tx, { ...tx, journal_entry_id: null, is_business: null }), ctx)).toMatchObject({
      code: 'bank_transaction.released',
      event: 'Bankhändelsens koppling till verifikat borttagen',
      details: ['Verifikat: A12', 'Belopp: −700,00 SEK'],
    })
  })

  it('a moved link and a removed link carry the bank row, the role and the allocated amount', () => {
    expect(auditRowToEvent(audit('transaction_voucher_links', link, { ...link, journal_entry_id: 'entry-2' }), ctx)).toMatchObject({
      category: 'verifikation',
      code: 'bank_link.moved',
      event: 'Bankkoppling flyttad till annat verifikat',
      details: ['Verifikat: A12 → A14', 'Bankhändelse: tx-1', 'Roll: bankrad', 'Belopp: −700,00'],
    })
    expect(auditRowToEvent(audit('transaction_voucher_links', { ...link, role: 'clearing' }, null, 'DELETE'), ctx)).toMatchObject({
      code: 'bank_link.released',
      event: 'Bankkoppling borttagen',
      details: ['Verifikat: A12', 'Bankhändelse: tx-1', 'Roll: clearing', 'Belopp: −700,00'],
    })
  })

  it('renders nothing for a first booking, an insert, or a bank-row delete', () => {
    expect(auditRowToEvent(audit('transactions', { ...tx, journal_entry_id: null }, tx), ctx)).toBeNull()
    expect(auditRowToEvent(audit('transaction_voucher_links', null, link, 'INSERT'), ctx)).toBeNull()
    expect(auditRowToEvent(audit('transactions', tx, null, 'DELETE'), ctx)).toBeNull()
  })
})

describe('auditRowToEvent: skattekonto links and ignores (accounted#50)', () => {
  // What write_audit_log stores for a skattekonto row (the whole row).
  const row = {
    id: 'skv-1',
    company_id: 'company-1',
    transaktionsidentitet: 123,
    dedup_key: '123',
    transaktionsdatum: '2026-03-12',
    transaktionstext: 'Debiterad preliminärskatt',
    belopp_skatteverket: -12345.5,
    status: 'booked',
    journal_entry_id: null,
    suggested_journal_entry_id: 'entry-9',
    is_ignored: false,
  }
  const linked = { ...row, journal_entry_id: 'entry-9', suggested_journal_entry_id: null }
  const entries = new Map([
    ['entry-9', { id: 'entry-9', voucher_series: 'A', voucher_number: 214, source_type: 'import', source_id: null }],
    ['entry-10', { id: 'entry-10', voucher_series: 'S', voucher_number: 3, source_type: 'system', source_id: 'skv-1' }],
  ])
  const ctx = { rattelseMetadataAt: new Map(), entryById: new Map(), linkedEntryById: entries }
  const skv = (old_state: Record<string, unknown> | null, new_state: Record<string, unknown> | null, action: AuditLogEntry['action'] = 'UPDATE') =>
    auditRow({ table_name: 'skattekonto_transactions', record_id: 'skv-1', action, old_state, new_state })

  it('is an audited table', () => {
    expect(AUDITED_TABLES).toContain('skattekonto_transactions')
  })

  it('a link names the event, its amount and the verifikat, as a decision', () => {
    expect(auditRowToEvent(skv(row, linked), ctx)).toMatchObject({
      category: 'beslut',
      code: 'skattekonto.linked',
      event: 'Skattekontohändelse kopplad till verifikat',
      object: '2026-03-12 Debiterad preliminärskatt',
      details: ['Belopp: \u221212\u00a0345,50 kr', 'Verifikat: A214'],
      actor: { type: 'user', user_id: 'user-1' },
    })
  })

  it('a link to the verifikat Bokför created for the row reads as booked', () => {
    const booked = { ...row, journal_entry_id: 'entry-10' }
    expect(auditRowToEvent(skv(row, booked), ctx)).toMatchObject({
      code: 'skattekonto.booked',
      event: 'Skattekontohändelse bokförd',
      details: ['Belopp: \u221212\u00a0345,50 kr', 'Verifikat: S3'],
    })
  })

  it('an unlink names the verifikat it left, and a deleted draft as removed', () => {
    expect(auditRowToEvent(skv(linked, row), ctx)).toMatchObject({
      code: 'skattekonto.unlinked',
      event: 'Skattekontohändelsens koppling borttagen',
      details: ['Belopp: \u221212\u00a0345,50 kr', 'Verifikat: A214'],
    })
    const gone = { ...row, journal_entry_id: 'entry-deleted' }
    expect(auditRowToEvent(skv(gone, row), ctx)?.details).toEqual(['Belopp: \u221212\u00a0345,50 kr', 'Verifikat: borttaget'])
    // Without a lookup the report does not guess.
    expect(auditRowToEvent(skv(gone, row))?.details).toEqual(['Belopp: \u221212\u00a0345,50 kr', 'Verifikat: okänt'])
  })

  it('a link moved from one verifikat to another names both', () => {
    expect(auditRowToEvent(skv(linked, { ...linked, journal_entry_id: 'entry-10' }), ctx)).toMatchObject({
      code: 'skattekonto.relinked',
      details: ['Belopp: \u221212\u00a0345,50 kr', 'Verifikat: A214 → S3'],
    })
  })

  it('ignoring and restoring a row', () => {
    const ignored = { ...row, is_ignored: true, suggested_journal_entry_id: null }
    expect(auditRowToEvent(skv(row, ignored), ctx)).toMatchObject({
      category: 'beslut',
      code: 'skattekonto.ignored',
      event: 'Skattekontohändelse ignorerad',
      details: ['Belopp: \u221212\u00a0345,50 kr'],
    })
    expect(auditRowToEvent(skv(ignored, row), ctx)).toMatchObject({
      code: 'skattekonto.restored',
      event: 'Ignorerad skattekontohändelse återställd',
    })
  })

  it('renders nothing for a change that is neither a link nor an ignore, nor for INSERT or DELETE', () => {
    expect(auditRowToEvent(skv(row, { ...row, suggested_journal_entry_id: null, status: 'upcoming' }), ctx)).toBeNull()
    expect(auditRowToEvent(skv(null, linked, 'INSERT'), ctx)).toBeNull()
    expect(auditRowToEvent(skv(linked, null, 'DELETE'), ctx)).toBeNull()
  })

  it('collapses a burst of ignores by one person into one row', () => {
    const ignores = Array.from({ length: 12 }, (_, i) => auditRowToEvent(auditRow({
      id: `ign-${i}`,
      table_name: 'skattekonto_transactions',
      created_at: `2026-03-10T10:00:${String(i).padStart(2, '0')}.000Z`,
      old_state: { ...row, transaktionstext: `Händelse ${i}` },
      new_state: { ...row, transaktionstext: `Händelse ${i}`, is_ignored: true },
    }), ctx)!)
    const out = collapseBursts(sortEvents(ignores))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ code: 'skattekonto.ignored.bulk', event: 'Skattekontohändelser ignorerade', object: '12 händelser', category: 'beslut', count: 12 })
  })

  it('the report looks up the linked verifikat once, whatever their period, and names them', async () => {
    mockResults = {
      fiscal_periods: [{ data: period }],
      company_settings: [{ data: { company_name: 'T', org_number: null } }],
      journal_entries: [{ data: [{ id: 'entry-old', voucher_series: 'B', voucher_number: 7, source_type: 'manual', source_id: null }] }],
    }
    rpcResults = {
      behandlingshistorik_sources: ledger({
        audit: [auditRow({
          id: 'skv-a',
          table_name: 'skattekonto_transactions',
          record_id: 'skv-1',
          created_at: '2026-04-01T08:00:00.000Z',
          old_state: row,
          new_state: { ...row, journal_entry_id: 'entry-old' },
        })],
      }),
    }
    const client = makeClient()
    const report = await generateBehandlingshistorik(client, 'company-1', { periodId: 'period-1' })

    expect(client.from.mock.calls.filter(([t]: [string]) => t === 'journal_entries')).toHaveLength(1)
    const event = report!.events.find((e) => e.id === 'audit:skv-a')
    expect(event).toMatchObject({ code: 'skattekonto.linked', details: ['Belopp: \u221212\u00a0345,50 kr', 'Verifikat: B7'] })
    expect(report!.by_category.beslut).toBe(1)
  })
})

describe('decisionEvents', () => {
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
  const assistant = { ...rule, source: 'assistant', source_id: 'assistant:tx-1', rank: 1, confidence: 0.64, model: 'claude-x', matches_final: false }
  const row = (overrides: Partial<SuggestionLogRow> = {}): SuggestionLogRow => ({
    id: 'sl-1',
    kind: 'bank_line',
    transaction_id: 'tx-1',
    inbox_item_id: null,
    document_id: null,
    suggestions: [rule, assistant],
    acted_on: 0,
    final: { journal_entry_id: 'entry-1', booking: null, account: '5410', vat_treatment: 'standard_25', lines: [] },
    outcome: 'accepted',
    actor_type: 'api_key',
    resolved_by: 'user-1',
    created_at: '2026-03-10T09:30:01.000Z',
    ...overrides,
  })
  const op = {
    id: 'op-1', operation_type: 'categorize_transaction', actor_type: 'mcp_oauth', actor_id: 'key-1', actor_label: 'Claude', risk_level: 'low',
    agent_metadata: null, created_at: '2026-03-10T09:29:00.000Z', resolved_at: '2026-03-10T09:30:02.000Z', journal_entry_id: 'entry-1', registration_journal_entry_id: null,
  }
  const ctx = {
    entries: new Map([['entry-1', { id: 'entry-1', voucher_series: 'A', voucher_number: 12, status: 'posted', committed_actor_label: 'Claude', commit_method: 'agent' }]]),
    operations: new Map([['entry-1', op]]),
  }

  it('one decision: what was on offer, what was taken on what basis, what was booked and who proposed it', () => {
    const [ev] = decisionEvents(buildDecisionReceipts([row({ actor_type: 'mcp_oauth' })], ctx))
    expect(ev).toMatchObject({
      id: 'decision:sl-1',
      category: 'beslut',
      code: 'decision.accepted',
      event: 'Förslag följt',
      object: 'A12',
      actor: { type: 'mcp_oauth', user_id: 'user-1', actor_label: 'Claude' },
      source: 'suggestion_log',
      count: 1,
    })
    expect(ev.details).toEqual([
      'Gäller: banktransaktion',
      'Förslag: 2 (regel, assistenten)',
      'Valt förslag: regel, konto 5410',
      'Säkerhet: 92 %',
      'Bokfört konto: 5410',
      'Föreslaget av: Claude',
    ])
  })

  it("quotes the agent's reason, as the approver saw it, after who proposed it; nothing when none was given", () => {
    const reason = 'Clas Ohlson every month on 5410; the receipt is attached.'
    const [ev] = decisionEvents(buildDecisionReceipts([row({ actor_type: 'mcp_oauth', agent_reason: reason })], ctx))
    expect(ev.details.slice(-2)).toEqual(['Föreslaget av: Claude', `Agentens motivering: ${reason}`])
    const [plain] = decisionEvents(buildDecisionReceipts([row({ actor_type: 'mcp_oauth', agent_reason: null })], ctx))
    expect(plain.details.some((d) => d.startsWith('Agentens motivering'))).toBe(false)
  })

  it('keeps the reason on a samlingsbeslut: one approval, one staged operation', () => {
    const reason = 'Twelve card lines from the same Stripe payout.'
    const events = decisionEvents(buildDecisionReceipts([
      row({ id: 'sl-a', actor_type: 'mcp_oauth', agent_reason: reason }),
      row({ id: 'sl-b', transaction_id: 'tx-2', actor_type: 'mcp_oauth', agent_reason: reason }),
    ], ctx))
    expect(events).toHaveLength(1)
    expect(events[0].code).toBe('decision.batch')
    expect(events[0].details).toContain(`Agentens motivering: ${reason}`)
  })

  it("says so when an underlag's score is the model's own and names the changed fields", () => {
    const [ev] = decisionEvents(buildDecisionReceipts([row({
      kind: 'inbox_item',
      transaction_id: null,
      suggestions: [{ source: 'extraction', source_id: 'doc-1', rank: 0, proposal: { fields: { total: 100 } }, confidence: 0.9, model: 'reader-1', prompt_sha256: null, matches_final: false }],
      outcome: 'changed',
      final: { supplier_invoice_id: 'si-1', journal_entry_id: null, fields: { total: 120 }, lines: [], changed_fields: ['total', 'due_date'] },
    })], { entries: new Map(), operations: new Map() }))
    expect(ev).toMatchObject({ code: 'decision.changed', event: 'Förslag ändrat före bokföring', object: 'Underlag' })
    expect(ev.details).toEqual([
      'Förslag: 1 (dokumentläsning)',
      'Valt förslag: dokumentläsning',
      'Modellens egen säkerhet: 90 %',
      'Modell: reader-1',
      'Ändrade fält: belopp, förfallodatum',
    ])
  })

  it('an ignored bank line and a booking with nothing on offer', () => {
    const events = decisionEvents(buildDecisionReceipts([
      row({ id: 'sl-2', suggestions: [], acted_on: null, outcome: 'dismissed', final: null, actor_type: 'user' }),
      row({ id: 'sl-3', suggestions: [], acted_on: null, outcome: 'manual', final: { journal_entry_id: 'entry-9', booking: null, account: null, vat_treatment: null, lines: [] }, actor_type: 'user' }),
    ], { entries: new Map(), operations: new Map() }))
    const byId = Object.fromEntries(events.map((e) => [e.id, e]))
    expect(byId['decision:sl-2']).toMatchObject({ event: 'Banktransaktion ignorerad', object: 'Banktransaktion', details: ['Inga förslag fanns'] })
    // The voucher is outside the year this context knows: the subject stands in for its number.
    expect(byId['decision:sl-3']).toMatchObject({ event: 'Bokfört utan förslag', object: 'Banktransaktion', details: ['Inga förslag fanns'] })
  })

  it('names the rules, policy and band it was decided under, and every guard that did not simply pass', () => {
    const [ev] = decisionEvents(buildDecisionReceipts([row({
      actor_type: 'user',
      rule_version: 'bank-proposals.1+a38016f12abc',
      policy_version: 'direct-booking.1;assistant_sure=0.8;counterpart_seen=3;calibrator=none',
      input_hash: 'a'.repeat(64),
      confidence_band: 'review',
      checks: [
        { id: 'already_booked', result: 'pass', detail: null },
        { id: 'duplicate', result: 'warn', detail: 'force:journal_entry:je-0' },
        { id: 'period_lock', result: 'pass', detail: null },
      ],
    })], { entries: new Map(), operations: new Map() }))
    expect(ev.details).toEqual([
      'Förslag: 2 (regel, assistenten)',
      'Valt förslag: regel, konto 5410',
      'Säkerhet: 92 %',
      'Bokfört konto: 5410',
      'Regelversion: bank-proposals.1+a38016f12abc',
      'Policy: direct-booking.1;assistant_sure=0.8;counterpart_seen=3;calibrator=none, bedömning: krävde granskning',
      'Kontroller: 3',
      'Kontroll med varning: dubblettkontroll (force:journal_entry:je-0)',
    ])
  })

  it('a samlingsverifikat is one event carrying its count', () => {
    const events = decisionEvents(buildDecisionReceipts([
      row({ id: 'sl-a', created_at: '2026-03-10T09:30:01.000Z' }),
      row({ id: 'sl-b', created_at: '2026-03-10T09:30:01.000Z', acted_on: null, outcome: 'manual' }),
      row({ id: 'sl-c', created_at: '2026-03-10T09:30:01.000Z' }),
    ], ctx))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      id: 'decision:sl-a:batch',
      code: 'decision.batch',
      event: 'Samlingsbeslut',
      object: 'A12',
      count: 3,
      details: ['3 banktransaktioner i en verifikation', 'Förslag följt: 2', 'Bokfört utan förslag: 1', 'Föreslaget av: Claude'],
    })
  })

  it('an approved staged operation: the agentförslag, who staged it and the approval policy', () => {
    const staged = { ...op, id: 'op-7', operation_type: 'create_voucher', actor_type: 'service_account', actor_label: 'Attestharness', risk_level: 'medium', agent_metadata: { model: 'claude-x' } }
    const [ev] = decisionEvents(buildDecisionReceipts([row({
      id: 'sl-op',
      kind: 'operation',
      transaction_id: null,
      pending_operation_id: 'op-7',
      suggestions: [{ source: 'pending_operation', source_id: 'op-7', rank: 0, proposal: { operation_type: 'create_voucher', risk_level: 'medium' }, confidence: null, model: 'claude-x', prompt_sha256: null, matches_final: true }],
      final: { journal_entry_id: 'entry-1', operation_type: 'create_voucher', journal_entry_ids: ['entry-1'] },
      actor_type: 'user',
      policy_version: 'staged-approval.1;approver=person',
      confidence_band: 'review',
      input_hash: 'b'.repeat(64),
    })], { ...ctx, operationsById: new Map([['op-7', staged]]) }))
    expect(ev).toMatchObject({
      id: 'decision:sl-op',
      code: 'decision.accepted',
      event: 'Agentförslag godkänt',
      object: 'A12',
      actor: { type: 'user', user_id: 'user-1' },
    })
    expect(ev.details).toEqual([
      'Gäller: agentförslag',
      'Förslag: 1 (agentförslag)',
      'Valt förslag: agentförslag',
      'Modell: claude-x',
      'Föreslaget av: Tjänstekontot Attestharness',
      'Policy: staged-approval.1;approver=person, bedömning: krävde granskning',
    ])
  })

  it('a posting a company grant let through: booked automatically under the rule, named with its version', () => {
    const grantId = '55555555-5555-4555-8555-555555555555'
    const staged = { ...op, id: 'op-8', operation_type: 'categorize_transaction', actor_type: 'api_key', actor_label: 'Claude' }
    const [ev] = decisionEvents(buildDecisionReceipts([row({
      id: 'sl-grant',
      kind: 'operation',
      transaction_id: null,
      pending_operation_id: 'op-8',
      suggestions: [{ source: 'pending_operation', source_id: 'op-8', rank: 0, proposal: { operation_type: 'categorize_transaction', risk_level: 'medium' }, confidence: null, model: null, prompt_sha256: null, matches_final: true }],
      final: { journal_entry_id: 'entry-1', operation_type: 'categorize_transaction', journal_entry_ids: ['entry-1'] },
      actor_type: 'api_key',
      policy_version: `grant.1;grant_id=${grantId};grant_version=2`,
      confidence_band: 'direct',
    })], { ...ctx, operationsById: new Map([['op-8', staged]]) }))
    expect(ev).toMatchObject({ event: 'Bokfört automatiskt enligt regel', object: 'A12', actor: { type: 'api_key' } })
    expect(ev.details).toContain(`Bokfört utan godkännande av en person, enligt regel ${grantId} version 2`)
    expect(ev.details).toContain(`Policy: grant.1;grant_id=${grantId};grant_version=2, bedömning: kunde bokföras direkt`)
  })

  // Customer request 2026-11-05: the history tells a person's approval in
  // the chat client from one the AI made itself.
  const mcpApprovalRow = (policy: string, band: 'direct' | 'review') =>
    row({
      id: 'sl-mcp',
      kind: 'operation',
      transaction_id: null,
      pending_operation_id: 'op-9',
      suggestions: [{ source: 'pending_operation', source_id: 'op-9', rank: 0, proposal: { operation_type: 'categorize_transaction', risk_level: 'low' }, confidence: null, model: null, prompt_sha256: null, matches_final: true }],
      final: { journal_entry_id: 'entry-1', operation_type: 'categorize_transaction', journal_entry_ids: ['entry-1'] },
      actor_type: 'mcp_oauth',
      policy_version: policy,
      confidence_band: band,
    })
  const mcpCtx = { ...ctx, operationsById: new Map([['op-9', { ...op, id: 'op-9' }]]) }

  it("a click in the approval view: the person's approval, the client named and its word marked as such", () => {
    const [ev] = decisionEvents(buildDecisionReceipts([
      mcpApprovalRow('staged-approval.1;approver=person_in_client;unattended_limit=none;door=mcp_view', 'review'),
    ], mcpCtx))
    expect(ev).toMatchObject({
      event: 'Agentförslag godkänt i granskningsrutan',
      actor: { type: 'user', user_id: 'user-1', actor_label: null },
    })
    expect(ev.details).toContain(
      'Godkännande: en person klickade Godkänn i granskningsrutan i Claude (intygat av klienten, inte en inloggning i Accounted)',
    )
    expect(ev.details).toContain(
      'Policy: staged-approval.1;approver=person_in_client;unattended_limit=none;door=mcp_view, bedömning: krävde granskning',
    )
  })

  it('an approval the AI made itself: the AI named, and what the history cannot know said plainly', () => {
    const [ev] = decisionEvents(buildDecisionReceipts([
      mcpApprovalRow('staged-approval.1;approver=credential;unattended_limit=none;door=mcp_chat', 'direct'),
    ], mcpCtx))
    expect(ev).toMatchObject({
      event: 'Agentförslag godkänt av AI-assistenten',
      actor: { type: 'mcp_oauth', user_id: 'user-1', actor_label: 'Claude' },
    })
    expect(ev.details).toContain(
      'Godkännande: AI-assistenten (Claude) godkände förslaget själv; om en person bad om det i chatten syns inte i Accounted',
    )
  })

  it('an MCP approval recorded before the door reads as before', () => {
    const [ev] = decisionEvents(buildDecisionReceipts([
      mcpApprovalRow('staged-approval.1;approver=credential;unattended_limit=none', 'direct'),
    ], mcpCtx))
    expect(ev.event).toBe('Agentförslag godkänt')
    expect(ev.details.some((d) => d.startsWith('Godkännande:'))).toBe(false)
  })

  it('a samlingsverifikat names the rules version its decisions share', () => {
    const shared = { created_at: '2026-03-10T09:30:01.000Z', rule_version: 'bank-proposals.1+a38016f12abc' }
    const [ev] = decisionEvents(buildDecisionReceipts([row({ id: 'sl-a', ...shared }), row({ id: 'sl-b', ...shared })], ctx))
    expect(ev.details).toContain('Regelversion: bank-proposals.1+a38016f12abc')
  })
})

describe('generateBehandlingshistorik: Beslut och förslag', () => {
  it("reads decisions in the window and those that booked the year's vouchers, labelled from the voucher it already holds", async () => {
    const decision = {
      id: 'sl-1', kind: 'bank_line', transaction_id: 'tx-1', inbox_item_id: null, document_id: null,
      suggestions: [], acted_on: null, final: { journal_entry_id: 'entry-1', booking: null, account: '5410', vat_treatment: null, lines: [] },
      outcome: 'manual', actor_type: 'user', resolved_by: 'user-1', created_at: '2026-03-10T09:30:01.000Z',
    }
    // Booked in January for the year before: outside the window, inside the year.
    const late = { ...decision, id: 'sl-2', created_at: '2027-01-12T08:00:00.000Z' }
    mockResults = {
      fiscal_periods: [{ data: period }],
      company_settings: [{ data: { company_name: 'T', org_number: null } }],
      company_migration_resets: [{ data: [] }],
      app_releases: [{ data: [] }],
      sie_imports: [{ data: [] }],
      bank_file_imports: [{ data: [] }],
    }
    rpcResults = {
      behandlingshistorik_sources: ledger({ entries: [baseEntry] }),
      // Both rows (the window's and the one that booked one of the year's
      // vouchers in January), with the voucher their receipts name.
      behandlingshistorik_decisions: {
        data: [{
          rows: [decision, late],
          entries: [{ id: 'entry-1', voucher_series: 'A', voucher_number: 12, status: 'posted', committed_actor_type: null, committed_actor_label: null, commit_method: 'user_accept' }],
          operations: [],
          legacy_by_entry: [],
          legacy_by_registration: [],
        }],
        error: null,
      },
    }
    const client = makeClient()
    const report = await generateBehandlingshistorik(client, 'company-1', { periodId: 'period-1' }, {
      resolveUserLabels: vi.fn().mockResolvedValue(new Map([['user-1', 'anna@example.se']])),
    })
    const decisions = report!.events.filter((e) => e.category === 'beslut')
    expect(decisions.map((e) => e.id)).toEqual(['decision:sl-1', 'decision:sl-2'])
    expect(decisions[0]).toMatchObject({ object: 'A12', event: 'Bokfört utan förslag', actor: { type: 'user', label: 'anna@example.se' } })
    expect(report!.by_category.beslut).toBe(2)
    // The rows and what their receipts read arrive together: no table reads.
    for (const table of ['journal_entries', 'suggestion_log', 'pending_operations']) {
      expect(client.from).not.toHaveBeenCalledWith(table)
    }
  })

  it('names the person an agent proposal was staged for, read by operation id for agent proposals only', async () => {
    const approved = {
      id: 'sl-op', kind: 'operation', transaction_id: null, inbox_item_id: null, document_id: null, pending_operation_id: 'op-7',
      suggestions: [{ source: 'pending_operation', source_id: 'op-7', rank: 0, proposal: { operation_type: 'create_voucher', risk_level: 'low' }, confidence: null, model: null, prompt_sha256: null, matches_final: true }],
      acted_on: 0, final: { journal_entry_id: 'entry-1', operation_type: 'create_voucher', journal_entry_ids: ['entry-1'] },
      outcome: 'accepted', actor_type: 'user', resolved_by: 'user-1', created_at: '2026-03-10T09:30:01.000Z',
    }
    const staged = {
      id: 'op-7', operation_type: 'create_voucher', actor_type: 'api_key', actor_id: 'key-1', actor_label: 'Claude (Anthropic)', risk_level: 'low',
      agent_metadata: null, created_at: '2026-03-10T09:29:00.000Z', resolved_at: '2026-03-10T09:30:02.000Z', journal_entry_id: 'entry-1', registration_journal_entry_id: null,
    }
    mockResults = {
      fiscal_periods: [{ data: period }],
      company_settings: [{ data: { company_name: 'T', org_number: null } }],
      // The decisions statement does not return the operation's user: one read by id.
      pending_operations: [{ data: [{ id: 'op-7', user_id: 'user-3' }] }],
    }
    rpcResults = {
      behandlingshistorik_sources: ledger({ entries: [baseEntry] }),
      behandlingshistorik_decisions: {
        data: [{
          rows: [approved],
          entries: [{ id: 'entry-1', voucher_series: 'A', voucher_number: 12, status: 'posted', committed_actor_type: 'user', committed_actor_label: null, commit_method: 'user_accept' }],
          operations: [staged],
          legacy_by_entry: [],
          legacy_by_registration: [],
        }],
        error: null,
      },
    }
    const resolve = vi.fn().mockResolvedValue(new Map([['user-1', 'anna@example.se'], ['user-3', 'kim@example.se']]))
    const client = makeClient()
    const report = await generateBehandlingshistorik(client, 'company-1', { periodId: 'period-1' }, { resolveUserLabels: resolve })
    const [decision] = report!.events.filter((e) => e.category === 'beslut')
    expect(decision.actor.label).toBe('anna@example.se')
    expect(decision.details).toContain('Föreslaget av: Claude åt kim@example.se')
    expect(client.from).toHaveBeenCalledWith('pending_operations')
    const read = client.from.mock.results[client.from.mock.calls.findIndex((c: unknown[]) => c[0] === 'pending_operations')].value
    expect(read.select).toHaveBeenCalledWith('id, user_id')
    expect(read.in).toHaveBeenCalledWith('id', ['op-7'])
    // The sponsors' names are not asked for twice.
    expect(resolve.mock.calls.flatMap((c: unknown[]) => c[0] as string[]).filter((id: string) => id === 'user-3')).toHaveLength(1)
  })

  it('lists no decision when the year has none', async () => {
    mockResults = {
      fiscal_periods: [{ data: period }],
      company_settings: [{ data: { company_name: 'T', org_number: null } }],
    }
    const client = makeClient()
    const report = await generateBehandlingshistorik(client, 'company-1', { periodId: 'period-1' })
    expect(report!.by_category.beslut).toBe(0)
    expect(client.from).not.toHaveBeenCalledWith('pending_operations')
  })
})

describe('auditRowToEvent: pågående arbeten, method and account (accounted#111)', () => {
  // What write_audit_log stores for a contract_revenue_settings row.
  const settings = {
    id: 'crs-1',
    company_id: 'company-1',
    user_id: 'user-1',
    method: 'successiv',
    revenue_account: '3095',
    created_at: '2026-03-10T09:00:00.000Z',
    updated_at: '2026-03-10T09:00:00.000Z',
  }
  const row = (action: AuditLogEntry['action'], old_state: Record<string, unknown> | null, new_state: Record<string, unknown> | null) =>
    auditRow({ table_name: 'contract_revenue_settings', record_id: 'crs-1', action, old_state, new_state })

  it('is an audited table', () => {
    expect(AUDITED_TABLES).toContain('contract_revenue_settings')
  })

  it('states the method and account when chosen', () => {
    expect(auditRowToEvent(row('INSERT', null, settings))).toMatchObject({
      category: 'installningar',
      code: 'contract_revenue_settings.created',
      event: 'Metod och konto för pågående arbeten valda',
      object: 'Pågående arbeten',
      details: ['Metod: Successiv vinstavräkning', 'Konto för upparbetade intäkter: 3095'],
    })
  })

  it('shows a change of method or account, and nothing for a save that changed neither', () => {
    const changed = { ...settings, method: 'fardigstallande', revenue_account: '3096' }
    expect(auditRowToEvent(row('UPDATE', settings, changed))).toMatchObject({
      code: 'contract_revenue_settings.updated',
      details: [
        'Metod: Successiv vinstavräkning → Färdigställandemetoden',
        'Konto för upparbetade intäkter: 3095 → 3096',
      ],
    })
    expect(auditRowToEvent(row('UPDATE', settings, { ...settings, updated_at: '2026-03-11T09:00:00.000Z' }))).toBeNull()
  })

  it('states what was removed', () => {
    expect(auditRowToEvent(row('DELETE', settings, null))).toMatchObject({
      code: 'contract_revenue_settings.deleted',
      event: 'Pågående arbeten används inte längre',
      details: ['Metod: Successiv vinstavräkning', 'Konto för upparbetade intäkter: 3095'],
    })
  })
})
