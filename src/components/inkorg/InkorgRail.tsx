'use client'

import type { ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { CircleAlert, FileQuestion, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { BrandMark } from '@/components/parties/BrandMark'
import { cn } from '@/lib/utils'
import { viewKey, type DoorRow, type InkorgView } from '@/lib/inkorg/items'
import type { PortalRow } from '@/lib/inkorg/portals'
import { DoorMark, useDoorName, type MailProvider } from './door-icon'

/** A section label in the rail: the body face, small, tracked capitals. */
const SECTION_LABEL_CLASS = 'font-sans text-[11px] font-medium uppercase tracking-wider text-muted-foreground'

/**
 * The rail beside the content (the app's sidebar stays): the two views,
 * then Brevlådor, one row per door in use, each a filter and each wearing
 * its mark (Gmail, WhatsApp, Peppol, Kivra, Billo) or its glyph on the quiet
 * chip (the intake address, an upload, the API), then Portaler, one row per
 * supplier whose invoices wait behind a login, each opening Saknar underlag
 * for that supplier. The + beside Brevlådor opens Lägg till brevlåda;
 * Portaler has none, since a portal comes from the portal directory and not
 * from anything a company connects. On a phone the same rows are a strip of
 * pills above the list.
 */
export function InkorgRail({
  view,
  onView,
  needCount,
  missingCount,
  doors,
  portals,
  onAddMailbox,
  mailProvider = null,
  className,
}: {
  view: InkorgView
  onView: (view: InkorgView) => void
  needCount: number | null
  /** Null while unknown: the count is left out rather than guessed. */
  missingCount: number | null
  doors: DoorRow[]
  /** The suppliers with a known portal among the purchases without underlag; the section is left out when empty. */
  portals: PortalRow[]
  onAddMailbox: () => void
  /** A connected mailbox's provider, so it wears the right mark and name. */
  mailProvider?: MailProvider
  className?: string
}) {
  const t = useTranslations('inkorg')
  const doorName = useDoorName(mailProvider)
  const active = viewKey(view)

  return (
    <nav aria-label={t('rail_label')} className={cn('min-w-0', className)}>
      <ul className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 md:mx-0 md:flex-col md:gap-1 md:overflow-visible md:px-0 md:pb-0">
        <RailRow
          active={active === 'need'}
          onClick={() => onView({ kind: 'need' })}
          icon={<CircleAlert aria-hidden="true" className="h-[15px] w-[15px] shrink-0 text-muted-foreground" />}
          label={t('view_need')}
          count={needCount}
          emphasis={(needCount ?? 0) > 0}
        />
        <RailRow
          active={active === 'missing'}
          onClick={() => onView({ kind: 'missing' })}
          icon={<FileQuestion aria-hidden="true" className="h-[15px] w-[15px] shrink-0 text-muted-foreground" />}
          label={t('view_missing')}
          count={missingCount}
        />
        <li className="hidden items-center justify-between pl-3 pt-4 md:flex">
          <span className={SECTION_LABEL_CLASS}>{t('rail_mailboxes')}</span>
          <Button type="button" variant="ghost" size="icon-sm" onClick={onAddMailbox} aria-label={t('add_mailbox')}>
            <Plus className="h-[15px] w-[15px]" />
          </Button>
        </li>
        {doors.map((row) => (
          <RailRow
            key={row.door}
            active={active === `door:${row.door}`}
            onClick={() => onView({ kind: 'door', door: row.door })}
            icon={<DoorMark door={row.door} size={22} mailProvider={mailProvider} />}
            label={doorName(row.door)}
            count={row.waiting > 0 ? row.waiting : null}
          />
        ))}
        {doors.length === 0 && (
          <li className="hidden px-3 py-2 text-[12.5px] text-muted-foreground md:block">{t('rail_no_doors')}</li>
        )}
        {/* On a phone the heading is gone, so the + rides at the end of the doors. */}
        <li className="shrink-0 md:hidden">
          <Button type="button" variant="ghost" size="icon-sm" onClick={onAddMailbox} aria-label={t('add_mailbox')}>
            <Plus className="h-[15px] w-[15px]" />
          </Button>
        </li>
        {portals.length > 0 && (
          <li className="hidden pl-3 pt-4 md:block">
            {/* As tall as the Brevlådor heading, which carries its + button. */}
            <span className={cn('flex h-8 items-center', SECTION_LABEL_CLASS)}>{t('rail_portals')}</span>
          </li>
        )}
        {portals.map((row) => (
          <RailRow
            key={row.vendor}
            active={active === viewKey({ kind: 'missing', portal: row.vendor })}
            onClick={() => onView({ kind: 'missing', portal: row.vendor })}
            icon={<BrandMark name={row.vendor} variant="mark" size={22} />}
            label={row.vendor}
            count={null}
            trailing={<PortalDot row={row} />}
          />
        ))}
      </ul>
    </nav>
  )
}

/**
 * A portal row's state as a small dot: terracotta while a purchase there
 * needs a person, ochre while every one of them is on its way. The words
 * ride along for screen readers and as the tooltip, so colour is never the
 * only thing that says it.
 */
function PortalDot({ row }: { row: PortalRow }) {
  const t = useTranslations('inkorg')
  const label =
    row.status === 'missing' ? t('portal_status_missing', { count: row.needsYou }) : t('portal_status_on_the_way')
  return (
    <span title={label} className="flex h-5 w-5 shrink-0 items-center justify-center">
      <span
        aria-hidden="true"
        className={cn('h-2 w-2 rounded-full', row.status === 'missing' ? 'bg-destructive' : 'bg-warning')}
      />
      <span className="sr-only">{label}</span>
    </span>
  )
}

function RailRow({
  active,
  onClick,
  icon,
  label,
  count,
  emphasis = false,
  trailing,
}: {
  active: boolean
  onClick: () => void
  icon: ReactNode
  label: string
  count: number | null
  emphasis?: boolean
  /** In place of a count: a portal's state dot. */
  trailing?: ReactNode
}) {
  return (
    <li className="shrink-0 md:shrink">
      <button
        type="button"
        onClick={onClick}
        aria-current={active ? 'page' : undefined}
        className={cn(
          // Pills on a phone, flat rows beside the list from md. Press feedback on pointer-down (:active), not on release.
          'flex h-8 w-full items-center gap-2 whitespace-nowrap rounded-full border border-border px-3 text-[13px] transition-colors duration-150',
          'md:h-9 md:rounded-lg md:border-0',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          active ? 'bg-secondary text-foreground' : 'text-foreground hover:bg-secondary/60 active:bg-secondary',
        )}
      >
        {icon}
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
        {count !== null && (
          <span
            className={cn(
              'tabular-nums text-[12.5px]',
              emphasis
                ? 'inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-foreground px-1 text-[11px] font-medium text-background'
                : 'text-muted-foreground',
            )}
          >
            {count}
          </span>
        )}
        {trailing}
      </button>
    </li>
  )
}
