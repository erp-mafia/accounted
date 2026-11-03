'use client'

import { useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { RequestMorePaymentsDialog } from '@/components/payments/BankPaymentsAllowance'
import { SettingsGroup, SettingsRow, SettingsRowEnd, SettingsRowNote } from '@/components/settings/SettingsRows'
import { UsageLimitDialog } from '@/components/settings/UsageLimitDialog'
import { AttnLine } from '@/components/ui/attn-line'
import { Button } from '@/components/ui/button'
import { TD_CLASS, TH_CLASS } from '@/components/ui/dry-table'
import { Skeleton } from '@/components/ui/skeleton'
import { useCompany } from '@/contexts/CompanyContext'
import { useFormat } from '@/lib/hooks/use-format'
import { cn, formatCurrency } from '@/lib/utils'
import type { CompanyUsage, CompanyUsageLine } from '@/lib/usage/summary'

/**
 * Settings → Abonnemang → Användning: this month's use of each priced
 * service (GET /api/billing/usage), against what the month includes and the
 * price above it. A service the company has not used and that carries no
 * price is left out. The "Att betala" column and the arrears note show only
 * for a service that is billed: on offer (USAGE_BILLING_KINDS) and open for
 * the company.
 *
 * Below the table, each service on offer has its row: it stops at what is
 * included until the company asks for more (Begär fler) and a founder opens
 * the charge, which then holds month after month.
 */
export function UsagePanel() {
  const t = useTranslations('settings_billing')
  const locale = useLocale()
  const [usage, setUsage] = useState<CompanyUsage | null>(null)
  const [failed, setFailed] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let active = true
    async function load() {
      setFailed(false)
      setUsage(null)
      try {
        const res = await fetch('/api/billing/usage')
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const body = (await res.json()) as { data?: CompanyUsage }
        if (!active) return
        if (!body.data || !Array.isArray(body.data.lines)) throw new Error('Malformed response')
        setUsage(body.data)
      } catch {
        if (active) setFailed(true)
      }
    }
    void load()
    return () => {
      active = false
    }
  }, [reloadKey])

  if (failed) {
    return (
      <AttnLine action={{ label: t('load_retry'), onClick: () => setReloadKey((k) => k + 1) }}>{t('usage_load_failed')}</AttnLine>
    )
  }
  if (usage === null) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    )
  }

  const month = monthName(usage.period, locale)
  const lines = usage.lines.filter((line) => line.used > 0 || (line.unit_price_ore ?? 0) > 0)
  const anyBilled = lines.some((line) => line.billed)
  const offered = usage.lines.filter((line) => line.offered)

  if (lines.length === 0) return <p className="text-[13px] text-muted-foreground">{t('usage_empty', { month })}</p>

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <caption className="pb-2 text-left text-[13px] text-muted-foreground">{t('usage_caption', { month })}</caption>
          <thead>
            <tr>
              <th className={TH_CLASS}>{t('usage_col_service')}</th>
              <th className={cn(TH_CLASS, 'text-right')}>{t('usage_col_used')}</th>
              <th className={cn(TH_CLASS, 'text-right')}>{t('usage_col_included')}</th>
              <th className={cn(TH_CLASS, 'text-right')}>{t('usage_col_price')}</th>
              {anyBilled && <th className={cn(TH_CLASS, 'text-right')}>{t('usage_col_amount')}</th>}
            </tr>
          </thead>
          <tbody className="stagger-enter">
            {lines.map((line) => (
              <tr key={line.kind} className="transition-colors duration-150 hover:bg-secondary/35">
                <td className={TD_CLASS}>{t(`usage_kind_${line.kind}`)}</td>
                <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums')}>{line.used}</td>
                <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums')}>{includedCell(line, t)}</td>
                <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums')}>{priceCell(line, t)}</td>
                {anyBilled && (
                  <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums')}>
                    {line.billed ? formatCurrency(line.amount_ore / 100) : '–'}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {anyBilled && <p className="mt-3 text-[13px] text-muted-foreground">{t('usage_billed_note')}</p>}
      {offered.length > 0 && (
        <SettingsGroup className="mt-6" label={t('usage_charges_label')} help={t('usage_charges_help')}>
          {offered.map((line) => (
            <UsageChargeRow key={line.kind} line={line} paying={usage.paying} />
          ))}
        </SettingsGroup>
      )}
    </div>
  )
}

/**
 * One service on offer: stopping at what is included, with Begär fler, or
 * open at its price since a date. Nobody paying for the company (a trial)
 * stops it at what is included, and the row says so instead. Bank payments
 * ask through their own request, which also asks how many a month.
 */
function UsageChargeRow({ line, paying }: { line: CompanyUsageLine; paying: boolean }) {
  const t = useTranslations('settings_billing')
  const { role } = useCompany()
  const { formatDateLong } = useFormat()
  const [requesting, setRequesting] = useState(false)
  const price = formatCurrency((line.unit_price_ore ?? 0) / 100)
  const canRequest = paying && !line.accepted && role !== null

  return (
    <SettingsRow label={t(`usage_kind_${line.kind}`)}>
      <SettingsRowNote className="tabular-nums">
        {!paying
          ? t('usage_charge_needs_subscription', { included: line.included ?? 0, price })
          : line.accepted && line.accepted_at
            ? t('usage_charge_on', { price, included: line.included ?? 0, date: formatDateLong(line.accepted_at) })
            : t('usage_charge_off', { included: line.included ?? 0, price })}
      </SettingsRowNote>
      {canRequest && (
        <SettingsRowEnd>
          <Button size="sm" variant="outline" onClick={() => setRequesting(true)}>
            {t('usage_charge_request')}
          </Button>
        </SettingsRowEnd>
      )}
      {requesting &&
        (line.kind === 'bank_payment' ? (
          <RequestMorePaymentsDialog included={line.included} onOpenChange={setRequesting} />
        ) : (
          <UsageLimitDialog
            kind={line.kind}
            included={line.included ?? 0}
            unitPriceOre={line.unit_price_ore ?? 0}
            open={requesting}
            onOpenChange={setRequesting}
          />
        ))}
    </SettingsRow>
  )
}

type Translate = ReturnType<typeof useTranslations<'settings_billing'>>

function includedCell(line: CompanyUsageLine, t: Translate): string {
  if (line.included !== null) return String(line.included)
  return line.unit_price_ore === 0 ? t('usage_all_included') : '–'
}

function priceCell(line: CompanyUsageLine, t: Translate): string {
  if (line.unit_price_ore === null) return '–'
  if (line.unit_price_ore === 0) return t('usage_included')
  return t('usage_unit_price', { price: formatCurrency(line.unit_price_ore / 100) })
}

/** "oktober" / "October" for 2026-10, in the viewer's language. */
function monthName(period: string, locale: string): string {
  const [year, month] = period.split('-').map(Number)
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'sv-SE', { month: 'long', timeZone: 'UTC' }).format(
    new Date(Date.UTC(year, month - 1, 1)),
  )
}
