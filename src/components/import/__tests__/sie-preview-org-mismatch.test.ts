import { describe, expect, it } from 'vitest'
import { createElement, type ComponentProps } from 'react'
import { renderToString } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import sv from '@/messages/sv.json'
import type { ImportPreview } from '@/lib/import/types'
import SIEPreviewStep from '../SIEPreviewStep'

/**
 * PH 193: a bookkeeper uploaded a client's SIE file into their own company.
 * The preview listed the file's company as a plain value and the mismatch
 * was first said at the review step, after every account and VAT code had
 * been mapped. It is now said on the preview, with what to do.
 */
const IntlProvider = NextIntlClientProvider as (
  props: Omit<ComponentProps<typeof NextIntlClientProvider>, 'children'>,
) => ReturnType<typeof NextIntlClientProvider>

function preview(overrides: Partial<ImportPreview> = {}): ImportPreview {
  return {
    companyName: 'Klientbolaget AB',
    orgNumber: '556703-7485',
    fiscalYearStart: '2026-01-01',
    fiscalYearEnd: '2026-12-31',
    accountCount: 10,
    voucherCount: 5,
    transactionLineCount: 12,
    openingBalanceTotal: 0,
    trialBalance: { totalDebit: 0, totalCredit: 0, isBalanced: true },
    mappingStatus: { total: 10, mapped: 10, unmapped: 0, lowConfidence: 0 },
    excludedSystemAccounts: [],
    ...overrides,
  } as ImportPreview
}

function render(p: ImportPreview): string {
  return renderToString(
    createElement(IntlProvider, { locale: 'sv', messages: sv, timeZone: 'Europe/Stockholm' },
      createElement(SIEPreviewStep, {
        preview: p,
        issues: [],
        missingAccounts: [],
        onCreateAccounts: async () => {},
        isCreatingAccounts: false,
        onContinue: () => {},
        onBack: () => {},
      })),
  )
}

describe('SIEPreviewStep: a file for another organisation', () => {
  it('says so on the preview, naming both numbers and how to add the other company', () => {
    const html = render(preview({ orgNumberMismatch: true, companyOrgNumber: '556016-0680' }))
    expect(html).toContain('Filen tillhör organisationsnummer 556703-7485, inte det här företaget (556016-0680).')
    expect(html).toContain('Lägg till företag')
  })

  it('says nothing when the numbers agree', () => {
    const html = render(preview({ orgNumberMismatch: false, companyOrgNumber: '556703-7485' }))
    expect(html).not.toContain('Filen tillhör organisationsnummer')
  })
})
