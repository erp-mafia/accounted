'use client'

import { useLocale, useTranslations } from 'next-intl'
import { Check, ChevronDown } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { HOVER_REVEAL_CLASS, QUIET_LINK_CLASS, TD_CLASS, TH_CLASS } from '@/components/ui/dry-table'
import type { PartyRole, RegisterRow } from '@/lib/parties/register'
import { formatCurrency } from '@/lib/utils'
import { AccountChip } from './AccountChip'
import { AccountNub } from './AccountNub'
import { isDuplicateCandidate, rolesLabel } from './format'

/**
 * The queue in front of Leverantörer and Kunder. Every row states why it is
 * here and what it becomes; only rows with a hard key arrive pre-ticked;
 * bulk confirm opens one dialog that says what happens.
 */
/** A party the voucher text places abroad: SCB cannot hold it, so no search is offered. */
export function isForeign(row: { country: string | null }): boolean {
  return !!row.country && row.country !== 'SE'
}

export function regionName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code) ?? code
  } catch {
    return code
  }
}

export function SuggestionQueue({
  rows,
  selected,
  roles,
  canWrite,
  busy,
  onToggle,
  onSelectAll,
  onClear,
  onRoles,
  onConfirmSelected,
  onDismiss,
  onOpen,
  dense = false,
}: {
  rows: RegisterRow[]
  selected: Set<string>
  roles: (row: RegisterRow) => PartyRole[]
  canWrite: boolean
  busy: boolean
  onToggle: (id: string) => void
  onSelectAll: () => void
  onClear: () => void
  onRoles: (id: string, roles: PartyRole[]) => void
  onConfirmSelected: () => void
  onDismiss: (row: RegisterRow) => void
  onOpen: (id: string) => void
  /** Open the SCB picker for a row without an org number; undefined hides the link. */
  /**
   * Shell v2: one line per row, the selection actions in a floating bar that
   * appears with the first tick, and the near-duplicate hint as a muted
   * word instead of a warning chip.
   */
  dense?: boolean
}) {
  const t = useTranslations('parties')
  const locale = useLocale()
  const count = selected.size
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id))
  const td = dense ? `${TD_CLASS} !py-[7px] align-middle` : TD_CLASS

  function toggleRole(row: RegisterRow, role: PartyRole) {
    const current = roles(row)
    const next = current.includes(role) ? current.filter((r) => r !== role) : [...current, role]
    if (next.length === 0) return
    onRoles(row.id, next)
  }

  return (
    <div className={dense ? 'space-y-2' : 'space-y-4'}>
      {dense ? (
        <>
          {/* Selection actions float: the header checkbox selects every row,
              and the bar below carries the rest. Nothing sits above the table. */}
          {count > 0 && (
            <div className="fixed bottom-4 left-1/2 z-30 flex -translate-x-1/2 items-center gap-x-5 whitespace-nowrap rounded-full border border-border bg-background px-4 py-2 text-[12.5px] shadow-lg animate-fade-in md:left-[calc(50%+var(--nav-w)/2)]">
              <span className="tabular-nums">
                <strong className="font-semibold">{count}</strong> {t('selected_n', { count }).replace(/^\d+\s*/, '')}
              </span>
              <Button type="button" size="sm" onClick={onConfirmSelected} disabled={!canWrite || busy}>
                {t('promote_n', { count })}
              </Button>
              {!allSelected && (
                <button type="button" className={QUIET_LINK_CLASS} onClick={onSelectAll}>
                  {t('select_all')}
                </button>
              )}
              <button type="button" className={QUIET_LINK_CLASS} onClick={onClear}>
                {t('deselect')}
              </button>
            </div>
          )}
        </>
      ) : (
      <div className="flex flex-wrap items-center gap-3 text-[13px]">
        <span className="tabular-nums text-muted-foreground">{t('selected_n', { count })}</span>
        <span className="text-muted-foreground">{t('selected_hint')}</span>
        <div className="ml-auto flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={allSelected ? onClear : onSelectAll} disabled={rows.length === 0}>
            {allSelected ? t('deselect') : t('select_all')}
          </Button>
          <Button type="button" size="sm" onClick={onConfirmSelected} disabled={!canWrite || busy || count === 0}>
            {t('promote_n', { count })}
          </Button>
        </div>
      </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              <th className={`${TH_CLASS} w-8`}>
                {dense && rows.length > 0 && (
                  <Checkbox
                    checked={allSelected ? true : count > 0 ? 'indeterminate' : false}
                    onCheckedChange={() => (allSelected ? onClear() : onSelectAll())}
                    aria-label={allSelected ? t('deselect') : t('select_all')}
                    disabled={!canWrite}
                  />
                )}
              </th>
              <th className={TH_CLASS}>{t('th_name')}</th>
              <th className={TH_CLASS}>{t('th_becomes')}</th>
              <th className={TH_CLASS}>{t('th_account')}</th>
              <th className={`${TH_CLASS} text-right`}>{t('th_revenue')}</th>
              <th className={`${TH_CLASS} text-right`}>{t('th_expense')}</th>
              <th className={`${TH_CLASS} w-16`} />
            </tr>
          </thead>
          <tbody className="stagger-enter">
            {rows.map((row) => {
              const checked = selected.has(row.id)
              const current = roles(row)
              return (
                <tr
                  key={row.id}
                  className="group cursor-pointer transition-colors duration-150 hover:bg-secondary/35"
                  onClick={(e) => {
                    // The row opens the dossier; its own controls (checkbox,
                    // role menu, dismiss) keep their click.
                    if ((e.target as HTMLElement).closest('button, [role=checkbox], [role=menu], a, input')) return
                    onOpen(row.id)
                  }}
                >
                  <td className={`${td} w-8`}>
                    <Checkbox checked={checked} onCheckedChange={() => onToggle(row.id)} aria-label={row.displayName} disabled={!canWrite} />
                  </td>
                  <td className={`${td} max-w-[22rem]`}>
                    <div className="flex min-w-0 items-center gap-1.5">
                    <button
                      type="button"
                      className="min-w-0 truncate text-left font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => onOpen(row.id)}
                      aria-label={t('open_dossier', { name: row.displayName })}
                      title={row.displayName}
                    >
                      {row.displayName}
                    </button>
                    {!dense && isDuplicateCandidate(row) ? (
                      <Badge variant="warning" className="shrink-0">
                        {t('chip_duplicate')}
                      </Badge>
                    ) : null}
                    {isForeign(row) ? (
                      <span
                        className="inline-flex shrink-0 items-center rounded-full border border-border px-1.5 text-[10.5px] text-foreground"
                        title={t('row_foreign', { country: regionName(row.country as string, locale) })}
                      >
                        {row.country}
                      </span>
                    ) : null}
                    </div>
                  </td>
                  <td className={`${td} whitespace-nowrap`}>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:text-muted-foreground"
                          disabled={!canWrite}
                          aria-label={t('becomes_aria', { name: row.displayName })}
                        >
                          {rolesLabel(t, current)}
                          <ChevronDown className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start">
                        {(['supplier', 'customer'] as const).map((role) => (
                          <DropdownMenuItem key={role} onSelect={(e) => { e.preventDefault(); toggleRole(row, role) }} className="gap-2">
                            <Check className={`h-3.5 w-3.5 ${current.includes(role) ? '' : 'invisible'}`} aria-hidden="true" />
                            {role === 'supplier' ? t('role_supplier') : t('role_customer')}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </td>
                  <td className={td}>
                    {dense ? <AccountChip account={row.stats?.dominantAccount ?? null} name={row.stats?.dominantAccountName ?? null} /> : <AccountNub account={row.stats?.dominantAccount ?? null} />}
                  </td>
                  <td className={`${td} text-right tabular-nums`}>{row.stats?.revenueSek ? formatCurrency(row.stats.revenueSek) : ''}</td>
                  <td className={`${td} text-right tabular-nums`}>{row.stats?.expenseSek ? formatCurrency(row.stats.expenseSek) : ''}</td>
                  <td className={`${td} text-right`}>
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
