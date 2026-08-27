'use client'

import { useEffect, useRef, useState } from 'react'
import { useAgentSheet } from './AgentSheetProvider'
import { usePathname, useRouter } from 'next/navigation'
import { Loader2, X } from 'lucide-react'
import AgentAvatar from './AgentAvatar'
import { collapsedStatusLabel } from './agent-status'
import { routeToIntent } from '@/lib/agent/intents/route-mapping'
import { useCapability } from '@/contexts/CompanyContext'
import { CAPABILITY } from '@/lib/entitlements/keys'

// Floating trigger sits above the page bottom-right, opens the AgentSheet when
// clicked. Hidden when the sheet is already open so the icon doesn't double up.
//
// Desktop-only for a FRESH open (founder call 2026-08-06). On mobile the pill
// landed on top of the bottom nav and covered page content, and the bottom nav
// already carries an "Assistent" tab to /chat behind the very same
// identity.isVerified gate used here, so the pill was pure redundancy. A
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
// Page-specific triggers (e.g. "Granska med assistent" on a supplier invoice)
// still call useAgentSheet() directly from their own buttons because they
// know exactly which entity to pass. (Per-transaction help has its own
// row-level "Fråga [namn]" button in TransactionInboxCard, and the matching
// "Fråga assistenten" in Dokumentinkorgen: both passing a transaction_id the
// pathname-only FAB can't know.)
// Session-scoped dismissal flag for the non-payer upsell pill. sessionStorage
// on purpose: "close" means gone for THIS browser session, and the pill comes
// back full-size next session. Anything permanent (localStorage or
// user_preferences) would let a non-payer silence the conversion surface
// forever with one click (founder call 2026-08-09).
const UPSELL_DISMISSED_KEY = 'agent-upsell-dismissed'

export default function AgentTrigger({ hidden = false }: { hidden?: boolean }) {
  const { openAgentSheet, expandAgentSheet, isOpen, collapsed, status, identity } = useAgentSheet()
  const pathname = usePathname()
  const router = useRouter()
  const hasAi = useCapability(CAPABILITY.ai)

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

  // User opt-out (Inställningar → Assistenten): the sidebar entry stays, the
  // floating button goes. A collapsed session keeps its reopen handle even
  // when hidden: it's the only way back to a minimized conversation, and its
  // existence implies the user is actively using the assistant right now.
  if (hidden && !collapsed) return null

  // Dismissed upsell (non-payer clicked the pill's X, or closed the paywalled
  // sheet): render nothing at all for the rest of the browser session. A
  // collapsed session still shows its handle even then: it is the only way
  // back to the minimized conversation, and its label is a resume action
  // ("Fortsätt med ..."), not the upsell.
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
  // Pre-onboarding: no agent_profile.verified_at yet. The FAB would lead
  // into a generic chat with no specialization. Better to hide it until
  // the user has finished /onboarding/agent. (A collapsed session implies the
  // agent is already in use, so this only gates fresh opens in practice.)
  if (!identity.isVerified) return null

  const name = identity.displayName?.trim() || 'min assistent'
  const dispatch = routeToIntent(pathname)
  // AI assistant runs on a paid cloud service. Without the capability, opening
  // the sheet would land the user in a chat whose send is dead. Keep the FAB
  // visible (it's the conversion surface) but route it to billing instead.
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
      router.push('/settings/billing')
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
  //                  Losing it costs nothing, the bottom nav's "Assistent" tab
  //                  reaches the same agent.
  //   collapsed   -> 'flex' on every viewport. Off /chat this is the ONLY route
  //                  back to a minimized conversation: the bottom-nav tab opens
  //                  the /chat surface instead of restoring the in-progress
  //                  sheet, so hiding the handle on mobile would strand a
  //                  session mid-booking with no way to reopen it. On /chat the
  //                  handle is suppressed outright (see above), which is exactly
  //                  the case where the nav tab does lead somewhere useful.
  //
  // A pure CSS switch on purpose: no useMediaQuery, so no hydration mismatch,
  // no resize listener, no layout shift on first paint.
  const visibilityClass = collapsed ? 'flex' : 'hidden md:flex'

  // The upsell pill (fresh state, no capability) carries its own dismiss so a
  // non-payer is never stuck with an undismissable ad in the corner. Payer and
  // collapsed states are unchanged: no X there, the pill is functional UI.
  const dismissible = !hasAi && !collapsed

  return (
    // Wrapper div carries the pill shell; the two segments inside are separate
    // buttons because a dismiss nested in the main <button> would be invalid
    // HTML. Segment hover is a background/10 overlay, visually equivalent to
    // the old whole-pill foreground/90 shift.
    <div
      // Mobile: sit above the bottom nav (h-16 = 64px) AND the iOS home
      // indicator (env(safe-area-inset-bottom)). Still needed after the FAB
      // went desktop-only: the collapsed handle above renders on mobile too.
      // Desktop: standard 20px lift, no mobile nav to worry about, except when
      // the page declares a bottom action bar (body[data-page-bottom-bar],
      // set by e.g. the standalone invoice editor): lift above it so the FAB
      // never covers the bar's primary button.
      // z-[45]: above the DialogVeil (z-40) so the assistant can be OPENED
      // while a non-modal dialog (booking, invoice) holds the page inert, but
      // below dialog content (z-50). Under a true modal dialog Radix sets
      // pointer-events: none on <body>, which keeps the trigger dead there
      // regardless of z.
      // data-agent-ui: opening the assistant must not dismiss an open
      // non-modal dialog (DialogContent treats this as inside).
      data-agent-ui=""
      className={`fixed right-4 z-[45] ${visibilityClass} h-12 max-w-[calc(100vw-2rem)] items-stretch rounded-full bg-foreground text-background shadow-lg bottom-[calc(env(safe-area-inset-bottom,0px)+5rem)] md:bottom-4 md:[body[data-page-bottom-bar]_&]:bottom-20`}
    >
      <button
        onClick={handleClick}
        className={`flex min-w-0 items-center gap-2 pl-2 ${dismissible ? 'rounded-l-full pr-2' : 'rounded-full pr-4'} hover:bg-background/10 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2`}
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
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
        )}
        <span className="text-sm font-medium truncate">{labelText}</span>
      </button>
      {dismissible && (
        <button
          onClick={dismissUpsellForSession}
          aria-label="Dölj tills nästa besök"
          className="flex items-center rounded-r-full pl-1 pr-3 text-background/70 hover:text-background hover:bg-background/10 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  )
}
