'use client'

import { Fragment } from 'react'
import { useTranslations } from 'next-intl'
import { EllipsisHorizontalIcon } from '@/components/icons'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { HOVER_REVEAL_CLASS, TD_CLASS, TH_CLASS } from '@/components/ui/dry-table'
import type { CounterpartRow } from '@/lib/parties/list'
import type { PartyRole } from '@/lib/parties/register'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { AccountChip } from './AccountChip'
import { BrandMark } from './BrandMark'
import { reasonText } from './format'
import { regionName } from './region-name'

// What named a reading, in the row's own words. A model reading has no key
// here: it says "läst ur texten" in the same muted place.
const WHY_KEY = { document: 'cp_why_document', directory: 'cp_why_directory', anchor: 'cp_why_anchor' } as const

function money(n: number): string {
  return n ? formatCurrency(n) : ''
}

/**
 * Motparter as one list. Every row is a counterpart, whoever named it: a
 * confirmed party, a suggestion not yet acted on ("ny"), or a name the
 * resolver read out of the bank text. Each row is one line: the name, a
 * chip only for an uncertain reading (convention 5), and what is known about
 * it as a muted suffix; the actions sit in the row menu, and nothing asks to
 * be confirmed before it can be used.
 *
 * The register comes first and the newly recognised follow, under headings
 * that appear only when both are on screen: a company whose counterparts are
 * all confirmed sees a plain register, and one that has only just been read
 * sees a plain list of readings. Neither needs to be told which it is.
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
  const confirmedCount = rows.filter((r) => r.status === 'confirmed').length
  const mixed = confirmedCount > 0 && confirmedCount < rows.length

  return (
    <div className="-mx-2 overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            <th className={`${TH_CLASS} w-full`}>{t('cp_th_name')}</th>
            <th className={TH_CLASS}>{t('cp_th_account')}</th>
            <th className={`${TH_CLASS} text-right`}>{t('cp_th_count')}</th>
            <th className={`${TH_CLASS} text-right`}>{t('cp_th_in')}</th>
            <th className={`${TH_CLASS} text-right`}>{t('cp_th_out')}</th>
            <th className={TH_CLASS}>{t('cp_th_last')}</th>
            <th className={`${TH_CLASS} w-10`} aria-hidden />
          </tr>
        </thead>
        <tbody className="stagger-enter">
          {rows.map((row, i) => {
            const mine = row.status === 'confirmed'
            // The register carries no heading: the column header already says
            // what the rows are. The recognised ones get a section break, on
            // their first row, only when the register is on screen above them.
            const startsNewGroup = mixed && !mine && (i === 0 || rows[i - 1]!.status === 'confirmed')
            const whyKey = !row.partyId && row.source ? WHY_KEY[row.source as keyof typeof WHY_KEY] : undefined
            const why =
              row.status === 'suggested' && row.reason
                ? reasonText(t, row.reason, row.rhythm, row.orgNumber)
                : whyKey
                  ? t(whyKey)
                  : row.status === 'read'
                    ? t('cp_status_read')
                    : null
            // A reading with no party has no dossier to open, so its why stays on the line.
            const detail = [row.what, row.rail ? t('cp_via', { rail: row.rail }) : null, row.country && row.country !== 'SE' ? regionName(row.country, locale) : null, row.partyId ? null : why]
              .filter(Boolean)
              .join(' · ')
            return (
              <Fragment key={row.id}>
              {startsNewGroup ? (
                <tr>
                  {/* What to do with them is in the page's "?" (cp_help). */}
                  <th colSpan={7} scope="colgroup" className="px-2 pb-2 pt-8 text-left text-[15px] font-medium leading-[22px] text-strong">
                    {t('cp_group_new', { count: rows.length - confirmedCount })}
                  </th>
                </tr>
              ) : null}
              <tr
                className={cn('group transition-colors duration-150 hover:bg-secondary/35', row.partyId && 'cursor-pointer')}
                onClick={(e) => {
                  if (!row.partyId) return
                  if ((e.target as HTMLElement).closest('button, [role=checkbox], [role=menu], a, input')) return
                  onOpen(row)
                }}
              >
                {/* One line (convention 4): the name keeps its width and the
                    muted detail takes what is left, so neither wraps nor
                    widens the table (the w-full max-w-0 column trick). */}
                <td className={`${TD_CLASS} w-full max-w-0 min-w-[260px]`}>
                  <div className="flex min-w-0 items-center gap-2">
                    <BrandMark name={row.name} className="shrink-0" />
                    {row.partyId ? (
                      <button type="button" className="min-w-0 truncate text-left text-foreground hover:underline underline-offset-4" onClick={() => onOpen(row)}>
                        {row.name}
                      </button>
                    ) : (
                      <span className="min-w-0 truncate text-foreground">{row.name}</span>
                    )}
                    {row.status === 'tentative' ? (
                      <Badge variant="warning" className="shrink-0 font-normal">
                        {t('cp_status_tentative')}
                      </Badge>
                    ) : null}
                    {detail ? <span className="min-w-0 flex-1 basis-0 truncate text-xs text-muted-foreground">{detail}</span> : null}
                  </div>
                </td>
                <td className={TD_CLASS}>
                  {row.account ? <AccountChip account={row.account} name={row.accountName} /> : null}
                </td>
                <td className={`${TD_CLASS} text-right tabular-nums text-muted-foreground`}>{row.count || ''}</td>
                <td className={`${TD_CLASS} text-right tabular-nums`}>{money(row.inSek)}</td>
                <td className={`${TD_CLASS} text-right tabular-nums`}>{money(row.outSek)}</td>
                <td className={`${TD_CLASS} date-figures whitespace-nowrap text-muted-foreground`}>{row.lastSeen ? formatDate(row.lastSeen) : ''}</td>
                {/* py-2: the 28px menu button sits centred in the 44px row. */}
                <td className={`${TD_CLASS} py-2 text-right`}>
                  {canWrite ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className={cn(HOVER_REVEAL_CLASS, 'data-[state=open]:opacity-100')} aria-label={row.name}>
                          <EllipsisHorizontalIcon className="h-4 w-4" />
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
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
