'use client'

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { CheckIcon, MagnifyingGlassIcon } from '@/components/icons'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { FlowAffiliate } from '../connect-flow-reducer'

interface AffiliatePickerProps {
  /** The bank behind the shared BIC (Swedbank): the first row, chosen when no sparbank is. */
  parentName: string
  /** The bank needs one of its offices (bank-help bankRequiresOffice): no row of its own, and "Vilket kontor?". */
  officeRequired?: boolean
  affiliates: ReadonlyArray<FlowAffiliate>
  value: FlowAffiliate | null
  onChange: (affiliate: FlowAffiliate | null) => void
}

function matches(name: string, query: string): boolean {
  return name.toLowerCase().includes(query)
}

/**
 * "Vilken sparbank?": the savings banks reached through a shared BIC, as a
 * searchable list under the bank list. The bank itself is the first row and
 * the default, so a Swedbank customer changes nothing; a sparbank customer
 * types a few letters and picks theirs. A bank that takes no request for
 * itself has no row of its own: "Vilket kontor?" lists only its offices, and
 * nothing is chosen until the person picks one. The choice travels as the
 * party's affiliated_aspsp_id and names the connection.
 */
export function AffiliatePicker({ parentName, officeRequired = false, affiliates, value, onChange }: AffiliatePickerProps) {
  const t = useTranslations('bank_connect')
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const shown = useMemo(() => {
    const sorted = [...affiliates].sort((a, b) => a.name.localeCompare(b.name, 'sv'))
    return needle ? sorted.filter((a) => matches(a.name, needle)) : sorted
  }, [affiliates, needle])
  const parentShown = !officeRequired && (!needle || matches(parentName, needle))
  const heading = officeRequired ? t('office_label') : t('affiliate_label')
  const searchLabel = officeRequired ? t('office_search') : t('affiliate_search')

  const row = (key: string, label: string, selected: boolean, onClick: () => void) => (
    <button
      key={key}
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onClick}
      className={cn(
        'flex min-h-10 w-full items-center justify-between gap-3 px-1 py-2 text-left text-[13px] transition-colors duration-150 hover:bg-secondary/60',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
        selected && 'bg-secondary/60',
      )}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {selected && <CheckIcon className="h-4 w-4 shrink-0" aria-hidden="true" />}
    </button>
  )

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-[13px]">
        <span id="bank-connect-affiliate-label" className="text-muted-foreground">
          {heading}
        </span>
        <div className="relative">
          <MagnifyingGlassIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            type="search"
            autoComplete="off"
            placeholder={searchLabel}
            aria-label={searchLabel}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-8 w-[200px] pl-10"
          />
        </div>
      </div>
      {/* max-h-60 is six 40px rows: a scroll box with a reason. */}
      <div role="listbox" aria-labelledby="bank-connect-affiliate-label" className="max-h-60 divide-y divide-border overflow-y-auto overscroll-contain border-y border-border">
        {parentShown && row('parent', parentName, value === null, () => onChange(null))}
        {shown.map((affiliate) => row(affiliate.id, affiliate.name, value?.id === affiliate.id, () => onChange(affiliate)))}
        {!parentShown && shown.length === 0 && <p className="px-1 py-6 text-center text-[13px] text-muted-foreground">{officeRequired ? t('office_no_matches') : t('affiliate_no_matches')}</p>}
      </div>
    </div>
  )
}
