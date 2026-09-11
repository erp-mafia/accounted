import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import {
  buildPaletteEntries,
  groupPaletteResults,
  type PaletteContext,
  type PaletteEntry,
} from '../command-palette-entries'
import type { NavGateContext } from '@/components/dashboard/nav-gates'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { REPORT_CATALOG, isReportVisible } from '@/lib/reports/catalog'

const ROOT = path.resolve(__dirname, '../../..')
const DASHBOARD = path.join(ROOT, 'app', '(dashboard)')

type Messages = Record<string, Record<string, string>>
const sv: Messages = JSON.parse(fs.readFileSync(path.join(ROOT, 'messages', 'sv.json'), 'utf8'))
const en: Messages = JSON.parse(fs.readFileSync(path.join(ROOT, 'messages', 'en.json'), 'utf8'))

function labelsFor(messages: Messages): PaletteContext['labels'] {
  const pick = (ns: string) => (key: string) => {
    const value = messages[ns]?.[key]
    if (value === undefined) throw new Error(`missing ${ns}.${key}`)
    return value
  }
  return { nav: pick('nav'), reports: pick('reports'), palette: pick('command_palette') }
}

function gates(overrides: Partial<NavGateContext> = {}): NavGateContext {
  return {
    entityType: 'aktiebolag',
    isEmployer: true,
    dimensionsEnabled: true,
    salesOrdersEnabled: true,
    hasWebshop: true,
    hasMileage: true,
    hasExpenseClaims: true,
    capabilities: [CAPABILITY.ai],
    hiddenNavHrefs: new Set(),
    assistantVerified: true,
    ...overrides,
  }
}

function context(
  overrides: Partial<PaletteContext> = {},
  gateOverrides: Partial<NavGateContext> = {},
): PaletteContext {
  return {
    gates: gates(gateOverrides),
    hasCompany: true,
    isByraMember: false,
    shell: 'v2',
    settingsSections: [
      { id: 'invoicing', href: '/settings/invoicing', label: sv.settings_nav.invoicing },
      { id: 'tax', href: '/settings/tax', label: sv.settings_nav.tax },
    ],
    settingsShortcut: '⌘,',
    labels: labelsFor(sv),
    ...overrides,
  }
}

const hrefs = (entries: PaletteEntry[]) => entries.map((e) => e.href)
const firstHit = (entries: PaletteEntry[], query: string) =>
  groupPaletteResults(entries, query)[0]?.entries[0]
const allHits = (entries: PaletteEntry[], query: string) =>
  groupPaletteResults(entries, query).flatMap((g) => g.entries)

/** The page file a palette href resolves to, mirroring the app router. */
function routeExists(href: string): boolean {
  const base = href.split(/[?#]/)[0]
  if (base === '/') return fs.existsSync(path.join(DASHBOARD, 'page.tsx'))
  if (base.startsWith('/e/')) return fs.existsSync(path.join(DASHBOARD, 'e', '[sector]', '[slug]', 'page.tsx'))
  if (fs.existsSync(path.join(DASHBOARD, ...base.slice(1).split('/'), 'page.tsx'))) return true
  const report = base.match(/^\/reports\/([^/]+)$/)
  if (report) return REPORT_CATALOG.some((r) => r.slug === report[1] && !r.route)
  return false
}

describe('buildPaletteEntries', () => {
  const entries = buildPaletteEntries(context())

  it('every destination is a real route (no dead ⌘K links)', () => {
    const dead = entries.filter((e) => !routeExists(e.href)).map((e) => `${e.id} -> ${e.href}`)
    expect(dead).toEqual([])
  })

  it('lists each destination once (actions are verbs for a page and may share its href)', () => {
    const seen = new Map<string, string>()
    const dupes: string[] = []
    for (const e of entries.filter((e) => e.section !== 'actions')) {
      const prev = seen.get(e.href)
      if (prev) dupes.push(`${e.href}: ${prev} + ${e.id}`)
      seen.set(e.href, e.id)
    }
    expect(dupes).toEqual([])
  })

  it('covers every section and sub-item of the v2 sidebar', () => {
    for (const href of [
      '/', '/pending', '/chat', '/agent-knowledge', '/accounts', '/reconciliation', '/transactions',
      '/parties', '/invoices', '/sales-orders', '/orders', '/customers', '/articles',
      '/supplier-invoices', '/e/general/invoice-inbox', '/expenses', '/mileage',
      '/supplier-invoices/payment-files', '/suppliers', '/bookkeeping', '/chart-of-accounts',
      '/bookkeeping/periodiseringar', '/assets', '/dimensions', '/import', '/salary',
      '/salary/employees', '/reports/vat-declaration', '/deadlines', '/reports', '/kpi',
      '/bookkeeping/year-end', '/bookkeeping/year-end/arsredovisning', '/reports/ink2-declaration',
    ]) {
      expect(hrefs(entries), href).toContain(href)
    }
  })

  it('keeps the off-sidebar routes reachable by search', () => {
    expect(hrefs(entries)).toEqual(
      expect.arrayContaining(['/rules', '/skattekonto', '/invoices/recurring', '/invoices/rot-rut', '/extensions', '/help', '/settings']),
    )
    expect(firstHit(entries, 'regler')?.href).toBe('/rules')
    expect(firstHit(entries, 'skattekonto')?.href).toBe('/skattekonto')
  })

  it('names a shared href by the more specific label and keeps the other as vocabulary', () => {
    const byHref = new Map(entries.map((e) => [e.href, e]))
    expect(byHref.get('/invoices')?.label).toBe('Kundfakturor')
    expect(byHref.get('/bookkeeping')?.label).toBe('Verifikationer')
    // "Översikt" says nothing on its own; "Löner" is the word people type.
    expect(byHref.get('/accounts')?.label).toBe('Konton')
    expect(byHref.get('/salary')?.label).toBe('Löner')
    expect(byHref.get('/invoices')?.aliases).toEqual(['Fakturering'])
    expect(byHref.get('/reports/vat-declaration')?.aliases).toEqual(['Skatt', 'Momsdeklaration'])
    expect(firstHit(entries, 'fakturering')?.href).toBe('/invoices')
    expect(firstHit(entries, 'bokföring')?.href).toBe('/bookkeeping')
    expect(firstHit(entries, 'lönekörning')?.href).toBe('/salary')
  })

  it('shows the sidebar section as the hint on a sub-page', () => {
    const byHref = new Map(entries.map((e) => [e.href, e]))
    expect(byHref.get('/chart-of-accounts')?.hint).toBe('Bokföring')
    expect(byHref.get('/customers')?.hint).toBe('Fakturering')
    expect(byHref.get('/invoices')?.hint).toBeUndefined()
    expect(byHref.get('/settings')?.hint).toBe('⌘,')
  })

  it('offers every visible report by its name, as a row or merged into the page it lives on', () => {
    const visible = REPORT_CATALOG.filter((r) => isReportVisible(r, 'aktiebolag', true, true))
    expect(visible.length).toBeGreaterThan(15)
    for (const r of visible) {
      const href = r.route ?? `/reports/${r.slug}`
      const name = sv.reports[r.labelKey]
      expect(hrefs(allHits(entries, name)), `${name} -> ${href}`).toContain(href)
    }
    // A report that IS a page merges instead of duplicating the destination.
    expect(entries.filter((e) => e.href === '/reports/vat-declaration')).toHaveLength(1)
    expect(entries.filter((e) => e.href === '/reconciliation')).toHaveLength(1)
    expect(firstHit(entries, 'momsdeklaration')?.href).toBe('/reports/vat-declaration')
    expect(firstHit(entries, 'bankavstämning')?.href).toBe('/reconciliation')
  })

  it('lists the settings sections it is given', () => {
    const settings = entries.filter((e) => e.section === 'settings')
    expect(hrefs(settings)).toEqual(['/settings/invoicing', '/settings/tax'])
    expect(settings[0].hint).toBe('Inställningar')
    expect(firstHit(entries, 'inställningar fakturering')?.href).toBe('/settings/invoicing')
  })

  it('offers the create actions as deep links that open the dialog', () => {
    const actions = entries.filter((e) => e.section === 'actions')
    expect(hrefs(actions)).toEqual([
      '/invoices?new=1',
      '/supplier-invoices?new=1',
      '/bookkeeping?new=1',
      '/transactions',
      '/customers?new=1',
      '/salary/employees?new=1',
      '/import',
    ])
  })

  it('reads labels from the locale it is given', () => {
    const english = buildPaletteEntries(context({ labels: labelsFor(en) }))
    const byHref = new Map(english.map((e) => [e.href, e]))
    expect(byHref.get('/invoices')?.label).toBe('Customer invoices')
    expect(byHref.get('/invoices?new=1')?.label).toBe('New customer invoice')
    expect(byHref.get('/reports/huvudbok')?.label).toBe('General ledger')
    // Swedish vocabulary still works in the English UI.
    expect(firstHit(english, 'huvudbok')?.href).toBe('/reports/huvudbok')
  })
})

describe('gates: the palette hides exactly what the sidebar hides', () => {
  it('payroll for non-employers, including the action', () => {
    const entries = buildPaletteEntries(context({}, { isEmployer: false }))
    expect(hrefs(entries)).not.toContain('/salary')
    expect(hrefs(entries)).not.toContain('/salary/employees')
    expect(hrefs(entries)).not.toContain('/salary/employees?new=1')
  })

  it('dimension surfaces and the dimension report without the opt-in', () => {
    const entries = buildPaletteEntries(context({}, { dimensionsEnabled: false }))
    expect(hrefs(entries)).not.toContain('/dimensions')
    expect(hrefs(entries)).not.toContain('/reports/dimension-pnl')
  })

  it('the paywalled Underlag workspace without the capability', () => {
    const entries = buildPaletteEntries(context({}, { capabilities: [] }))
    expect(hrefs(entries)).not.toContain('/e/general/invoice-inbox')
  })

  it('statutory surfaces per entity type', () => {
    const ef = hrefs(buildPaletteEntries(context({}, { entityType: 'enskild_firma', isEmployer: false })))
    expect(ef).toContain('/reports/ne-declaration')
    expect(ef).not.toContain('/reports/ink2-declaration')
    expect(ef).not.toContain('/bookkeeping/year-end/arsredovisning')
    const ab = hrefs(buildPaletteEntries(context()))
    expect(ab).not.toContain('/reports/ne-declaration')
  })

  it('the assistant until the agent onboarding is done', () => {
    const entries = buildPaletteEntries(context({}, { assistantVerified: false }))
    expect(hrefs(entries)).not.toContain('/chat')
    expect(hrefs(entries)).not.toContain('/agent-knowledge')
  })

  it('hrefs the host branding hides, and the actions under them', () => {
    const entries = buildPaletteEntries(context({}, { hiddenNavHrefs: new Set(['/salary', '/invoices']) }))
    expect(hrefs(entries)).not.toContain('/salary')
    expect(hrefs(entries)).not.toContain('/invoices')
    expect(hrefs(entries)).not.toContain('/invoices?new=1')
  })

  it('everything company-scoped without an active company', () => {
    const entries = buildPaletteEntries(context({ hasCompany: false, isByraMember: true }))
    expect(entries.length).toBeGreaterThan(0)
    for (const e of entries) expect(e.href, e.id).toMatch(/^\/(settings|clients)/)
  })

  it('the byrå cockpit only for byrå members', () => {
    expect(hrefs(buildPaletteEntries(context()))).not.toContain('/clients')
    expect(hrefs(buildPaletteEntries(context({ isByraMember: true })))).toContain('/clients')
  })
})

describe('groupPaletteResults', () => {
  const entries = buildPaletteEntries(context())

  it('with no query lists the actions and the sidebar section heads, in sidebar order', () => {
    const groups = groupPaletteResults(entries, '')
    expect(groups.map((g) => g.section)).toEqual(['actions', 'pages'])
    expect(hrefs(groups[1].entries)).toEqual([
      '/', '/chat', '/accounts', '/transactions', '/invoices', '/supplier-invoices',
      '/bookkeeping', '/salary', '/reports/vat-declaration', '/reports', '/bookkeeping/year-end',
    ])
  })

  it('ignores diacritics and case', () => {
    expect(firstHit(entries, 'stam av')?.href).toBe('/reconciliation')
    expect(firstHit(entries, 'LEVERANTÖRER')?.href).toBe('/suppliers')
  })

  it('narrows with every token', () => {
    expect(hrefs(allHits(entries, 'verifikat per konto'))).toContain('/reports/huvudbok')
    expect(allHits(entries, 'verifikat faktura banan')).toEqual([])
  })

  it('selects the strongest answer first, across sections', () => {
    // A label prefix beats a vocabulary-only match in an earlier section.
    expect(firstHit(entries, 'resultat')?.href).toBe('/reports/resultatrapport')
    expect(firstHit(entries, 'ny kund')?.href).toBe('/customers?new=1')
    expect(firstHit(entries, 'moms')?.href).toBe('/reports/vat-declaration')
    expect(firstHit(entries, 'kontoplan')?.href).toBe('/chart-of-accounts')
  })

  it('keeps Avstämning ahead of Huvudbok on "stäm av" (DECISIONS 2026-07-30)', () => {
    const hits = allHits(entries, 'stäm av')
    expect(hits[0]?.href).toBe('/reconciliation')
    expect(hrefs(hits)).toContain('/reports/huvudbok')
  })

  it('names the start page after the shell', () => {
    const v2 = buildPaletteEntries(context({ shell: 'v2' })).find((e) => e.href === '/')
    const v1 = buildPaletteEntries(context({ shell: 'v1' })).find((e) => e.href === '/')
    expect(v2?.label).toBe('Att göra')
    expect(v1?.label).toBe('Hem')
    expect(firstHit(buildPaletteEntries(context({ shell: 'v1' })), 'att göra')?.href).toBe('/')
    expect(firstHit(buildPaletteEntries(context({ shell: 'v2' })), 'hem')?.href).toBe('/')
  })
})
