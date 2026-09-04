import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { AuditLogEntry } from '@/types'
import {
  AUDITED_TABLES,
  AUDIT_ROW_FILTER,
  GLOBAL_ACTIONS,
  appReleaseEvent,
  appReleaseEvents,
  auditRowToEvent,
  buildBehandlingshistorikExport,
  collapseBursts,
  commitEventFromEntry,
  diffFields,
  formatActorLabel,
  formatStockholmTimestamp,
  generateBehandlingshistorik,
  rattelseEvent,
  sortEvents,
  type RawBehandlingshistorikEvent,
} from '../behandlingshistorik'

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
// audit_log row filter: the literal in the query must track the constants
// ============================================================

describe('AUDIT_ROW_FILTER', () => {
  it('is built from AUDITED_TABLES and GLOBAL_ACTIONS', () => {
    expect(AUDIT_ROW_FILTER).toBe(
      `table_name.in.(${AUDITED_TABLES.join(',')}),action.in.(${GLOBAL_ACTIONS.join(',')})`,
    )
  })

  it('is the exact literal used in the audit_log query (schema guard needs a literal there)', () => {
    const source = readFileSync(path.join(__dirname, '..', 'behandlingshistorik.ts'), 'utf-8')
    expect(source).toContain(`.or(\n        '${AUDIT_ROW_FILTER}',\n      )`)
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
      'Källa: Manuell',
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

  it('marks storno and rättelse vouchers', () => {
    const storno = commitEventFromEntry({ ...baseEntry, reverses_id: 'x', source_type: 'storno' })!
    expect(storno.details).toContain('Vändningsverifikation (storno)')
    const corr = commitEventFromEntry({ ...baseEntry, correction_of_id: 'x', source_type: 'correction' })!
    expect(corr.details).toContain('Rättelseverifikation')
  })
})

// ============================================================
// auditRowToEvent
// ============================================================

describe('auditRowToEvent: journal_entries', () => {
  it('ignores COMMIT rows (the bokföringspost comes from journal_entries)', () => {
    expect(auditRowToEvent(auditRow({ action: 'COMMIT', new_state: { status: 'posted' } }))).toBeNull()
  })

  it('emits REVERSE as makulerad with the voucher label', () => {
    const ev = auditRowToEvent(
      auditRow({ action: 'REVERSE', old_state: { voucher_series: 'A', voucher_number: 5, status: 'posted' }, new_state: { voucher_series: 'A', voucher_number: 5, status: 'reversed' } }),
    )!
    expect(ev).toMatchObject({ code: 'journal_entry.reversed', object: 'A5', category: 'verifikation' })
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
    expect(formatActorLabel({ type: 'api_key', user_id: 'user-1', actor_label: 'Zapier' }, labels)).toBe('API-nyckel: Zapier')
    expect(formatActorLabel({ type: 'mcp_oauth', user_id: null, actor_label: null }, labels)).toBe('MCP-anslutning')
    expect(formatActorLabel({ type: 'agent_chat', user_id: 'user-1', actor_label: null }, labels)).toBe('Assistenten, på uppdrag av anna@example.se')
    expect(formatActorLabel({ type: 'cron', user_id: null, actor_label: null }, labels)).toBe('Schemalagd körning')
    expect(formatActorLabel({ type: 'system', user_id: null, actor_label: 'seed' }, labels)).toBe('Systemet: seed')
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { from: vi.fn().mockImplementation((table: string) => makeBuilder(table)) } as any
}

const period = { id: 'period-1', name: 'RÅ 2026', period_start: '2026-01-01', period_end: '2026-12-31' }

beforeEach(() => {
  mockResults = {}
})

describe('generateBehandlingshistorik', () => {
  it('returns null when the period does not belong to the company', async () => {
    mockResults = { fiscal_periods: [{ data: null }] }
    const report = await generateBehandlingshistorik(makeClient(), 'company-1', { periodId: 'nope' })
    expect(report).toBeNull()
  })

  it('assembles, sorts and labels events from every source in fiscal-year mode', async () => {
    const bokslut = { ...baseEntry, id: 'entry-2', voucher_number: 40, entry_date: '2026-12-31', committed_at: '2027-02-15T12:00:00.000Z', source_type: 'year_end', description: 'Bokslut' }
    mockResults = {
      fiscal_periods: [{ data: period }],
      company_settings: [{ data: { company_name: 'Testbolaget AB', org_number: '556000-0001' } }],
      journal_entries: [{ data: [baseEntry, bokslut, { ...baseEntry, id: 'draft', status: 'draft', committed_at: null, voucher_number: null }] }],
      audit_log: [
        // windowed
        {
          data: [
            auditRow({ id: 'a1', table_name: 'company_settings', action: 'UPDATE', created_at: '2026-02-01T08:00:00.000Z', old_state: { moms_period: 'quarterly' }, new_state: { moms_period: 'monthly' } }),
            auditRow({ id: 'a2', table_name: 'chart_of_accounts', action: 'INSERT', created_at: '2026-02-02T08:00:00.000Z', new_state: { account_number: '6540', account_name: 'IT' } }),
          ],
        },
        // record-id union (bokslut storno logged after period end)
        {
          data: [
            auditRow({ id: 'a3', record_id: 'entry-2', action: 'REVERSE', created_at: '2027-03-01T09:00:00.000Z', old_state: { voucher_series: 'A', voucher_number: 40, status: 'posted' }, new_state: { voucher_series: 'A', voucher_number: 40, status: 'reversed' }, actor_type: 'api_key', actor_label: 'Revisorn' }),
          ],
        },
      ],
      journal_entry_rattelse_log: [{ data: [] }, { data: [] }],
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

    const report = await generateBehandlingshistorik(makeClient(), 'company-1', { periodId: 'period-1' }, {
      resolveUserLabels: resolve,
      appVersion: 'abc1234',
      now: new Date('2026-08-21T12:00:00.000Z'),
    })

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
    // Labels resolved through the injected resolver, machine actors kept.
    expect(resolve).toHaveBeenCalledWith(expect.arrayContaining(['user-1', 'user-3']))
    const byCode = Object.fromEntries(report!.events.map((e) => [e.id, e]))
    expect(byCode['entry:entry-1'].actor.label).toBe('anna@example.se')
    expect(byCode['sie:s1'].actor.label).toBe('kim@example.se')
    expect(byCode['audit:a3'].actor.label).toBe('API-nyckel: Revisorn')
    // The sie import outside the window is not included.
    expect(byCode['sie:s0']).toBeUndefined()
  })

  it('date-range mode keeps only what was registered inside the window and filters categories', async () => {
    mockResults = {
      fiscal_periods: [{ data: period }],
      company_settings: [{ data: { company_name: 'T', org_number: null } }],
      journal_entries: [{ data: [baseEntry, { ...baseEntry, id: 'entry-2', voucher_number: 13, committed_at: '2026-05-02T10:00:00.000Z' }] }],
      audit_log: [
        { data: [auditRow({ id: 'a1', table_name: 'chart_of_accounts', action: 'DELETE', created_at: '2026-03-15T08:00:00.000Z', old_state: { account_number: '6540', account_name: 'IT' } })] },
      ],
      journal_entry_rattelse_log: [{ data: [] }],
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
    // No record-id union in date-range mode: audit_log queried once.
    expect(client.from.mock.calls.filter((c: string[]) => c[0] === 'audit_log')).toHaveLength(1)
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
    by_category: { verifikation: 1, kontoplan: 0, installningar: 0, period: 0, import: 0, atkomst: 0, ovrigt: 0 },
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

  it('csv carries a BOM, the header row and Swedish local time', () => {
    const out = buildBehandlingshistorikExport(report, 'csv')
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

  it('xlsx is a non-empty workbook with the xlsx mime type', () => {
    const out = buildBehandlingshistorikExport(report, 'xlsx')
    expect(out.contentType).toContain('spreadsheetml')
    expect(out.filename.endsWith('.xlsx')).toBe(true)
    expect(out.buffer.length).toBeGreaterThan(100)
  })
})

// ============================================================
// Behandlingsregler and program versions (BFNAR 2013:2 p. 9.16, 2nd paragraph)
// ============================================================

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
