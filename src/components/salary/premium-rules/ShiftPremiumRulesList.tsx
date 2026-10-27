'use client'

import { useLocale, useTranslations } from 'next-intl'
import { EllipsisHorizontalIcon } from '@/components/icons'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { cn, formatCurrency } from '@/lib/utils'
import type { ShiftPremiumRule } from '@/types'

/** Days ahead within which an ending rule gets the one exception chip. */
const ENDS_SOON_DAYS = 31

function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

function decimal(value: number): string {
  return value.toLocaleString('sv-SE', { maximumFractionDigits: 2 })
}

type Translate = ReturnType<typeof useTranslations<'premium_rules'>>

/**
 * Weekdays as the shortest reading: runs of two or more as "Mån-fre",
 * the rest listed, every day as "Alla dagar", a holiday rule as "Helgdagar".
 */
function describeDays(rule: ShiftPremiumRule, t: Translate, lowerRest: boolean): string {
  if (rule.item_type === 'ob_holiday') return t('days_holidays')
  const days = [...new Set(rule.day_of_week)].sort((a, b) => a - b)
  if (days.length === 7) return t('days_all')
  const parts: string[] = []
  let i = 0
  while (i < days.length) {
    let j = i
    while (j + 1 < days.length && days[j + 1] === days[j] + 1) j++
    parts.push(j > i ? `${t(`wd_${days[i]}`)}-${t(`wd_${days[j]}`)}` : t(`wd_${days[i]}`))
    i = j + 1
  }
  const text = parts.join(', ')
  return lowerRest ? text.charAt(0) + text.slice(1).toLocaleLowerCase('sv-SE') : text
}

function describeAmount(rule: ShiftPremiumRule, t: Translate): string {
  if (rule.amount_form === 'monthly_divisor') {
    return t('amount_divisor', { divisor: decimal(rule.monthly_divisor ?? 0) })
  }
  if (rule.amount_form === 'sek_per_hour') {
    return t('amount_sek', { amount: formatCurrency(rule.sek_per_hour ?? 0) })
  }
  const percent = decimal(rule.premium_percent ?? 0)
  return rule.hourly_divisor
    ? t('amount_percent_divisor', { percent, divisor: decimal(rule.hourly_divisor) })
    : t('amount_percent', { percent })
}

export type PremiumRuleState = 'current' | 'ends_soon' | 'ended' | 'off'

export function premiumRuleState(rule: ShiftPremiumRule, today: string): PremiumRuleState {
  if (!rule.is_active) return 'off'
  if (rule.valid_to && rule.valid_to < today) return 'ended'
  if (rule.valid_to && rule.valid_to <= addDays(today, ENDS_SOON_DAYS)) return 'ends_soon'
  return 'current'
}

/** The rule as one line: name · days and window · amount · validity · scope. */
export function premiumRuleSentence(
  rule: ShiftPremiumRule,
  t: Translate,
  options: { today: string; lowerRest: boolean },
): string {
  const state = premiumRuleState(rule, options.today)
  const fullDay = rule.start_time.slice(0, 5) === rule.end_time.slice(0, 5)
  const when = fullDay
    ? describeDays(rule, t, options.lowerRest)
    : `${describeDays(rule, t, options.lowerRest)} ${t('time_range', {
        start: rule.start_time.slice(0, 5),
        end: rule.end_time.slice(0, 5),
      })}`
  // An ending rule shows its end in the chip, so the line keeps the start only.
  const validTo = state === 'ends_soon' ? null : rule.valid_to
  const validity =
    rule.valid_from && validTo
      ? t('validity_range', { from: rule.valid_from, to: validTo })
      : rule.valid_from
        ? t('validity_from', { from: rule.valid_from })
        : validTo
          ? t('validity_to', { to: validTo })
          : null
  const parts = [rule.name, when, describeAmount(rule, t), validity]
  if (!rule.applies_to_all_employees) parts.push(t('scope_named', { count: rule.applies_to_employee_ids.length }))
  if (state === 'off') parts.push(t('state_off'))
  return parts.filter(Boolean).join(' · ')
}

/** Current and upcoming rules first, then those that ended or are switched off. */
function displayOrder(rules: ShiftPremiumRule[], today: string): ShiftPremiumRule[] {
  const muted = (rule: ShiftPremiumRule) => {
    const state = premiumRuleState(rule, today)
    return state === 'off' || state === 'ended' ? 1 : 0
  }
  return [...rules].sort(
    (a, b) =>
      muted(a) - muted(b) ||
      a.name.localeCompare(b.name, 'sv') ||
      (a.valid_from ?? '').localeCompare(b.valid_from ?? ''),
  )
}

interface ShiftPremiumRulesListProps {
  rules: ShiftPremiumRule[]
  loading?: boolean
  canWrite: boolean
  /** Today's date (YYYY-MM-DD), for the muted and ending states. */
  today: string
  onNew: () => void
  onEdit: (rule: ShiftPremiumRule) => void
  onToggleActive: (rule: ShiftPremiumRule) => void
  onDelete: (rule: ShiftPremiumRule) => void
}

/**
 * The rule list as sentences, one line per rule (convention 4). A rule that
 * ended or is switched off reads muted; the only chip is the exception of a
 * rule that ends within a month. Row actions sit behind the row's menu, and
 * "Ny regel" is the one action of the group.
 */
export function ShiftPremiumRulesList({
  rules,
  loading = false,
  canWrite,
  today,
  onNew,
  onEdit,
  onToggleActive,
  onDelete,
}: ShiftPremiumRulesListProps) {
  const t = useTranslations('premium_rules')
  const lowerRest = useLocale() === 'sv'

  if (loading) {
    return (
      <div className="space-y-3 py-3">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    )
  }

  if (rules.length === 0) {
    return (
      <EmptyState
        className="py-8"
        title={t('empty_title')}
        description={null}
        actionLabel={canWrite ? t('new') : undefined}
        onAction={canWrite ? onNew : undefined}
      />
    )
  }

  return (
    <div>
      <ul className="stagger-enter text-[13px]">
        {displayOrder(rules, today).map((rule) => {
          const state = premiumRuleState(rule, today)
          const muted = state === 'off' || state === 'ended'
          return (
            <li key={rule.id} className="flex min-h-10 items-center gap-3 border-b border-border py-2">
              <span
                className={cn('min-w-0 flex-1 truncate tabular-nums', muted && 'text-muted-foreground')}
                title={premiumRuleSentence(rule, t, { today, lowerRest })}
              >
                {premiumRuleSentence(rule, t, { today, lowerRest })}
              </span>
              {state === 'ends_soon' && rule.valid_to ? (
                <Badge variant="outline" className="shrink-0 tabular-nums">
                  {t('ends_on', { date: rule.valid_to })}
                </Badge>
              ) : null}
              {canWrite ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label={t('row_menu', { name: rule.name })}>
                      <EllipsisHorizontalIcon className="h-[15px] w-[15px]" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => onEdit(rule)}>{t('edit')}</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => onToggleActive(rule)}>
                      {rule.is_active ? t('switch_off') : t('switch_on')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => onDelete(rule)}>{t('delete')}</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </li>
          )
        })}
      </ul>
      {canWrite ? (
        <div className="flex justify-end pt-3">
          <Button type="button" size="sm" onClick={onNew}>
            {t('new')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
