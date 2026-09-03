'use client'

import { useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { HOVER_REVEAL_CLASS, TD_CLASS, TH_CLASS } from '@/components/ui/dry-table'
import type { RegisterRow } from '@/lib/parties/register'
import { formatCurrency } from '@/lib/utils'
import { AccountNub } from './AccountNub'
import { isDuplicateCandidate, reasonText } from './format'

/**
 * Moment 2: the tier between observed and confirmed. Every row states why it
 * is here; only rows with a hard key arrive pre-ticked; bulk confirm opens
 * one dialog that says what happens.
 */
export function SuggestionQueue({
  rows,
  selected,
  canWrite,
  busy,
  onToggle,
  onSelectAll,
  onClear,
  onConfirmSelected,
  onDismiss,
  onOpen,
}: {
  rows: RegisterRow[]
  selected: Set<string>
  canWrite: boolean
  busy: boolean
  onToggle: (id: string) => void
  onSelectAll: () => void
  onClear: () => void
  onConfirmSelected: () => void
  onDismiss: (row: RegisterRow) => void
  onOpen: (id: string) => void
}) {
  const t = useTranslations('parties')
  const count = selected.size
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id))

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 text-[13px]">
        <span className="tabular-nums text-muted-foreground">{t('selected_n', { count })}</span>
        <span className="text-muted-foreground">{t('selected_hint')}</span>
        <div className="ml-auto flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={allSelected ? onClear : onSelectAll}
            disabled={rows.length === 0}
          >
            {allSelected ? t('deselect') : t('select_all')}
          </Button>
          <Button type="button" size="sm" onClick={onConfirmSelected} disabled={!canWrite || busy || count === 0}>
            {t('confirm_n', { count })}
          </Button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              <th className={`${TH_CLASS} w-8`} />
              <th className={TH_CLASS}>{t('th_name')}</th>
              <th className={TH_CLASS}>{t('th_why')}</th>
              <th className={TH_CLASS}>{t('th_account')}</th>
              <th className={`${TH_CLASS} text-right`}>{t('th_revenue')}</th>
              <th className={`${TH_CLASS} text-right`}>{t('th_expense')}</th>
              <th className={`${TH_CLASS} w-16`} />
            </tr>
          </thead>
          <tbody className="stagger-enter">
            {rows.map((row) => {
              const checked = selected.has(row.id)
              return (
                <tr key={row.id} className="group transition-colors duration-150 hover:bg-secondary/35">
                  <td className={`${TD_CLASS} w-8`}>
                    <Checkbox
                      checked={checked}
                      onCheckedChange={() => onToggle(row.id)}
                      aria-label={row.displayName}
                      disabled={!canWrite}
                    />
                  </td>
                  <td className={`${TD_CLASS} whitespace-nowrap`}>
                    <button
                      type="button"
                      className="text-left font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => onOpen(row.id)}
                      aria-label={t('open_dossier', { name: row.displayName })}
                    >
                      {row.displayName}
                    </button>
                    {isDuplicateCandidate(row) ? (
                      <Badge variant="warning" className="ml-2">
                        {t('chip_duplicate')}
                      </Badge>
                    ) : null}
                  </td>
                  <td className={`${TD_CLASS} text-muted-foreground`}>{reasonText(t, row.reason, row.stats?.rhythm ?? null)}</td>
                  <td className={TD_CLASS}>
                    <AccountNub account={row.stats?.dominantAccount ?? null} />
                  </td>
                  <td className={`${TD_CLASS} text-right tabular-nums`}>{row.stats?.revenueSek ? formatCurrency(row.stats.revenueSek) : ''}</td>
                  <td className={`${TD_CLASS} text-right tabular-nums`}>{row.stats?.expenseSek ? formatCurrency(row.stats.expenseSek) : ''}</td>
                  <td className={`${TD_CLASS} text-right`}>
                    <button
                      type="button"
                      className={`${HOVER_REVEAL_CLASS} text-xs text-muted-foreground underline-offset-2 hover:underline`}
                      onClick={() => onDismiss(row)}
                      disabled={!canWrite || busy}
                    >
                      {t('dismiss')}
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
