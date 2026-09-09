'use client'

import { useTranslations } from 'next-intl'
import { MoreHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { HOVER_REVEAL_CLASS, TD_CLASS, TH_CLASS } from '@/components/ui/dry-table'
import type { CounterpartRow } from '@/lib/parties/list'
import type { PartyRole } from '@/lib/parties/register'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { AccountChip } from './AccountChip'
import { BrandMark } from './BrandMark'
import { reasonText } from './format'
import { regionName } from './SuggestionQueue'

// What named a reading, in the row's own words. A model reading says
// nothing here: its chip ("läst ur texten") already does.
const WHY_KEY = { document: 'cp_why_document', directory: 'cp_why_directory', anchor: 'cp_why_anchor' } as const

function money(n: number): string {
  return n ? formatCurrency(n) : ''
}

/**
 * Motparter as one list. Every row is a counterpart, whoever named it: a
 * confirmed party, a suggestion not yet acted on ("ny"), or a name the
 * resolver read out of the bank text. The state sits in a quiet chip, the
 * actions in the row menu, and nothing asks to be confirmed before it can
 * be used.
 */
export function CounterpartList({
  rows,
  locale,
  canWrite,
  onOpen,
  onRename,
  onNotSame,
  onMerge,
  onPromote,
  onDismiss,
}: {
  rows: CounterpartRow[]
  locale: string
  canWrite: boolean
  onOpen: (row: CounterpartRow) => void
  onRename: (row: CounterpartRow) => void
  onNotSame: (row: CounterpartRow) => void
  onMerge: (row: CounterpartRow) => void
  onPromote: (row: CounterpartRow, roles: PartyRole[]) => void
  onDismiss: (row: CounterpartRow) => void
}) {
  const t = useTranslations('parties')

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            <th className={TH_CLASS}>{t('cp_th_name')}</th>
            <th className={TH_CLASS}>{t('cp_th_account')}</th>
            <th className={`${TH_CLASS} text-right`}>{t('cp_th_count')}</th>
            <th className={`${TH_CLASS} text-right`}>{t('cp_th_in')}</th>
            <th className={`${TH_CLASS} text-right`}>{t('cp_th_out')}</th>
            <th className={TH_CLASS}>{t('cp_th_last')}</th>
            <th className={`${TH_CLASS} w-10`} aria-hidden />
          </tr>
        </thead>
        <tbody className="stagger-enter">
          {rows.map((row) => {
            const whyKey = !row.partyId && row.source ? WHY_KEY[row.source as keyof typeof WHY_KEY] : undefined
            const why = row.status === 'suggested' && row.reason ? reasonText(t, row.reason, row.rhythm, row.orgNumber) : whyKey ? t(whyKey) : null
            const detail = [row.what, row.rail ? t('cp_via', { rail: row.rail }) : null, row.country && row.country !== 'SE' ? regionName(row.country, locale) : null, why]
              .filter(Boolean)
              .join(' · ')
            const chip =
              row.status === 'suggested' ? t('cp_status_suggested') : row.status === 'read' ? t('cp_status_read') : row.status === 'tentative' ? t('cp_status_tentative') : null
            return (
              <tr key={row.id} className="group transition-colors duration-150 hover:bg-secondary/35">
                <td className={`${TD_CLASS} min-w-[260px]`}>
                  <div className="flex items-start gap-2.5">
                    <BrandMark name={row.name} className="mt-0.5" />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        {row.partyId ? (
                          <button type="button" className="truncate text-left text-foreground hover:underline underline-offset-4" onClick={() => onOpen(row)}>
                            {row.name}
                          </button>
                        ) : (
                          <span className="truncate text-foreground">{row.name}</span>
                        )}
                        {chip ? (
                          <span
                            className={cn(
                              'rounded-full border border-border px-2 py-0.5 text-[11px] leading-none whitespace-nowrap',
                              row.status === 'tentative' ? 'text-warning' : 'text-muted-foreground',
                            )}
                          >
                            {chip}
                          </span>
                        ) : null}
                      </div>
                      {detail ? <div className="truncate text-[12px] text-muted-foreground">{detail}</div> : null}
                    </div>
                  </div>
                </td>
                <td className={TD_CLASS}>
                  <AccountChip account={row.account} />
                </td>
                <td className={`${TD_CLASS} text-right tabular-nums text-muted-foreground`}>{row.count || ''}</td>
                <td className={`${TD_CLASS} text-right tabular-nums`}>{money(row.inSek)}</td>
                <td className={`${TD_CLASS} text-right tabular-nums`}>{money(row.outSek)}</td>
                <td className={`${TD_CLASS} whitespace-nowrap text-muted-foreground`}>{row.lastSeen ? formatDate(row.lastSeen) : ''}</td>
                <td className={`${TD_CLASS} text-right`}>
                  {canWrite ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className={cn('h-7 w-7', HOVER_REVEAL_CLASS, 'data-[state=open]:opacity-100')} aria-label={row.name}>
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {row.partyId ? <DropdownMenuItem onSelect={() => onOpen(row)}>{t('cp_menu_open')}</DropdownMenuItem> : null}
                        {row.aliasKeys.length ? <DropdownMenuItem onSelect={() => onRename(row)}>{t('cp_menu_rename')}</DropdownMenuItem> : null}
                        {row.partyId ? <DropdownMenuItem onSelect={() => onMerge(row)}>{t('cp_menu_merge')}</DropdownMenuItem> : null}
                        {row.status === 'suggested' ? (
                          <>
                            <DropdownMenuSeparator />
                            {!row.roles.includes('supplier') ? <DropdownMenuItem onSelect={() => onPromote(row, ['supplier'])}>{t('cp_menu_promote_supplier')}</DropdownMenuItem> : null}
                            {!row.roles.includes('customer') ? <DropdownMenuItem onSelect={() => onPromote(row, ['customer'])}>{t('cp_menu_promote_customer')}</DropdownMenuItem> : null}
                            <DropdownMenuItem onSelect={() => onDismiss(row)}>{t('cp_menu_dismiss')}</DropdownMenuItem>
                          </>
                        ) : null}
                        {!row.partyId && row.aliasKeys.length ? (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onSelect={() => onNotSame(row)}>{t('cp_menu_not_same')}</DropdownMenuItem>
                          </>
                        ) : null}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
