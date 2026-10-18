'use client'

import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/ui/page-header'
import { useToast } from '@/components/ui/use-toast'
import { HelpPopover } from '@/components/ui/help-popover'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { useCompanyOptional } from '@/contexts/CompanyContext'
import { cn } from '@/lib/utils'
import { LEGACY_INBOX_HREF } from '@/lib/inkorg/flag'
import { ALL_STARTABLE, type InkorgStartable } from '@/lib/inkorg/decision'
import { focusAfterChange, focusKeyAction, neighbour } from '@/lib/inkorg/focus'
import { doorOf, doorsInUse, needCount, parseViewKey, queueFor, viewKey, type InkorgView } from '@/lib/inkorg/items'
import { dragCarriesFiles, missingDecision, orderMissing, splitMissing } from '@/lib/inkorg/missing'
import { portalRows, purchasesAtPortal } from '@/lib/inkorg/portals'
import { AddMailboxDialog } from './AddMailboxDialog'
import { useDoorName } from './door-icon'
import { InkorgFocus, type FocusMotion } from './InkorgFocus'
import { InkorgList } from './InkorgList'
import { InkorgRail } from './InkorgRail'
import { MissingFocusStage } from './MissingFocusStage'
import { MissingUnderlagList } from './MissingUnderlagList'
import { FocusStage, type FinePrintOpen } from './FocusStage'
import { FetchWithAiButton } from './FetchWithAiButton'
import { CONTENT_COLUMN_CLASS, RAIL_COLUMN_CLASS, WORK_AREA_CLASS } from './frame'
import { UploadButton } from './UploadButton'
import { useAttachUnderlag } from './use-attach-underlag'
import { PayInBankDialog, type PayInBankTarget } from './PayInBankDialog'
import { useInkorgData } from './use-inkorg-data'
import { useMissingContext } from './use-missing-context'
import { useExpectations } from './use-expectations'
import { ViewHeading } from './row-parts'
import type { BankMatch } from '@/lib/documents/inbox-bank-match'

/** How long "Klart" stays on a finished item when it did not leave the queue after all. */
const DONE_MARK_MS = 600

/** A dialog, menu, listbox or alert is open over the page: its keys are its own. */
function overlayOpen(): boolean {
  return !!document.querySelector(
    '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"], [role="listbox"][data-state="open"]',
  )
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)
}

/** Back to the top of the content: the panel scrolls on desktop, the window on a phone. */
function scrollContentTop() {
  document.getElementById('main-content')?.scrollTo({ top: 0 })
  window.scrollTo({ top: 0 })
}

/**
 * Inkorg (the new page behind INKORG_V2_COMPANY_IDS): the top bar (title,
 * help, Ladda upp), then a rail of views, doors and portals as its own
 * column beside the selected view's list, and a focus view that works the
 * list through one item at a time. Everything it reads and every action it
 * takes goes through the invoice-inbox extension's HTTP API, the same calls
 * the Underlag workspace makes; core never imports the extension.
 *
 * On a desktop the rail runs the full height of the panel under the top
 * bar, with a hairline between it and the content, and stays put while the
 * content scrolls: the work area takes back MainContainer's padding so the
 * rail reaches the panel's edges. On a phone the rail is a strip of pills
 * above the list, as before.
 *
 * What the company can start and the owner's account come from the server
 * (lib/inkorg/startable.ts), read once per page load: the focus view never
 * offers an answer whose package is switched off. Without them every
 * package counts as on.
 */
export function InkorgPage({
  startable = ALL_STARTABLE,
  ownerAccount = null,
}: {
  startable?: InkorgStartable
  /** The account a cost paid with the owner's own money is booked against (enskild firma: 2018). */
  ownerAccount?: string | null
} = {}) {
  // useSearchParams needs a Suspense boundary on a server-rendered page.
  return (
    <Suspense fallback={null}>
      <InkorgPageInner startable={startable} ownerAccount={ownerAccount} />
    </Suspense>
  )
}

function InkorgPageInner({ startable, ownerAccount }: { startable: InkorgStartable; ownerAccount: string | null }) {
  const t = useTranslations('inkorg')
  const searchParams = useSearchParams()
  const { toast } = useToast()
  const companyId = useCompanyOptional()?.company?.id ?? null
  const { items, itemsState, purchases, purchasesState, refresh } = useInkorgData(companyId)

  const [view, setView] = useState<InkorgView>(() => parseViewKey(searchParams.get('view')))
  const [focusId, setFocusId] = useState<string | null>(null)
  const [motionState, setMotionState] = useState<FocusMotion>({ direction: 0, completed: false })
  const [revision, setRevision] = useState(0)
  const [finishingId, setFinishingId] = useState<string | null>(null)
  const [lastOpenedId, setLastOpenedId] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [finePrint, setFinePrint] = useState<FinePrintOpen>({ booking: false, fields: false })
  // "Jag betalar i banken": what to type in the bank, open over whatever comes next.
  const [payInBank, setPayInBank] = useState<PayInBankTarget | null>(null)
  // What the focus view read since about each item's bank row: newer than the list's own, so the row follows it.
  const [bankMatches, setBankMatches] = useState<ReadonlyMap<string, BankMatch | null>>(() => new Map())
  const onBankMatch = useCallback((itemId: string, match: BankMatch | null) => {
    setBankMatches((current) => {
      if (current.has(itemId) && current.get(itemId)?.transaction_id === match?.transaction_id) return current
      const next = new Map(current)
      next.set(itemId, match)
      return next
    })
  }, [])

  const queue = useMemo(() => queueFor(items, view), [items, view])
  // Saknar underlag works through bank purchases, not items: its own queue, newest first,
  // what needs a person before what is on its way (the order the view lists them in).
  const purchaseIds = useMemo(() => purchases.map((p) => p.id), [purchases])
  const { expectations, onTheWay } = useExpectations(purchasesState === 'ready', purchaseIds)
  const missingParts = useMemo(() => splitMissing(orderMissing(purchases), onTheWay), [purchases, onTheWay])
  // What the rail and the heading count: the purchases that need a person now.
  const missingNeedCount = purchasesState === 'ready' ? missingParts.needsYou.length : null
  // Portaler: the suppliers among them whose invoices wait behind a login, most purchases first.
  const portals = useMemo(() => portalRows(purchases, onTheWay), [purchases, onTheWay])
  // A row under Portaler is Saknar underlag for that supplier alone: the list, its queue and Väntas senare.
  const portal = view.kind === 'missing' ? (view.portal ?? null) : null
  const missing = useMemo(() => {
    const all = [...missingParts.needsYou, ...missingParts.onTheWay]
    return portal ? purchasesAtPortal(all, portal) : all
  }, [missingParts, portal])
  const missingExpectations = useMemo(
    () => (portal && expectations ? expectations.filter((e) => e.portal?.vendor === portal) : expectations),
    [expectations, portal],
  )
  const portalUrl = portal ? (portals.find((row) => row.vendor === portal)?.url ?? null) : null
  const queueIds = useMemo(
    () => (view.kind === 'missing' ? missing.map((p) => p.id) : queue.map((i) => i.id)),
    [view.kind, missing, queue],
  )
  const missingContext = useMissingContext(view.kind === 'missing')
  const doors = useMemo(() => doorsInUse(items), [items])
  // The connected mailbox's provider, read off its items (Gmail unless they say Microsoft).
  const mailProvider = useMemo(
    () => items.find((item) => doorOf(item) === 'mailbox' && item.channel_context?.mail_provider)?.channel_context?.mail_provider ?? null,
    [items],
  )
  const doorName = useDoorName(mailProvider)
  const need = itemsState === 'ready' ? needCount(items) : null

  // When the queue changes under the focus view (an action finished, a
  // realtime refetch landed), the focused item stays while it is there;
  // otherwise the next one opens by itself, or the list comes back.
  const previousQueue = useRef<string[]>(queueIds)
  useEffect(() => {
    const previous = previousQueue.current
    previousQueue.current = queueIds
    if (!focusId) return
    const next = focusAfterChange(previous, queueIds, focusId)
    if (next === focusId) return
    if (next === null) {
      setLastOpenedId(null)
      setFocusId(null)
      return
    }
    setMotionState({ direction: 1, completed: true })
    setFocusId(next)
    scrollContentTop()
    // Only the queue drives this; the focus it reads is the one the queue changed under.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueIds])

  const open = useCallback((id: string) => {
    setMotionState({ direction: 0, completed: false })
    setFocusId(id)
    scrollContentTop()
  }, [])

  const step = useCallback(
    (direction: 1 | -1) => {
      if (!focusId) return
      const next = neighbour(queueIds, focusId, direction)
      if (!next) return
      setMotionState({ direction, completed: false })
      setFocusId(next)
      scrollContentTop()
    },
    [focusId, queueIds],
  )

  const back = useCallback(() => {
    setLastOpenedId(focusId)
    setFocusId(null)
  }, [focusId])

  const chooseView = useCallback((next: InkorgView) => {
    setView(next)
    setFocusId(null)
    setLastOpenedId(null)
    // The view in the address, so a reload or a shared link opens it; no navigation, no server render.
    const url = new URL(window.location.href)
    if (next.kind === 'need') url.searchParams.delete('view')
    else url.searchParams.set('view', viewKey(next))
    window.history.replaceState(null, '', url)
  }, [])

  const onDone = useCallback(
    async (id: string, outcome: { leaves: boolean; payInBank?: PayInBankTarget }) => {
      if (outcome.payInBank) setPayInBank(outcome.payInBank)
      // "Klart" first, so the stage carries it as it leaves.
      if (outcome.leaves) setFinishingId(id)
      await refresh()
      // An item that stays is read again (its new state); one that left needs nothing more.
      if (!outcome.leaves) setRevision((r) => r + 1)
      else window.setTimeout(() => setFinishingId((f) => (f === id ? null : f)), DONE_MARK_MS)
    },
    [refresh],
  )

  // A purchase got its underlag: "Klart" while it leaves, then the list is read
  // again and the next one opens by itself (the queue effect above).
  const onPurchaseAttached = useCallback(
    async (purchaseId: string) => {
      setFinishingId(purchaseId)
      await refresh()
      window.setTimeout(() => setFinishingId((f) => (f === purchaseId ? null : f)), DONE_MARK_MS)
    },
    [refresh],
  )

  // Ångra released it: it is back in the list, and back in focus, from the left, when the
  // focus view is open.
  const focusedMissing = useRef(false)
  useEffect(() => {
    focusedMissing.current = focusId !== null && view.kind === 'missing'
  }, [focusId, view.kind])
  const onPurchaseReleased = useCallback(
    async (purchaseId: string) => {
      await refresh()
      if (!focusedMissing.current) return
      setMotionState({ direction: -1, completed: false })
      setFocusId(purchaseId)
      scrollContentTop()
    },
    [refresh],
  )

  const { attach, busyId } = useAttachUnderlag({
    onAttached: onPurchaseAttached,
    onReleased: onPurchaseReleased,
    onFiled: refresh,
  })

  // The focus view's keys: J / K (or the arrows) step, Esc goes back.
  useEffect(() => {
    if (!focusId) return
    const onKey = (event: KeyboardEvent) => {
      const action = focusKeyAction({
        key: event.key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        targetIsEditable: isEditable(event.target),
        overlayOpen: overlayOpen(),
      })
      if (!action) return
      event.preventDefault()
      if (action === 'back') back()
      else step(action === 'next' ? 1 : -1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focusId, back, step])

  const viewLabel =
    view.kind === 'need'
      ? t('view_need')
      : view.kind === 'missing'
        ? (view.portal ?? t('view_missing'))
        : doorName(view.door)
  const viewLead =
    view.kind === 'need'
      ? t('view_need_lead')
      : view.kind === 'missing'
        ? view.portal
          ? t('view_portal_lead', { vendor: view.portal })
          : t('view_missing_lead')
        : t('view_door_lead')
  const focused = focusId !== null && queueIds.includes(focusId)

  // In Saknar underlag a file that misses its target must not open in the tab instead: the
  // purchase in focus takes it, wherever on the page it landed; over the list, the person is
  // told to drop it on the purchase. Rows and the focus stage take their own drops first.
  const missingDropGuard =
    view.kind === 'missing'
      ? {
          onDragOver: (e: DragEvent) => {
            if (dragCarriesFiles(e.dataTransfer?.types)) e.preventDefault()
          },
          onDrop: (e: DragEvent) => {
            if (!dragCarriesFiles(e.dataTransfer?.types)) return
            e.preventDefault()
            const files = Array.from(e.dataTransfer.files ?? [])
            if (focused && focusId) void attach(focusId, files)
            else toast({ title: t('missing_drop_on_row') })
          },
        }
      : {}

  return (
    <div {...missingDropGuard}>
      <PageHeader
        title={t('title')}
        action={<UploadButton onUploaded={refresh} />}
        help={
          <HelpPopover>
            <p>{t('help_body')}</p>
            <p className="mt-2">{t('help_missing')}</p>
            <p className="mt-2">{t('help_portals')}</p>
            <p className="mt-2">{t('help_expected')}</p>
            <p className="mt-2">
              {t('help_legacy')}{' '}
              <Link href={LEGACY_INBOX_HREF} className={QUIET_LINK_CLASS}>
                {t('help_legacy_link')}
              </Link>
            </p>
          </HelpPopover>
        }
      />

      <div className={WORK_AREA_CLASS}>
        <InkorgRail
          className={cn(RAIL_COLUMN_CLASS, focused && 'hidden md:block')}
          view={view}
          onView={chooseView}
          needCount={need}
          missingCount={missingNeedCount}
          doors={doors}
          portals={portals}
          mailProvider={mailProvider}
          onAddMailbox={() => setAddOpen(true)}
        />

        <div className={CONTENT_COLUMN_CLASS}>
          {focused && focusId ? (
            <InkorgFocus
              ids={queueIds}
              focusId={focusId}
              motionState={motionState}
              viewLabel={viewLabel}
              onStep={step}
              onBack={back}
              renderStage={(id) => {
                if (view.kind === 'missing') {
                  const purchase = missing.find((p) => p.id === id)
                  return purchase ? (
                    <MissingFocusStage
                      purchase={purchase}
                      decision={missingDecision(purchase, missingContext.routes, missingContext.handoff)}
                      handoff={missingContext.handoff}
                      busy={busyId === purchase.id}
                      finishing={finishingId === purchase.id}
                      onFiles={(files) => void attach(purchase.id, files)}
                    />
                  ) : null
                }
                const item = queue.find((i) => i.id === id)
                return item ? (
                  <FocusStage
                    item={item}
                    revision={revision}
                    finishing={finishingId === item.id}
                    finePrint={finePrint}
                    onFinePrint={setFinePrint}
                    onBankMatch={onBankMatch}
                    onDone={(outcome) => onDone(item.id, outcome)}
                    startable={startable}
                    ownerAccount={ownerAccount}
                    onBack={back}
                  />
                ) : null
              }}
            />
          ) : (
            <section aria-labelledby="inkorg-view-heading" className="animate-fade-in">
              <ViewHeading
                id="inkorg-view-heading"
                title={viewLabel}
                lead={viewLead}
                aside={
                  portal && portalUrl ? (
                    // The portal's two ways to the invoices, as each of its purchases offers them.
                    <div className="flex shrink-0 flex-wrap gap-2">
                      <Button asChild variant="secondary" size="sm">
                        <a href={portalUrl} target="_blank" rel="noopener noreferrer">
                          {t('action_open_portal', { vendor: portal })}
                          <ExternalLink aria-hidden="true" className="ml-1 h-3.5 w-3.5" />
                        </a>
                      </Button>
                      {missingContext.handoff && (
                        <FetchWithAiButton clients={missingContext.handoff.clients} variant="secondary" size="sm" />
                      )}
                    </div>
                  ) : undefined
                }
              />
              {view.kind === 'missing' ? (
                <MissingUnderlagList
                  portal={portal ?? undefined}
                  purchases={missing}
                  state={purchasesState}
                  routes={missingContext.routes}
                  onTheWay={onTheWay}
                  expectations={missingExpectations}
                  busyId={busyId}
                  lastOpenedId={lastOpenedId}
                  onOpen={open}
                  onFiles={(purchaseId, files) => void attach(purchaseId, files)}
                  onRetry={() => void refresh()}
                />
              ) : (
                <InkorgList
                  view={view}
                  items={queue}
                  state={itemsState}
                  onOpen={open}
                  onRetry={() => void refresh()}
                  lastOpenedId={lastOpenedId}
                  bankMatches={bankMatches}
                />
              )}
            </section>
          )}
        </div>
      </div>

      <AddMailboxDialog open={addOpen} onOpenChange={setAddOpen} />
      <PayInBankDialog target={payInBank} onClose={() => setPayInBank(null)} />
    </div>
  )
}
