'use client'

import { useRef, useState } from 'react'
import { Reorder } from 'motion/react'
import { useTranslations } from 'next-intl'
import { EnvelopeIcon } from '@/components/icons'
import { BrandMark, GlyphMark } from '@/components/parties/BrandMark'
import { SettingsGroup } from '@/components/settings/SettingsRows'
import { SortableRow } from '@/components/ui/sortable-row'
import { Switch } from '@/components/ui/switch'
import { ToastAction } from '@/components/ui/toast'
import { useToast } from '@/components/ui/use-toast'
import { useCompany, useSendOrderSetupEnabled } from '@/contexts/CompanyContext'
import { DIGITAL_MAILBOX_PROVIDER_NAMES } from '@/lib/digital-mailboxes/sending-status'
import {
  hasOrderToChoose,
  initialSendOrderRows,
  isAlwaysOnWay,
  moveSendOrderRow,
  orderOfRows,
  parseSendOrder,
  toggleSendOrderRow,
  type SendOrderRow,
  type SendOrderWay,
} from '@/lib/invoices/send-order'
import { cn } from '@/lib/utils'
import type { CompanySettings } from '@/types'
import { useSaveSendOrder, useSendOrderWays } from './use-send-order'

/** The mailbox providers' own app icons, shipped in public/logos (as the Inkorg's doors use them). */
const MAILBOX_ICON_URL: Record<'kivra' | 'billo', string> = {
  kivra: '/logos/kivra.png',
  billo: '/logos/billo.png',
}

/** A way's mark: Peppol's, the provider's own icon, or the envelope on the quiet chip for email. */
function WayMark({ way }: { way: SendOrderWay }) {
  if (way === 'email') {
    return (
      <GlyphMark size={28}>
        <EnvelopeIcon aria-hidden="true" style={{ width: 14, height: 14 }} strokeWidth={1.25} />
      </GlyphMark>
    )
  }
  if (way === 'peppol') return <BrandMark name="Peppol" vendor="peppol" variant="mark" size={28} />
  return (
    <BrandMark
      name={DIGITAL_MAILBOX_PROVIDER_NAMES[way]}
      vendor={way}
      variant="mark"
      size={28}
      logoUrl={MAILBOX_ICON_URL[way]}
    />
  )
}

function sameOrder(a: readonly SendOrderWay[], b: readonly SendOrderWay[]): boolean {
  return a.length === b.length && a.every((way, index) => way === b[index])
}

interface SendOrderListProps {
  available: readonly SendOrderWay[]
  saved: SendOrderWay[] | null
  canEdit: boolean
}

/**
 * The ways as a list to drag: position, mark, name and what it is, and a
 * switch (e-post has none: it is always on). A drop, an arrow key on a
 * handle or a switch saves at once, and the toast's Ångra puts back the
 * order that was there before.
 */
function SendOrderList({ available, saved, canEdit }: SendOrderListProps) {
  const t = useTranslations('invoice_send_order')
  const tCommon = useTranslations('common')
  const { toast } = useToast()
  const saveOrder = useSaveSendOrder()
  const [rows, setRowsState] = useState<SendOrderRow[]>(() => initialSendOrderRows(available, saved))
  // The rows a drag ends on (Motion's last reorder, kept beside the state so
  // the drop reads them), the order that is stored (what Ångra goes back to)
  // and the order the list showed when it was last saved.
  const rowsRef = useRef(rows)
  const storedRef = useRef<SendOrderWay[] | null>(saved)
  const shownRef = useRef<SendOrderWay[]>(orderOfRows(rows))

  function setRows(next: SendOrderRow[]) {
    rowsRef.current = next
    setRowsState(next)
  }

  const wayName = (way: SendOrderWay) =>
    way === 'peppol' ? t('way_peppol') : way === 'email' ? t('way_email') : DIGITAL_MAILBOX_PROVIDER_NAMES[way]
  const wayLine = (way: SendOrderWay) =>
    way === 'peppol' ? t('line_peppol') : way === 'email' ? t('line_email') : t('line_mailbox')

  async function store(next: SendOrderRow[]) {
    const order = orderOfRows(next)
    if (sameOrder(order, shownRef.current)) return
    const before = storedRef.current
    const ok = await saveOrder(order)
    if (!ok) {
      setRows(initialSendOrderRows(available, before))
      return
    }
    storedRef.current = order
    shownRef.current = order
    toast({
      title: t('saved_toast'),
      action: (
        <ToastAction altText={tCommon('undo')} onClick={() => void restore(before)}>
          {tCommon('undo')}
        </ToastAction>
      ),
    })
  }

  // Ångra: the order that was stored before, or none (null clears it, and the
  // editor goes back to its own default).
  async function restore(before: SendOrderWay[] | null) {
    const ok = await saveOrder(before)
    if (!ok) return
    const back = initialSendOrderRows(available, before)
    storedRef.current = before
    shownRef.current = orderOfRows(back)
    setRows(back)
  }

  function change(next: SendOrderRow[]) {
    setRows(next)
    void store(next)
  }

  const onWays = orderOfRows(rows)
  return (
    <Reorder.Group
      as="div"
      axis="y"
      values={rows.map((row) => row.way)}
      onReorder={(next: SendOrderWay[]) =>
        setRows(next.map((way) => rowsRef.current.find((row) => row.way === way) ?? { way, on: true }))
      }
    >
      {rows.map((row) => {
        const name = wayName(row.way)
        const position = row.on ? onWays.indexOf(row.way) + 1 : null
        return (
          <SortableRow
            key={row.way}
            value={row.way}
            handleLabel={t('move', { way: name })}
            disabled={!canEdit}
            onDragEnd={() => void store(rowsRef.current)}
            onMove={(step) => change(moveSendOrderRow(rows, row.way, step))}
            className="border-b-hairline bg-background"
          >
            <div className="flex min-h-12 items-center gap-3 py-2">
              <span
                className={cn('w-4 shrink-0 text-center text-[13px] tabular-nums', row.on ? 'text-strong' : 'text-muted-foreground')}
                aria-hidden="true"
              >
                {position ?? '-'}
              </span>
              <WayMark way={row.way} />
              <div className="min-w-0 flex-1">
                <div className={cn('text-[13px] font-medium', row.on ? 'text-strong' : 'text-muted-foreground')}>{name}</div>
                <div className="text-xs text-muted-foreground">{wayLine(row.way)}</div>
              </div>
              {isAlwaysOnWay(row.way) ? (
                <span className="shrink-0 text-xs text-muted-foreground">{t('always')}</span>
              ) : (
                <Switch
                  checked={row.on}
                  disabled={!canEdit}
                  onCheckedChange={() => change(toggleSendOrderRow(rows, row.way))}
                  aria-label={t('use_way', { way: name })}
                />
              )}
            </div>
          </SortableRow>
        )
      })}
    </Reorder.Group>
  )
}

/**
 * Vägar, first on Försäljning → Utskick: the order the ways invoices go out
 * are picked in. Shown where the company can use two or more ways, to a
 * company that has a saved order and to the users in the rollout
 * (INVOICE_SEND_ORDER_USER_IDS); only an owner or admin can change it.
 */
export function SendOrderSection({ settings }: { settings: CompanySettings }) {
  const t = useTranslations('invoice_send_order')
  const { role } = useCompany()
  const inRollout = useSendOrderSetupEnabled()
  const saved = parseSendOrder(settings.invoice_send_order)
  const ways = useSendOrderWays(inRollout || saved !== null)
  if (!ways || !hasOrderToChoose(ways) || (!saved && !inRollout)) return null
  return (
    <SettingsGroup label={t('ways_label')} help={t('ways_help')}>
      <SendOrderList available={ways} saved={saved} canEdit={role === 'owner' || role === 'admin'} />
    </SettingsGroup>
  )
}
