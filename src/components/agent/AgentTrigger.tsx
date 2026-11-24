'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useAgentSheet } from './AgentSheetProvider'
import { usePathname, useRouter } from 'next/navigation'
import { SpinnerIcon, XMarkIcon } from '@/components/icons'
import AgentAvatar from './AgentAvatar'
import { collapsedStatusLabel } from './agent-status'
import { AGENT_FAB_PROPS } from '@/components/ui/fab-clearance'
import { routeToIntent } from '@/lib/agent/intents/route-mapping'
import { useAssistantAvailable, useCapability } from '@/contexts/CompanyContext'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { billingHref } from '@/lib/entitlements/upgrade-reason'
import { useFabHidden } from './use-fab-hidden'

// Floating trigger sits above the page bottom-right, opens the AgentSheet when
// clicked. Hidden when the sheet is already open so the icon doesn't double up.
//
// Desktop-only for a FRESH open (product call 2026-08-06). On mobile the pill
// landed on top of the bottom nav and covered page content, and the bottom nav
// already carries an "Assistent" tab to /chat, so the pill was pure
// redundancy. A
// COLLAPSED session keeps its handle on every viewport and on every page except
// /chat: see the page-suppression block and the visibility class below.
//
// Route-aware: routeToIntent(pathname) picks the right intent + intentArgs so
// clicking the FAB on /invoices/abc-123 opens invoice.draft with that invoice
// id (rather than the page-agnostic general.help with just the URL). The
// label suffix renders "Fråga Anna om denna faktura" so the user can tell at
// a glance that the agent is going to know which entity they're on.
//
// Reads the agent's display_name + avatar_id from the AgentSheet context so
// the button reads "Fråga Anna" (with Anna's face) rather than the generic
// "Fråga min assistent".
//
// Page-specific triggers call useAgentSheet() directly from their own buttons
// because they know exactly which entity to pass: "Skapa med assistent" on
// Bokföring (verifikation.draft) and the "Fråga assistenten" buttons in
// Underlag (transaction.categorization with a transaction_id, inbox.bulk-book
// with the marked items), which the pathname-only FAB can't know.
// Session-scoped dismissal flag for the pill shown without the ai capability.
// sessionStorage on purpose: "close" means gone for THIS browser session, and
// the pill comes back full-size next session. A permanent dismissal
// (localStorage or user_preferences) would hide the pill for good with one
// click.
const UPSELL_DISMISSED_KEY = 'agent-upsell-dismissed'

export default function AgentTrigger({ hidden = false }: { hidden?: boolean }) {
  const { openAgentSheet, expandAgentSheet, isOpen, collapsed, status, identity } = useAgentSheet()
  const pathname = usePathname()
  const router = useRouter()
  const hasAi = useCapability(CAPABILITY.ai)
  const assistantAvailable = useAssistantAvailable()

  // Read the dismissal AFTER hydration (effect, not state initializer): the
  // server always renders the pill, so an initializer that reads
  // sessionStorage would mismatch the SSR HTML. Costs one frame of pill
  // before it hides, which is invisible in practice.
  const [upsellDismissed, setUpsellDismissed] = useState(false)
  useEffect(() => {
    try {
      if (window.sessionStorage.getItem(UPSELL_DISMISSED_KEY) === '1') setUpsellDismissed(true)
    } catch {
      // Storage unavailable (private mode, blocked cookies): the pill simply
      // stays dismissible per page load instead of per session.
    }
  }, [])

  const dismissUpsellForSession = () => {
    setUpsellDismissed(true)
    try {
      window.sessionStorage.setItem(UPSELL_DISMISSED_KEY, '1')
    } catch {
      // Same as above: in-memory state still hides it for this page.
    }
  }

  // For a non-payer the sheet is a paywall surface, so closing it means "not
  // now": treat it exactly like dismissing the pill. Otherwise the user closes
  // the big panel and the wide "Uppgradera för att använda ..." pill pops
  // right back, which is the residual-overlay complaint this fixes. Collapse
  // (Minimera) is not a close and never lands here: isOpen stays true.
  const prevOpenRef = useRef(isOpen)
  useEffect(() => {
    const wasOpen = prevOpenRef.current
    prevOpenRef.current = isOpen
    if (wasOpen && !isOpen && !hasAi) {
      setUpsellDismissed(true)
      try {
        window.sessionStorage.setItem(UPSELL_DISMISSED_KEY, '1')
      } catch {
        // In-memory dismissal still applies.
      }
    }
  }, [isOpen, hasAi])

  const t = useTranslations('settings_assistant')
  // The pill's own X writes the same user_preferences opt-out as the settings
  // switch (use-fab-hidden.tsx).
  const { effectiveHidden, hideFab } = useFabHidden(hidden, {
    title: t('fab_hidden_title'),
    description: t('fab_hidden_description'),
  })

  // User opt-out (the pill's X, or Inställningar → Assistenten): the sidebar
  // entry stays, the floating button goes. A collapsed session keeps its
  // reopen handle even when hidden: it's the only way back to a minimized
  // conversation, and its existence implies the user is actively using the
  // assistant right now.
  if (effectiveHidden && !collapsed) return null

  // Dismissed pill (no ai capability; the user clicked the pill's X, or closed
  // the paywalled sheet): render nothing at all for the rest of the browser
  // session. A collapsed session still shows its handle even then: it is the
  // only way back to the minimized conversation, and its label is a resume
  // action ("Fortsätt med ..."), not the billing prompt.
  if (!hasAi && upsellDismissed && !collapsed) return null

  // Sheet open AND visible → hide the FAB so the icon doesn't double up. When
  // the session is merely collapsed we KEEP the FAB: it's the handle that
  // brings the minimized conversation back.
  if (isOpen && !collapsed) return null
  // Page suppression, split by WHY the page suppresses. The split is the point:
  // one rule is about redundancy (the page already IS the conversation), the
  // other is about crowding (the page is dense and the pill would sit on top of
  // it). Only the redundancy rule survives into the collapsed state, because
  // only it leaves the user another route back to the conversation.
  //
  // /chat*: suppressed in BOTH states. Fresh open: the surface IS the chat, so
  // a floating "Fråga …" pill is redundant and overlaps the input. Collapsed:
  // the /chat layout lists every conversation in its sidebar and renders the
  // selected one in the main pane, so navigating here IS the way back; a handle
  // that re-expands the panel on top of it would put two chats on one screen.
  // Safe because the session lives in AgentSheetProvider in the dashboard
  // layout, one level above the page: it stays mounted (messages, streaming,
  // pending approval cards intact) the whole time the user is on /chat, and the
  // handle reappears the moment they navigate anywhere else, bottom nav
  // included. Nothing is discarded, the handle is just hidden while the user is
  // standing inside the surface it would lead to.
  if (pathname?.startsWith('/chat')) return null
  // /bookkeeping/[id]: FRESH open only. The verifikation editor is a dense
  // regulatory surface (debits/credits, BAS codes, period locks) and a floating
  // "Fråga … om denna verifikation" pill on top of it adds noise without
  // earning its place. A COLLAPSED session keeps its handle here, and on every
  // other page in the app: this page offers no other route back to a minimized
  // conversation, and stranding a half-finished booking is a worse outcome than
  // a pill over the editor. (/bookkeeping list, /bookkeeping/new and
  // /bookkeeping/year-end are not the editor and keep the fresh-open FAB.)
  if (!collapsed) {
    const segs = pathname?.split('/').filter(Boolean) ?? []
    if (segs[0] === 'bookkeeping' && segs[1] && segs[1] !== 'year-end' && segs[1] !== 'new') {
      return null
    }
  }
  // No built assistant (agent_profile.verified_at): the FAB would lead
  // into a generic chat with no specialization, so it is not offered. The
  // build is removed, so this now holds for every company that never built
  // one. (A collapsed session implies the
  // agent is already in use, so this only gates fresh opens in practice.)
  if (!identity.isVerified) return null

  const name = identity.displayName?.trim() || 'min assistent'
  // Without the tool-loop runtime (OpenAI-compatible or unconfigured AI, #2204)
  // every route dispatches to general.help: the single-call console runs on
  // any provider, so the pill stays but never opens a chat that would 503.
  const dispatch = routeToIntent(pathname, { assistantAvailable })
  // AI assistant runs on a paid cloud service. Without the capability, opening
  // the sheet would land the user in a chat whose send is dead. Keep the FAB
  // visible but route it to billing instead.
  // A minimized session used to be silent: the agent could be three tool calls
  // into a booking, or finished ten minutes ago, and the pill said "Fortsätt
  // med Anna" either way. While hidden, the status channel does the talking.
  const statusText = collapsed ? collapsedStatusLabel(status, name) : null
  const working = status.activity === 'working' || status.activity === 'detached'
  const finished = collapsed && status.activity === 'done'

  const labelText =
    statusText ??
    (collapsed
      ? `Fortsätt med ${name}`
      : !hasAi
        ? `Uppgradera för att använda ${name}`
        : dispatch.labelSuffix
          ? `Fråga ${name} ${dispatch.labelSuffix}`
          : `Fråga ${name}`)

  const handleClick = () => {
    // Collapsed → bring the existing session back, don't start a new one.
    if (collapsed) {
      expandAgentSheet()
      return
    }
    if (!hasAi) {
      router.push(billingHref('assistant'))
      return
    }
    openAgentSheet({
      intentId: dispatch.intentId,
      intentArgs: dispatch.intentArgs,
      contextRef: dispatch.contextRef,
    })
  }

  // Mobile visibility, decided per state rather than per viewport alone:
  //
  //   fresh open  -> 'hidden md:flex'. `display: none` (not opacity/visibility)
  //                  so the button is genuinely non-interactive on mobile: not
  //                  clickable, not tabbable, out of the accessibility tree.
  //                  The bottom nav has no assistant tab; on a phone a new
  //                  conversation starts on /chat, under the Agenter area in
  //                  the bottom nav's menu.
  //   collapsed   -> 'flex' on every viewport. Off /chat this is the one way
  //                  back to a minimized conversation on the page the user
  //                  stands on: without it a session mid-booking could only be
  //                  found again by leaving the page for /chat. On /chat the
  //                  handle is suppressed outright (see above): there the
  //                  conversation is already on screen.
  //
  // A pure CSS switch on purpose: no useMediaQuery, so no hydration mismatch,
  // no resize listener, no layout shift on first paint.
  const visibilityClass = collapsed ? 'flex' : 'hidden md:flex'

  // Every fresh pill carries an X; a collapsed handle never does (it is the way
  // back to a live session). Without the ai capability the X dismisses the
  // pill for this browser session, so it is never stuck undismissable in the
  // corner. With it, the X sets the persistent opt-out above, with an undo.
  const dismissible = !collapsed

  return (
    // Wrapper div carries the pill shell; the two segments inside are separate
    // buttons because a dismiss nested in the main <button> would be invalid
    // HTML. Segment hover is a background/10 overlay, visually equivalent to
    // the old whole-pill foreground/90 shift.
    <div
      // Mobile: sit 1rem above the bottom nav (--bottom-nav-h in globals.css:
      // the tab row plus the iOS home indicator). Still needed after the FAB
      // went desktop-only: the collapsed handle above renders on mobile too.
      // Desktop: standard 20px lift, no mobile nav to worry about, except when
      // the page shows a bottom action bar (an element carrying
      // data-page-bottom-bar, see ui/fab-clearance.ts): lift above it so the FAB
      // never covers the bar's primary button. The marker is read with :has(),
      // so a bar only has to render the attribute. It used to be expected on
      // <body>, which nothing set, so the lift never happened (crm#1841).
      // A phone lifts the collapsed handle the same way: the bars sit on the
      // bottom nav there (StepBar, the Börja step bar) or float 1.5rem above
      // it (the bulk bar, 3.5rem tall on a touch screen), and each keeps its
      // primary on its lowest line, so 5.5rem above the nav clears it.
      // z-[45]: above the DialogVeil (z-40) so the assistant can be OPENED
      // while a non-modal dialog (booking, invoice) holds the page inert, but
      // below dialog content (z-50). Under a true modal dialog Radix sets
      // pointer-events: none on <body>, which keeps the trigger dead there
      // regardless of z.
      // data-agent-ui: opening the assistant must not dismiss an open
      // non-modal dialog (DialogContent treats this as inside).
      data-agent-ui=""
      {...AGENT_FAB_PROPS}
      className={`fixed right-4 z-[45] ${visibilityClass} h-12 max-w-[calc(100vw-2rem)] items-stretch rounded-pop bg-foreground text-background shadow-float bottom-[calc(var(--bottom-nav-h)+1rem)] md:bottom-4 max-md:[body:has([data-page-bottom-bar])_&]:bottom-[calc(var(--bottom-nav-h)+5.5rem)] md:[body:has([data-page-bottom-bar])_&]:bottom-20`}
    >
      <button
        onClick={handleClick}
        className={`flex min-w-0 items-center gap-2 pl-2 ${dismissible ? 'rounded-l-pop pr-2' : 'rounded-pop pr-4'} hover:bg-background/10 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2`}
        aria-label={labelText}
        // The label changes on its own while the panel is hidden, so it has to be
        // announced rather than only redrawn. Polite: it never interrupts.
        aria-live="polite"
      >
        <span className="relative shrink-0">
          <AgentAvatar
            avatarId={identity.avatarId}
            size="sm"
            className="ring-2 ring-background/20"
            alt={name}
          />
          {/* An answer waiting behind a hidden panel is the one thing worth a
              dot: it is unread, not in progress. */}
          {finished && (
            <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-success ring-2 ring-foreground" />
          )}
        </span>
        {working && collapsed && (
          <SpinnerIcon className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
        )}
        <span className="text-sm font-medium truncate">{labelText}</span>
      </button>
      {dismissible && (
        <button
          onClick={hasAi ? () => void hideFab() : dismissUpsellForSession}
          aria-label={hasAi ? t('fab_hide') : 'Dölj tills nästa besök'}
          title={hasAi ? t('fab_hide') : undefined}
          className="flex items-center rounded-r-pop pl-1 pr-3 text-background/70 hover:text-background hover:bg-background/10 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <XMarkIcon className="h-4 w-4" />
        </button>
      )}
    </div>
  )
}
