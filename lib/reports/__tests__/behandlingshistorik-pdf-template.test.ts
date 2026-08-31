import { describe, it, expect } from 'vitest'
import { renderToBuffer } from '@react-pdf/renderer'
import { BehandlingshistorikPDF, pdfText } from '../behandlingshistorik-pdf-template'
import type { BehandlingshistorikEvent, BehandlingshistorikReport } from '../behandlingshistorik-types'

// Real @react-pdf/renderer layout is CPU-heavy; give it room on a saturated runner.
const RENDER_TIMEOUT = 30_000

function event(overrides: Partial<BehandlingshistorikEvent>): BehandlingshistorikEvent {
  return {
    id: `ev-${Math.random().toString(36).slice(2, 8)}`,
    occurred_at: '2026-03-10T09:30:00.000Z',
    category: 'verifikation',
    code: 'journal_entry.committed',
    event: 'Verifikation bokförd',
    object: 'A12',
    actor: { type: 'user', user_id: 'user-1', label: 'anna@example.se' },
    details: ['Datum: 2026-03-09', 'Text: Hyra mars', 'Källa: Manuell'],
    source: 'journal_entries',
    count: 1,
    ...overrides,
  }
}

function report(overrides: Partial<BehandlingshistorikReport> = {}): BehandlingshistorikReport {
  const events = overrides.events ?? [
    event({ id: 'a1', category: 'kontoplan', code: 'account.created.bulk', event: 'Kontoplan upplagd', object: '41 konton', details: ['Konton 1510 till 8410'], source: 'audit_log', count: 41, occurred_at: '2026-01-05T08:00:00.000Z' }),
    event({ id: 'a2', category: 'installningar', code: 'settings.updated', event: 'Företagsinställningar ändrade', object: null, details: ['Momsperiod: Kvartal → Helår'], source: 'audit_log', occurred_at: '2026-02-01T08:00:00.000Z' }),
    event({ id: 'e1' }),
    event({ id: 'e2', object: 'A13', code: 'journal_entry.reversed', event: 'Verifikation makulerad (storno)', actor: { type: 'api_key', user_id: null, label: 'API-nyckel: Revisorn' }, occurred_at: '2026-04-02T10:00:00.000Z' }),
  ]
  const by_category = { verifikation: 0, kontoplan: 0, installningar: 0, period: 0, import: 0, atkomst: 0, ovrigt: 0 }
  for (const e of events) by_category[e.category] += 1
  return {
    company: { name: 'Testbolaget AB', org_number: '5566778899' },
    period: { id: 'p', name: 'Räkenskapsår 2026', start: '2026-01-01', end: '2026-12-31' },
    range: { from: '2026-01-01', to: '2026-12-31' },
    mode: 'fiscal_year',
    generated_at: '2026-08-21T12:00:00.000Z',
    app_version: 'abc123def456',
    total_events: events.length,
    by_category,
    events,
    category_filter: null,
    ...overrides,
  }
}

describe('pdfText', () => {
  it('maps glyphs the bundled Helvetica lacks to ASCII', () => {
    expect(pdfText('Momsperiod: Kvartal → Helår')).toBe('Momsperiod: Kvartal -> Helår')
    expect(pdfText('−1 200,00')).toBe('-1 200,00')
    expect(pdfText('åäö ÅÄÖ … ·')).toBe('åäö ÅÄÖ … ·')
  })
})

describe('BehandlingshistorikPDF', () => {
  it(
    'renders a valid PDF with both sections',
    async () => {
      const buffer = await renderToBuffer(BehandlingshistorikPDF({ report: report() }))
      expect(buffer).toBeInstanceOf(Buffer)
      expect(buffer.slice(0, 5).toString()).toBe('%PDF-')
      expect(buffer.length).toBeGreaterThan(1000)
    },
    RENDER_TIMEOUT,
  )

  it(
    'renders an empty report (both sections show the empty line) and a category-filtered date range',
    async () => {
      const empty = await renderToBuffer(
        BehandlingshistorikPDF({
          report: report({ events: [], total_events: 0, by_category: { verifikation: 0, kontoplan: 0, installningar: 0, period: 0, import: 0, atkomst: 0, ovrigt: 0 } }),
        }),
      )
      expect(empty.slice(0, 5).toString()).toBe('%PDF-')

      const filtered = await renderToBuffer(
        BehandlingshistorikPDF({
          report: report({ mode: 'date_range', range: { from: '2026-03-01', to: '2026-03-31' }, category_filter: ['verifikation'], app_version: null }),
        }),
      )
      expect(filtered.slice(0, 5).toString()).toBe('%PDF-')
    },
    RENDER_TIMEOUT,
  )

  it(
    'paginates a long report without splitting rows (no break props: must not hang)',
    async () => {
      const events = Array.from({ length: 220 }, (_, i) =>
        event({
          id: `e${i}`,
          object: `A${i + 1}`,
          occurred_at: new Date(Date.parse('2026-01-01T08:00:00.000Z') + i * 3_600_000).toISOString(),
          details: ['Datum: 2026-01-01', `Text: Rad ${i} med en ganska lång beskrivning som ska radbrytas i detaljkolumnen`, 'Källa: Banktransaktion'],
        }),
      )
      const buffer = await renderToBuffer(BehandlingshistorikPDF({ report: report({ events, total_events: events.length }) }))
      expect(buffer.slice(0, 5).toString()).toBe('%PDF-')
      // A 220-row landscape table is several pages; /Type /Page objects prove pagination happened.
      const pages = (buffer.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length
      expect(pages).toBeGreaterThan(3)
    },
    RENDER_TIMEOUT,
  )
})
