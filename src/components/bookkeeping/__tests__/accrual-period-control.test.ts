import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { NextIntlClientProvider } from 'next-intl'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import AccrualPeriodControl from '../AccrualPeriodControl'
import type { AccrualDirection } from '@/types'

const IntlProvider = NextIntlClientProvider as (
  props: Omit<ComponentProps<typeof NextIntlClientProvider>, 'children'>,
) => ReturnType<typeof NextIntlClientProvider>

function render(opts: {
  start?: string
  end: string
  account?: string
  direction?: AccrualDirection
  targetAccount?: string
  locale?: 'sv' | 'en'
}) {
  const locale = opts.locale ?? 'sv'
  return renderToStaticMarkup(createElement(IntlProvider, { locale, messages: locale === 'en' ? en : sv },
    createElement(AccrualPeriodControl, {
      direction: opts.direction ?? 'revenue',
      amount: 100000,
      currency: 'SEK',
      value: { start: opts.start ?? '2026-09-01', end: opts.end, balanceAccount: opts.account ?? '2970' },
      onChange: vi.fn(),
      onRemove: vi.fn(),
      idPrefix: 'test',
      invoiceDate: '2026-10-26',
      targetAccount: opts.targetAccount ?? null,
    }),
  ))
}

describe('AccrualPeriodControl, deferral before the invoice month (#113)', () => {
  it('refuses a one-month deferral that ends before the invoice month and names the upplupen account', () => {
    const html = render({ end: '2026-09-30' })
    expect(html).toContain('Välj 1790 (upplupen) i stället')
    expect(html).not.toContain('bokförs 2026-10-26')
    expect(html).not.toContain('Hela beloppet bokförs')
  })

  it('refuses a multi-month deferral that ends before the invoice month', () => {
    const html = render({ start: '2026-08-01', end: '2026-09-30' })
    expect(html).toContain('Välj 1790 (upplupen) i stället')
    expect(html).not.toContain('2 månader')
  })

  it('names the cost-side upplupen account for a supplier invoice line', () => {
    const html = render({ direction: 'expense', account: '1790', targetAccount: '5010', end: '2026-09-30' })
    expect(html).toContain('Välj 2990 (upplupen) i stället')
  })

  it('shows the actual posting date for earlier months in a straddling period', () => {
    const html = render({ end: '2026-11-30' })
    expect(html).toContain('3 månader')
    expect(html).toContain('september 2026 till november 2026')
    expect(html).toContain('Tidigare månader bokförs 2026-10-26')
  })

  it('leaves an upplupen intäkt before the invoice month alone', () => {
    const html = render({ account: '1790', end: '2026-09-30' })
    expect(html).toContain('Hela beloppet bokförs i september 2026')
    expect(html).not.toContain('i stället')
  })

  it('keeps the plain preview for a deferral that starts in the invoice month', () => {
    const html = render({ start: '2026-10-01', end: '2026-12-31' })
    expect(html).toContain('oktober 2026 till december 2026')
    expect(html).not.toContain('Tidigare månader')
  })

  it('says the same in English', () => {
    const html = render({ end: '2026-09-30', locale: 'en' })
    expect(html).toContain('Choose 1790 (accrued) instead')
  })
})
