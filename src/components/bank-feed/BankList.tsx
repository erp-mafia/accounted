'use client'

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { BuildingLibraryIcon, ChevronRightIcon, MagnifyingGlassIcon } from '@/components/icons'
import { Input } from '@/components/ui/input'
import { LateReveal, Skeleton } from '@/components/ui/skeleton'
import { bankLogoUrl } from '@/lib/cash-accounts/bank-logos'
import { bankMatchesQuery, searchAliasHint } from '@/lib/bank-sync/bank-search'
import { cn } from '@/lib/utils'
import { bankSigningApproach, orderBanks } from './bank-help'
import type { OpenPaymentsBank } from './open-payments-client'

/**
 * 28px mark for a bank row: our own brand icon when we have one, the
 * provider's logo otherwise, a landmark when neither. Real logos are drawn
 * for white, so they sit on a white chip.
 */
export function OpenPaymentsBankMark({ bank, size = 28 }: { bank: Pick<OpenPaymentsBank, 'name' | 'logo_url'>; size?: number }) {
  const src = bankLogoUrl(bank.name) ?? bank.logo_url
  return (
    <span
      className={cn('grid shrink-0 place-items-center overflow-hidden', src ? 'bg-white' : 'bg-secondary')}
      style={{ width: size, height: size }}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" aria-hidden="true" className="h-full w-full object-contain p-[3px]" />
      ) : (
        <BuildingLibraryIcon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
      )}
    </span>
  )
}

interface BankListProps {
  banks: OpenPaymentsBank[] | null
  selectedBic: string | null
  onPick: (bank: OpenPaymentsBank) => void
}

/**
 * The searchable bank list of the Koppla banken flow: popular banks first,
 * hairline rows of 48px with the bank's mark. A bank that signs only on its
 * own page is choosable with one muted line saying the person comes back
 * here; a bank we cannot sign at either way is listed but not choosable.
 */
export function BankList({ banks, selectedBic, onPick }: BankListProps) {
  const t = useTranslations('bank_connect')
  const [query, setQuery] = useState('')

  const shown = useMemo(() => {
    if (!banks) return []
    return orderBanks(banks.filter((bank) => bankMatchesQuery(bank, query)))
  }, [banks, query])
  const aliasHint = searchAliasHint(shown, query)

  return (
    <div className="space-y-3">
      <div className="relative">
        <MagnifyingGlassIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input
          type="search"
          autoComplete="off"
          placeholder={t('bank_search')}
          aria-label={t('bank_search')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="pl-10"
        />
      </div>

      {banks === null ? (
        <LateReveal role="status" className="space-y-1 py-1">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex items-center gap-3 py-2" aria-hidden="true">
              <Skeleton className="h-7 w-7 shrink-0" />
              <Skeleton className="h-4 w-40" />
            </div>
          ))}
          <span className="sr-only">{t('bank_loading')}</span>
        </LateReveal>
      ) : shown.length === 0 ? (
        <p className="px-1 py-6 text-center text-[13px] text-muted-foreground">{t('bank_no_matches')}</p>
      ) : (
        // max-h-96 is exactly eight 48px rows: a scroll box with a reason.
        <div role="listbox" aria-label={t('bank_search')} className="max-h-96 divide-y divide-border overflow-y-auto overscroll-contain border-y border-border">
          {shown.map((bank) => {
            const approach = bankSigningApproach(bank)
            const selectable = approach !== 'none'
            const selected = bank.bic === selectedBic
            return (
              <button
                key={`${bank.bic}:${bank.name}`}
                type="button"
                role="option"
                aria-selected={selected}
                aria-disabled={!selectable || undefined}
                onClick={() => {
                  if (selectable) onPick(bank)
                }}
                className={cn(
                  'flex w-full items-center gap-3 px-1 py-2 text-left transition-colors duration-150',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                  selectable ? 'hover:bg-secondary/60' : 'cursor-not-allowed',
                  selected && 'bg-secondary/60',
                )}
              >
                <OpenPaymentsBankMark bank={bank} />
                <span className="min-w-0 flex-1">
                  <span className={cn('block truncate text-[13px]', selectable ? 'text-foreground' : 'text-muted-foreground')}>{bank.name}</span>
                  {approach === 'redirect' && <span className="block truncate text-xs text-muted-foreground">{t('bank_redirect_only')}</span>}
                  {!selectable && <span className="block truncate text-xs text-muted-foreground">{t('bank_not_connectable')}</span>}
                </span>
                {selectable && <ChevronRightIcon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
              </button>
            )
          })}
        </div>
      )}

      {aliasHint && <p className="px-1 text-xs leading-relaxed text-muted-foreground">{t('bank_alias_hint', { product: aliasHint.product, bank: aliasHint.bank })}</p>}
    </div>
  )
}
