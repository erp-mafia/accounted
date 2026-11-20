/**
 * The mall editor offers kostnadsställe and projekt on its cost/revenue lines
 * when the company has dimensions switched on, and nowhere else.
 */
import { describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { renderInLocale as render } from '@/tests/i18n-render'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import type { BookingTemplateLibrary, BookingTemplateLibraryLine } from '@/types'

const company = vi.hoisted(() => ({ settings: { dimensions_enabled: true } }))

vi.mock('@/lib/reference-data/hooks', () => ({
  useCompanySettings: () => company,
  // An empty registry: the pickers fall back to the seeded pair, 1 and 6.
  useDimensions: () => ({ dimensions: [] }),
}))
vi.mock('@/components/bookkeeping/VoucherLinesTable', () => ({ VoucherLinesTable: () => null }))
vi.mock('@/components/ui/info-tooltip', () => ({
  InfoTooltip: ({ content }: { content: ReactNode }) => createElement('span', null, content),
}))

import { TemplateForm } from '../TemplateForm'

const HELP_SV = sv.settings_booking_templates.line_dimensions_help
const HELP_EN = en.settings_booking_templates.line_dimensions_help

function template(lines: BookingTemplateLibraryLine[]): BookingTemplateLibrary {
  return {
    id: 'tpl-1',
    company_id: 'company-1',
    team_id: null,
    created_by: 'user-1',
    name: 'Förbrukning',
    description: '',
    category: 'other',
    entity_type: 'all',
    lines,
    is_system: false,
    is_active: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }
}

const cost: BookingTemplateLibraryLine = { account: '5410', label: 'Förbrukning', side: 'debit', type: 'business', ratio: 0.5 }
const vat: BookingTemplateLibraryLine = { account: '2641', label: 'Ingående moms', side: 'debit', type: 'vat', vat_rate: 0.25 }
const bank: BookingTemplateLibraryLine = { account: '1930', label: 'Bank', side: 'credit', type: 'settlement', ratio: 1 }

function form(
  lines: BookingTemplateLibraryLine[],
  locale: 'sv' | 'en' = 'sv',
  options: { mode?: 'edit' | 'duplicate'; scope?: Partial<BookingTemplateLibrary> } = {},
): string {
  return render(
    createElement(TemplateForm, {
      mode: options.mode ?? 'edit',
      initialTemplate: { ...template(lines), ...options.scope },
      entityLabels: { all: 'Alla' },
      onSaved: () => {},
    }),
    locale,
  )
}

/** A template shared by a team: every company of the team reads and books it. */
const TEAM_SCOPE = { company_id: null, team_id: 'team-1' }

const count = (html: string, text: string) => html.split(text).length - 1

describe('TemplateForm dimensions on cost/revenue lines', () => {
  it('offers the pickers on each cost/revenue line, never on the moms or payment line', () => {
    company.settings.dimensions_enabled = true
    const html = form([cost, { ...cost, account: '5460' }, vat, bank])
    expect(count(html, '>Kostnadsställe<')).toBe(2)
    expect(count(html, '>Projekt<')).toBe(2)
  })

  it('puts the two pickers under each other, one per row', () => {
    company.settings.dimensions_enabled = true
    // Side by side, the right-hand picker's list reaches past the dialog and
    // the dialog scrolls sideways.
    expect(form([cost, bank])).toMatch(/<div class="space-y-3"><div><label[^>]*>Kostnadsställe</)
  })

  it('says once what the tags do', () => {
    company.settings.dimensions_enabled = true
    expect(count(form([cost, { ...cost, account: '5460' }, vat, bank]), HELP_SV)).toBe(1)
    expect(count(form([cost, bank], 'en'), HELP_EN)).toBe(1)
  })

  it('shows the tag a line already carries', () => {
    company.settings.dimensions_enabled = true
    expect(form([{ ...cost, dimensions: { '6': 'P001' } }, bank])).toContain('P001')
  })

  it('shows no pickers, and no tag, on a template that belongs to a team', () => {
    company.settings.dimensions_enabled = true
    const html = form([{ ...cost, dimensions: { '6': 'P001' } }, vat, bank], 'sv', { scope: TEAM_SCOPE })
    expect(html).not.toContain('>Kostnadsställe<')
    expect(html).not.toContain('>Projekt<')
    expect(html).not.toContain(HELP_SV)
    expect(html).not.toContain('P001')
  })

  it("offers the pickers on the company's own copy of a team template", () => {
    company.settings.dimensions_enabled = true
    const html = form([cost, bank], 'sv', { mode: 'duplicate', scope: TEAM_SCOPE })
    expect(count(html, '>Kostnadsställe<')).toBe(1)
    expect(count(html, HELP_SV)).toBe(1)
  })

  it('shows no pickers for a company without dimensions', () => {
    company.settings.dimensions_enabled = false
    const html = form([{ ...cost, dimensions: { '6': 'P001' } }, vat, bank])
    expect(html).not.toContain('>Kostnadsställe<')
    expect(html).not.toContain('>Projekt<')
    expect(html).not.toContain(HELP_SV)
  })
})
