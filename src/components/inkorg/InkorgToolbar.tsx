'use client'

import { useTranslations } from 'next-intl'
import { PlusIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { ContextPicker } from '@/components/common/ContextPicker'
import { cn } from '@/lib/utils'
import type { DoorRow, InkorgView } from '@/lib/inkorg/items'
import type { PortalRow } from '@/lib/inkorg/portals'
import { useDoorName, type MailProvider } from './door-icon'

type Segment = 'need' | 'missing'

/**
 * The Inkorg's list toolbar (V7 list toolbars): the two views as segments
 * with their counts, then the filters, one per kind of source: Brevlåda
 * (one row per door in use, with what waits there) and Portal (one row per
 * supplier whose invoices wait behind a login, each opening Saknar underlag
 * for that supplier, with its state as the row's note). Lägg till brevlåda
 * sits at the right end; the page's one primary, Ladda upp, is in the top
 * bar. A view has one door: while a mailbox or a portal is chosen no
 * segment is selected.
 */
export function InkorgToolbar({
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
  /** The suppliers with a known portal among the purchases without underlag; the picker is left out when empty. */
  portals: PortalRow[]
  /** Absent for someone who may not add one (a viewer): the button is left out. */
  onAddMailbox?: () => void
  /** A connected mailbox's provider, so it wears the right name. */
  mailProvider?: MailProvider
  className?: string
}) {
  const t = useTranslations('inkorg')
  const doorName = useDoorName(mailProvider)
  const activeDoor = view.kind === 'door' ? view.door : null
  const activePortal = view.kind === 'missing' ? (view.portal ?? null) : null
  const segment: Segment | '' = view.kind === 'need' ? 'need' : view.kind === 'missing' && !view.portal ? 'missing' : ''

  return (
    <nav aria-label={t('rail_label')} className={cn('flex flex-wrap items-center gap-2', className)}>
      <div className="max-w-full overflow-x-auto rounded-lg">
        <SegmentedControl<Segment | ''>
          className="whitespace-nowrap"
          value={segment}
          onChange={(next) => {
            if (next) onView({ kind: next })
          }}
          options={[
            { value: 'need', label: t('view_need'), count: needCount ?? undefined },
            { value: 'missing', label: t('view_missing'), count: missingCount ?? undefined },
          ]}
        />
      </div>
      {doors.length > 0 && (
        <ContextPicker
          ariaLabel={t('rail_mailboxes')}
          value={activeDoor}
          onChange={(id) => {
            const row = doors.find((d) => d.door === id)
            if (row) onView({ kind: 'door', door: row.door })
          }}
          triggerLabel={activeDoor ? doorName(activeDoor) : t('rail_mailboxes')}
          items={doors.map((row) => ({
            id: row.door,
            label: doorName(row.door),
            annotation: row.waiting > 0 ? String(row.waiting) : undefined,
          }))}
        />
      )}
      {portals.length > 0 && (
        <ContextPicker
          ariaLabel={t('rail_portals')}
          value={activePortal}
          onChange={(id) => onView({ kind: 'missing', portal: id })}
          triggerLabel={activePortal ?? t('rail_portals')}
          items={portals.map((row) => ({
            id: row.vendor,
            label: row.vendor,
            // The portal's state in words: what the rail's dot said.
            annotation:
              row.status === 'missing' ? t('portal_status_missing', { count: row.needsYou }) : t('portal_status_on_the_way'),
          }))}
        />
      )}
      {onAddMailbox && (
        <Button
          type="button"
          variant="outline"
          size="toolbar"
          onClick={onAddMailbox}
          className="ml-auto"
        >
          <PlusIcon className="h-4 w-4" />
          {t('add_mailbox')}
        </Button>
      )}
    </nav>
  )
}
