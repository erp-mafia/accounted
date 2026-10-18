'use client'

import { useLocale, useTranslations } from 'next-intl'
import { BrandMark } from '@/components/parties/BrandMark'
import type { Expectation } from '@/lib/inkorg/expectations'
import { shortDate } from '@/lib/inkorg/dates'
import { readableName } from '@/lib/inkorg/names'
import { formatCurrency } from '@/lib/utils'
import { Fold } from './motion'
import { RowTitle } from './row-parts'

/**
 * Väntas senare: what the company's regular suppliers usually send in the
 * coming weeks, folded away under Saknar underlag. One row each: who (with
 * their mark) over around when, how it usually comes and the usual amount.
 * Nothing to do here: when the document comes it shows up under Behöver dig
 * like anything else.
 */
export function ExpectedLaterList({ expectations }: { expectations: Expectation[] }) {
  const t = useTranslations('inkorg')
  return (
    <Fold
      buttonClassName="px-2 py-2"
      label={
        <span className="flex items-baseline gap-2 font-sans">
          <span>{t('expected_title')}</span>
          <span className="text-[12.5px] font-normal tabular-nums text-muted-foreground">{expectations.length}</span>
        </span>
      }
    >
      <p className="mb-2 px-2 text-[12.5px] text-muted-foreground">{t('expected_body')}</p>
      <ul className="border-t border-border">
        {expectations.map((expectation) => (
          <ExpectedRow key={expectation.key} expectation={expectation} />
        ))}
      </ul>
    </Fold>
  )
}

function ExpectedRow({ expectation }: { expectation: Expectation }) {
  const t = useTranslations('inkorg')
  const locale = useLocale()
  const when = t('expected_around', { date: shortDate(expectation.expected_on, locale) })

  const how =
    expectation.door === 'portal' && expectation.portal
      ? t('missing_portal', { vendor: expectation.portal.vendor })
      : expectation.door === 'peppol'
        ? t('expected_door_peppol')
        : expectation.door === 'intake_email'
          ? t('expected_door_intake_email')
          : expectation.door === 'mailbox'
            ? t('expected_door_mailbox')
            : expectation.door === 'whatsapp'
              ? t('expected_door_whatsapp')
              : expectation.door === 'upload'
                ? t('expected_door_upload')
                : expectation.door === 'mcp'
                  ? t('expected_door_mcp')
                  : ''

  // Whole kronor: an expected amount is a usual one, never an exact one. "ca" when it varies.
  const amount = expectation.amount
    ? expectation.amount.min === expectation.amount.max
      ? formatCurrency(expectation.amount.usual, 'SEK', { maximumFractionDigits: 0 })
      : t('expected_about', { amount: formatCurrency(expectation.amount.usual, 'SEK', { maximumFractionDigits: 0 }) })
    : ''

  return (
    <li className="grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-x-3 border-b border-border px-2 py-3 text-[13px] sm:grid-cols-[28px_minmax(8rem,15rem)_minmax(0,1fr)_7.5rem_1rem] sm:gap-x-4">
      <BrandMark name={expectation.counterparty} variant="mark" size={28} logoUrl={expectation.logo_url} />
      <RowTitle name={readableName(expectation.counterparty)} meta={when} />
      <span className="hidden truncate text-muted-foreground sm:block">{how}</span>
      <span data-ph-mask="" className="text-right tabular-nums text-muted-foreground">
        {amount}
      </span>
      <span aria-hidden="true" className="hidden sm:block" />
    </li>
  )
}
