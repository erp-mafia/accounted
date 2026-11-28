/**
 * crm#1356: an English-locale user moving their books over by SIE file met a
 * Swedish upload step, preview, mapping step, review and result. These tests
 * render each step of that wizard under the English catalogue and read the
 * HTML a browser would get: no visible text, placeholder, title or label may
 * look Swedish by the same rule check:guards applies to the source
 * (scripts/checks/swedish-ui-literal.mjs). Popovers and tooltips render their
 * content inline here, so the help text behind every "?" is read too.
 */
import { describe, expect, it, vi } from 'vitest'
import { createElement, type ReactElement, type ReactNode } from 'react'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import { looksSwedish } from '@/scripts/checks/swedish-ui-literal.mjs'
import { renderInLocale as render, visibleText } from '@/tests/i18n-render'
import type { AccountMapping, ImportPreview, ImportResult, ParseIssue } from '@/lib/import/types'
import type { BASAccount } from '@/types'

type Children = { children?: ReactNode }

// Closed Radix popovers, tooltips and selects keep their content out of a
// server render. Inline stubs put it in the HTML, so the help text and the
// options are judged with the rest.
vi.mock('@/components/ui/help-popover', () => ({
  HelpPopover: ({ children }: { children: ReactNode | ((close: () => void) => ReactNode) }) =>
    createElement('div', null, typeof children === 'function' ? children(() => {}) : children),
}))
vi.mock('@/components/ui/info-tooltip', () => {
  const pass = ({ children }: Children) => createElement('div', null, children)
  return {
    InfoTooltip: ({ content }: { content: ReactNode }) => createElement('div', null, content),
    HelpLink: pass,
    Tooltip: pass,
    TooltipTrigger: pass,
    TooltipContent: pass,
    TooltipProvider: pass,
  }
})
vi.mock('@/components/ui/select', () => {
  const pass = ({ children }: Children) => createElement('div', null, children)
  return {
    Select: pass,
    SelectTrigger: pass,
    SelectContent: pass,
    SelectValue: ({ placeholder }: { placeholder?: string }) => createElement('span', null, placeholder),
    SelectItem: ({ children }: Children) => createElement('div', null, children),
  }
})
vi.mock('@/components/ui/destructive-confirm-dialog', () => ({
  DestructiveConfirmDialog: () => null,
  useDestructiveConfirm: () => ({ dialogProps: {}, confirm: async () => false }),
}))
vi.mock('@/contexts/CompanyContext', () => ({
  useCompany: () => ({ company: { id: 'company-1' }, isSandbox: false }),
}))
vi.mock('@/lib/hooks/use-can-write', () => ({ useCanWrite: () => ({ canWrite: true }) }))
vi.mock('@/lib/hooks/use-unsaved-changes', () => ({ useUnsavedChanges: () => {} }))
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({}) }))
vi.mock('@/lib/reference-data/hooks', () => ({
  useCompanySettings: () => ({ settings: null }),
  // Two years with a hole between them, so the gap notice renders as well.
  useFiscalPeriods: () => ({
    periods: [
      { id: 'p1', name: '2023', period_start: '2023-01-01', period_end: '2023-12-31' },
      { id: 'p2', name: '2025', period_start: '2025-01-01', period_end: '2025-12-31' },
    ],
  }),
}))

import SIEUploadStep from '../SIEUploadStep'
import SIEPreviewStep from '../SIEPreviewStep'
import AccountMappingStep from '../AccountMappingStep'
import ImportReviewStep from '../ImportReviewStep'
import ImportResultStep from '../ImportResultStep'

/**
 * Swedish on purpose in the English text: a BAS account name (BAS names stay
 * Swedish) and the source systems' own menu paths.
 * A voucher series' name is the company's own (company_settings, with the
 * presets from lib/bookkeeping/voucher-series-resolver as fallback): data,
 * not chrome.
 */
function byDesign(text: string): string {
  return text
    .replace(/\(Årets resultat\)/g, '')
    .replace(/^(Fortnox|Visma|Bokio): .*$/, '')
    .replace(/^(Series [A-Z]) [^,]*/, '$1')
}

function swedishIn(html: string): string[] {
  return visibleText(html).filter((text) => looksSwedish(byDesign(text)))
}

// Fixtures with English-neutral names, so whatever reads as Swedish is the UI's.
const preview: ImportPreview = {
  companyName: 'Example AB',
  orgNumber: '5560000000',
  fiscalYearStart: '2025-01-01',
  fiscalYearEnd: '2025-12-31',
  accountCount: 120,
  voucherCount: 340,
  transactionLineCount: 1200,
  openingBalanceTotal: 50000,
  // A 1 200 kr difference: the significant-imbalance block with its help.
  trialBalance: { totalDebit: 50000, totalCredit: 48800, isBalanced: false },
  mappingStatus: { total: 120, mapped: 118, unmapped: 2, lowConfidence: 3 },
  excludedSystemAccounts: [{ number: '0099', name: 'System' }],
  voucherSeriesInFile: ['A'],
  issues: [],
}

const issues: ParseIssue[] = [
  { severity: 'error', line: 12, message: 'Parser message' },
  { severity: 'warning', line: 40, message: 'Parser message' },
]

const missingAccounts = Array.from({ length: 12 }, (_, i) => ({ number: String(6990 + i), name: 'Custom' }))

const chart: BASAccount[] = [
  { account_number: '1930', account_name: 'Bank', account_class: 1 },
  { account_number: '3001', account_name: 'Sales', account_class: 3 },
  { account_number: '9001', account_name: 'Other', account_class: 9 },
] as BASAccount[]

function mapping(n: number, overrides: Partial<AccountMapping> = {}): AccountMapping {
  const number = String(3000 + n)
  return {
    sourceAccount: number,
    sourceName: 'Sales',
    targetAccount: number,
    targetName: 'Sales',
    confidence: 1,
    matchType: 'exact',
    isOverride: false,
    ...overrides,
  }
}

// 60 rows (two pages) with every match label and a created target. The
// step opens on "all" for these, so the pager and the labels show.
const settledMappings: AccountMapping[] = [
  mapping(1, { sourceAccount: '9001', targetAccount: '2999', targetName: 'Suspense', confidence: 0.5, matchType: 'class' }),
  mapping(2, { confidence: 0.7, matchType: 'bas_range' }),
  mapping(3, { isOverride: true }),
  mapping(4, { targetAccount: '3999', targetName: '' }),
  ...Array.from({ length: 56 }, (_, i) => mapping(10 + i)),
]
// An unmapped row and one awaiting VAT review: the step opens on its
// "unmapped" filter and the continue button names what is left.
const mappings: AccountMapping[] = [
  mapping(0, { sourceAccount: '0100', targetAccount: '', targetName: '', confidence: 0, matchType: 'class' }),
  mapping(5, {
    defaultVatTreatment: 'standard_25',
    defaultVatRate: 0.25,
    vatTreatmentSuggested: true,
    vatTreatmentReviewed: false,
    requiresVatTreatmentReview: true,
  }),
  ...settledMappings,
]

const failedResult: ImportResult = {
  success: false,
  importId: null,
  fiscalPeriodId: null,
  openingBalanceEntryId: null,
  journalEntriesCreated: 0,
  journalEntryIds: [],
  errors: ['Server message'],
  warnings: [],
}

const successResult: ImportResult = {
  success: true,
  importId: 'import-1',
  fiscalPeriodId: 'period-1',
  openingBalanceEntryId: null,
  journalEntriesCreated: 340,
  journalEntryIds: [],
  accountsCreated: 4,
  accountsRenamed: 3,
  errors: [],
  warnings: [],
  details: {
    retriedBatches: 0,
    failedBatches: 0,
    openingBalanceSkipped: 'prior_activity',
    skippedVouchers: { unbalanced: 1, unmapped: 2, singleLine: 1, empty: 3, total: 7 },
    untransferredResults: [{ fiscal_period_id: 'p0', period_name: '2024', pl_net: 1000 }],
    resultTransfer: { entryId: 'e1', voucher: 'A2', date: '2025-01-01', from: '2099', to: '2091', amount: 11850 },
  },
  nextPeriodIBResync: { nextPeriodId: 'p3', nextPeriodName: '2026', stornoEntryId: 's', newOpeningBalanceEntryId: 'n' },
  nextPeriodIBResyncSkipped: { reason: 'locked', nextPeriodName: '2027' },
  dimensionsImported: { dimensions: 1, values: 4, taggedLines: 20, toggleEnabled: true },
}

const noop = () => {}

/** Each step in the states that show the most text. */
const STEPS: Array<[string, ReactElement]> = [
  ['upload, empty', createElement(SIEUploadStep, { onFileSelect: noop, isLoading: false, error: null })],
  ...(['duplicate', 'duplicate_period', 'validation', 'parse', 'network'] as const).map(
    (errorType): [string, ReactElement] => [
      `upload, ${errorType} error`,
      createElement(SIEUploadStep, {
        onFileSelect: noop,
        isLoading: false,
        error: 'Server message',
        errorType,
        validationErrors: ['Server message'],
        validationWarnings: ['Server message'],
        duplicateImportId: 'import-0',
        onReplace: async () => {},
      }),
    ],
  ),
  [
    'preview',
    createElement(SIEPreviewStep, {
      preview,
      issues,
      missingAccounts,
      onCreateAccounts: async () => {},
      isCreatingAccounts: false,
      onContinue: noop,
      onBack: noop,
      onOpenManualOpeningBalances: noop,
    }),
  ],
  [
    'mapping, all rows',
    createElement(AccountMappingStep, {
      mappings: settledMappings,
      basAccounts: chart,
      onMappingChange: noop,
      onVatTreatmentChange: noop,
      onConfirmAllVatTreatments: noop,
      onContinue: noop,
      onBack: noop,
    }),
  ],
  [
    'mapping, unmapped rows',
    createElement(AccountMappingStep, {
      mappings,
      basAccounts: chart,
      onMappingChange: noop,
      onVatTreatmentChange: noop,
      onConfirmAllVatTreatments: noop,
      onContinue: noop,
      onBack: noop,
    }),
  ],
  [
    'review',
    createElement(ImportReviewStep, {
      preview: { ...preview, fiscalYearEnd: '2020-12-31' },
      mappings,
      onExecute: async () => {},
      onBack: noop,
      isLoading: false,
    }),
  ],
  [
    'review, importing',
    createElement(ImportReviewStep, { preview, mappings, onExecute: async () => {}, onBack: noop, isLoading: true }),
  ],
  ['result, failed', createElement(ImportResultStep, { result: failedResult, onNewImport: noop })],
  ['result, done', createElement(ImportResultStep, { result: successResult, onNewImport: noop, onUndo: noop })],
]

describe('SIE import wizard under the English locale (crm#1356)', () => {
  it.each(STEPS)('%s: no Swedish text reaches the page', (_, element) => {
    expect(swedishIn(render(element, 'en'))).toEqual([])
  })

  it.each(STEPS)('%s: the Swedish locale still reads Swedish', (_, element) => {
    // The same render in Swedish is what the check above would flag: proof
    // the extraction sees the text at all.
    expect(swedishIn(render(element, 'sv')).length).toBeGreaterThan(0)
  })

  it('shows the strings this fix moved into the catalogue', () => {
    const html = render(STEPS[0][1], 'en')
    expect(html).toContain('Upload SIE file')
    expect(render(STEPS.find(([name]) => name === 'mapping, all rows')![1], 'en')).toContain('Showing 1-50 of 60')
  })

  it('names the omföring of last year\'s result the import booked, in both languages', () => {
    const done = STEPS.find(([name]) => name === 'result, done')![1]
    const english = visibleText(render(done, 'en'))
    expect(english).toContain('Last year\'s result')
    expect(english).toContainEqual(expect.stringMatching(/^11\s850,00\skr transferred to 2091, voucher A2$/))
    expect(english).toContainEqual(expect.stringContaining('has it on 2091'))
    expect(visibleText(render(done, 'sv'))).toContainEqual(expect.stringMatching(/^11\s850,00\skr omfört till 2091, verifikation A2$/))
  })

  it('names what the mapper did with a row in English', () => {
    const html = render(STEPS.find(([name]) => name === 'mapping, all rows')![1], 'en')
    for (const label of ['Match', 'BAS account', 'From the file', 'Moved', 'Manual']) {
      expect(html).toContain(`>${label}<`)
    }
  })
})

describe('the catalogue entries added for crm#1356', () => {
  const flatten = (value: unknown, prefix = ''): string[] =>
    value && typeof value === 'object'
      ? Object.entries(value).flatMap(([k, v]) => flatten(v, `${prefix}${k}.`))
      : [prefix.slice(0, -1)]

  it.each([
    ['import', 'sie_flow'],
    ['import', 'sie_upload'],
    ['import', 'preview_step'],
    ['import', 'sie_review'],
    ['import', 'sie_result'],
    ['import', 'theater_bucket'],
    ['chart_of_accounts', 'mapping_step'],
  ] as const)('%s.%s has the same keys in sv and en', (namespace, group) => {
    const svGroup = (sv[namespace] as Record<string, unknown>)[group]
    const enGroup = (en[namespace] as Record<string, unknown>)[group]
    expect(flatten(enGroup).sort()).toEqual(flatten(svGroup).sort())
  })

  it('books has the onboarding theater words in both languages', () => {
    for (const key of ['grp_other_assets', 'grp_other_liabilities', 'grp_other_revenue', 'grp_other_costs', 'grp_counterparty', 'grp_vouchers']) {
      expect(sv.books).toHaveProperty(key)
      expect(en.books).toHaveProperty(key)
    }
  })
})
