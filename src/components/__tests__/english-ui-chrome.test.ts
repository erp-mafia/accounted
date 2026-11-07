/**
 * crm#1356: a customer using Accounted in English met Swedish text all over
 * the app, written straight into the components instead of read from the
 * catalogue. These render the components that now read it, under the English
 * catalogue, and read the HTML a browser would get: no visible text,
 * placeholder, title or aria-label may look Swedish by the rule check:guards
 * applies to the source (scripts/checks/swedish-ui-literal.mjs). Under the
 * Swedish catalogue the same components keep their Swedish text.
 *
 * Components these render but do not own (dialog, card shell, voucher lines
 * table, row editor, support link) are stubbed to pass their children and
 * props through, so the text judged here is the component's own.
 */
import { describe, expect, it, vi } from 'vitest'
import { createElement, type ReactElement, type ReactNode } from 'react'
import { looksSwedish } from '@/scripts/checks/swedish-ui-literal.mjs'
import { renderInLocale, visibleText } from '@/tests/i18n-render'
import type { ExtensionDefinition } from '@/lib/extensions/types'

type Children = { children?: ReactNode }

// vi.mock factories are hoisted above this file's declarations: each builds
// its own pass-through.
vi.mock('@/components/ui/dialog', () => {
  const pass = ({ children }: Children) => createElement('div', null, children)
  return {
    Dialog: ({ open, children }: Children & { open: boolean }) => (open ? createElement('div', null, children) : null),
    DialogContent: pass,
    DialogHeader: pass,
    DialogTitle: pass,
    DialogDescription: pass,
    DialogFooter: pass,
  }
})
vi.mock('@/components/ui/attn-line', () => ({ AttnLine: ({ children }: Children) => createElement('div', null, children) }))
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: () => {} }) }))
vi.mock('@/components/ui/support-link', () => ({ SupportLink: ({ children }: Children) => createElement('span', null, children) }))
vi.mock('@/components/ui/account-number', () => ({
  AccountNumber: ({ number }: { number: string }) => createElement('span', null, number),
}))
vi.mock('@/components/bookkeeping/VoucherLinesTable', () => ({ VoucherLinesTable: () => null }))
vi.mock('@/components/import/OpeningBalanceRowEditor', () => ({ default: () => null }))
vi.mock('@/components/import/ImportNotices', () => ({ ImportNotices: () => null }))
vi.mock('@/components/extensions/ExtensionWorkspaceShell', () => ({
  default: ({ children }: Children) => createElement('div', null, children),
}))
vi.mock('@/components/extensions/shared/EmptyExtensionState', () => ({
  default: ({ title, description }: { title: string; description: string }) =>
    createElement('div', null, createElement('h2', null, title), createElement('p', null, description)),
}))
vi.mock('@/lib/extensions/workspace-registry', () => ({ getWorkspaceComponent: () => null }))
vi.mock('@/lib/reference-data/invalidate', () => ({ invalidateReferenceData: async () => {} }))
vi.mock('@/lib/reference-data/hooks', () => ({
  useDimensions: () => ({ dimensions: [], isLoading: false, error: null }),
}))
vi.mock('@/components/import/register-review-fields', () => ({
  useCustomerReviewFields: () => [],
  useSupplierReviewFields: () => [],
  useArticleReviewFields: () => [],
}))

import CreatePeriodDialog from '../bookkeeping/CreatePeriodDialog'
import ExtractionStatus from '../ui/extraction-status'
import { AppErrorBoundary } from '../system/AppErrorBoundary'
import { Ink2FilingHelp } from '../reports/Ink2FilingHelp'
import { DeclarationRutaRow } from '../reports/DeclarationRutaRow'
import OpeningBalanceEditStep from '../import/OpeningBalanceEditStep'
import DimensionCombobox from '../dimensions/DimensionCombobox'
import ExtensionWorkspaceLoader from '../extensions/ExtensionWorkspaceLoader'
import JourneyTrack from '../onboarding/journey/JourneyTrack'
import { JournalEntryReviewContent } from '../bookkeeping/JournalEntryReviewContent'
import { useRegisterImportConfig } from '../import/register-import-config'

function render(element: ReactElement, locale: 'sv' | 'en'): string {
  // The error fallback shows once the one automatic reload has been used;
  // without a window (the server render) it renders nothing. Only that
  // component reads this stub: others probe a real window when one exists.
  if (element.type === AppErrorBoundary) {
    vi.stubGlobal('window', { location: { pathname: '/x' }, sessionStorage: { getItem: () => '1', setItem: () => {} } })
    try {
      return renderInLocale(element, locale)
    } finally {
      vi.unstubAllGlobals()
    }
  }
  return renderInLocale(element, locale)
}

function RegisterColumns({ entity }: { entity: 'customers' | 'suppliers' | 'articles' }) {
  const config = useRegisterImportConfig(entity)
  return createElement(
    'ul',
    null,
    config.columnSpecs.map((spec) => createElement('li', { key: spec.key }, spec.label)),
  )
}

const noop = () => {}

// Fixtures with English-neutral names, so whatever reads as Swedish is the UI's.
const SURFACES: Array<[string, () => ReactElement]> = [
  [
    'the dialog that creates a missing fiscal year',
    () => createElement(CreatePeriodDialog, { open: true, onOpenChange: noop, entryDate: '2025-03-14', periods: [], onCreated: noop }),
  ],
  ...(['running', 'succeeded', 'unsupported', 'failed'] as const).map((status): [string, () => ReactElement] => [
    `the document reading status: ${status}`,
    () => createElement(ExtractionStatus, { status }),
  ]),
  ['the document reading status: slow', () => createElement(ExtractionStatus, { status: 'running', elapsedMs: 9_000 })],
  ['the app-wide error fallback', () => createElement(AppErrorBoundary, { error: new Error('boom'), scope: 'test' })],
  ['the INK2 filing help', () => createElement(Ink2FilingHelp)],
  [
    'a declaration row with its accounts',
    () =>
      createElement(
        'table',
        null,
        createElement(
          'tbody',
          null,
          createElement(DeclarationRutaRow, {
            code: '7410',
            label: 'Net sales',
            amount: 1200,
            accounts: [
              { accountNumber: '3001', accountName: 'Sales', amount: 1000 },
              { accountNumber: '3002', accountName: 'Sales', amount: 200 },
            ],
          }),
        ),
      ),
  ],
  [
    'the opening balance edit step',
    () => createElement(OpeningBalanceEditStep, { rows: [], onContinue: noop, onBack: noop }),
  ],
  ['a dimension value picker', () => createElement(DimensionCombobox, { sieDimNo: '1', value: null, onChange: noop })],
  [
    'an extension without a view of its own',
    () =>
      createElement(ExtensionWorkspaceLoader, {
        sector: 'general',
        slug: 'example',
        definition: { name: 'Example' } as ExtensionDefinition,
        userId: 'user-1',
      }),
  ],
  [
    'the onboarding journey with a station done',
    () =>
      createElement(JourneyTrack, {
        stations: [{ label: 'Company', answer: 'Example AB' }, { label: 'Bank' }],
        active: 1,
        onJump: noop,
      }),
  ],
  [
    'the review of a voucher before it is posted',
    () =>
      createElement(JournalEntryReviewContent, {
        periodName: '2025',
        entryDate: '2025-03-14',
        description: 'Office supplies',
        notes: 'Paid by card',
        voucherSeries: 'A',
        lines: [],
        attachmentCount: 2,
      }),
  ],
  ...(['customers', 'suppliers', 'articles'] as const).map((entity): [string, () => ReactElement] => [
    `the file columns to map for ${entity}`,
    () => createElement(RegisterColumns, { entity }),
  ]),
]

describe('English chrome (crm#1356)', () => {
  it.each(SURFACES)('%s reads nothing Swedish under the English catalogue', (_, build) => {
    const text = visibleText(render(build(), 'en'))
    expect(text.length).toBeGreaterThan(0)
    expect(text.filter(looksSwedish)).toEqual([])
  })

  it.each(SURFACES)('%s reads its own words under the Swedish catalogue', (_, build) => {
    expect(visibleText(render(build(), 'sv'))).not.toEqual(visibleText(render(build(), 'en')))
  })

  it('says the Swedish it said before', () => {
    const text = (element: ReactElement) => visibleText(render(element, 'sv')).join(' | ')
    expect(text(SURFACES[0][1]())).toContain('Det finns inget räkenskapsår som täcker datumet 2025-03-14. Skapa ett nytt nedan.')
    expect(text(createElement(ExtractionStatus, { status: 'failed' }))).toContain('Kunde inte läsa automatiskt: fyll i manuellt')
    expect(text(createElement(Ink2FilingHelp))).toContain('Skatteverkets filöverföringstjänst')
    expect(text(createElement(AppErrorBoundary, { error: new Error('boom'), scope: 'test' }))).toContain('Något gick fel')
    expect(text(createElement(RegisterColumns, { entity: 'articles' }))).toContain('Typ (vara/tjänst)')
  })
})
