'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import { useLocale, useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  DocumentTextIcon,
  EnvelopeIcon,
  PaperAirplaneIcon,
  PaperClipIcon,
  PlusIcon,
  XMarkIcon,
} from '@/components/icons'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/components/ui/use-toast'
import { submitFeedback } from '@/lib/support/submit-feedback'
import { clearSupportDraft, readSupportDraft, writeSupportDraft } from '@/lib/support/draft'
import { useCompanyOptional } from '@/contexts/CompanyContext'
import {
  SUPPORT_ATTACHMENT_ACCEPT,
  SUPPORT_MAX_ATTACHMENTS,
  SUPPORT_MAX_ATTACHMENT_TOTAL_BYTES,
  SUPPORT_MAX_ATTACHMENT_TOTAL_MB,
  isSupportedAttachmentType,
} from '@/lib/support/attachments'
import { shrinkImageForUpload } from '@/lib/documents/shrink-image'
import { isShrinkableImage } from '@/lib/documents/upload-size'
import {
  currentTicketId,
  displayStatus,
  isResolved,
  listTickets,
  loadThread,
  markThreadRead,
  replyInThread,
  sortByActivity,
  splitByStatus,
  startView,
  totalUnread,
  type Thread,
  type TicketStatus,
  type TicketSummary,
  whenConversationsReady,
} from '@/lib/support/conversations'
import { dialogMaxHeight, dialogViewportStyle, fitTextarea, useVisualViewport } from '@/components/support/composer-fit'
import { mergeIntoDraft } from '@/lib/support/assistant-handoff'
import { stockholmYearMonth } from '@/lib/dates/iso'

// The AI assistant's panel is fetched when the dialog first shows it: this
// dialog is part of every page's shell (the user menu), and a page should not
// carry the panel, its stream reader and the markdown loader for a dialog
// most visits never open.
const SupportAsk = dynamic(() => import('@/components/support/SupportAsk').then((mod) => mod.SupportAsk), {
  ssr: false,
  loading: () => (
    <div className="flex flex-col gap-2" aria-busy="true">
      <Skeleton className="h-12 w-full rounded-lg" />
      <Skeleton className="h-12 w-full rounded-lg" />
    </div>
  ),
})

interface SupportLinkProps {
  /** 'hidden' renders no trigger: the dialog is controlled through `open`. */
  variant?: 'inline' | 'muted' | 'hidden'
  subject?: string
  children?: React.ReactNode
  className?: string
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /**
   * False opens the dialog on the form to a person even where the company
   * has the AI assistant: for a door that reports something (an error page,
   * closing the account) or leads to an answer from the staff (the reply
   * mail's link). Default: the assistant first, where the company has it.
   */
  assistant?: boolean
}

type AttachmentError = 'unsupported' | 'too_many' | 'too_large'

/**
 * loading  fetching tickets or a thread
 * ask      the AI assistant (components/support/SupportAsk.tsx): the start
 *          page where the company has it and no answer from the staff is
 *          waiting, with the form to a person one step away
 * list     every ticket, open ones first: the start page once there is more
 *          than one, or a single resolved one (startView)
 * thread   the conversation with support (reply box while the ticket is open;
 *          read-only for a resolved ticket, e.g. one opened for an unread answer)
 * compose  write a new ticket, attachments allowed: with no tickets yet, or on
 *          "Nytt ärende" from the list or a thread, with a way back to it
 * email    conversations unavailable (self-hosted, analytics off): same form, mail delivery
 * sent     delivered by mail (attachments, or the fallback)
 */
type View = 'loading' | 'ask' | 'list' | 'thread' | 'compose' | 'email' | 'sent'

const SECTION_LABEL_CLASS = 'mb-2 text-xs font-medium text-muted-foreground'

const POLL_MS = 20_000

const SENT_CLOSE_MS = 6_000

function totalBytes(files: File[]): number {
  return files.reduce((sum, file) => sum + file.size, 0)
}

/**
 * The support dialog. Since 2026-09-14 the conversation lives in PostHog
 * Support and the founders answer there, so this is a thread the user can
 * come back to, not a one-way form. A message with attachments still goes by
 * mail (the conversation API is text) and the mail form remains the fallback
 * for installs without PostHog.
 */
export function SupportLink({
  variant = 'inline',
  subject,
  children,
  className,
  open: openProp,
  onOpenChange,
  assistant = true,
}: SupportLinkProps) {
  const t = useTranslations('support_link')
  const locale = useLocale()
  const { toast } = useToast()
  const companyCtx = useCompanyOptional()

  const [openState, setOpenState] = useState(false)
  const open = openProp ?? openState
  const [view, setView] = useState<View>('loading')
  const [tickets, setTickets] = useState<TicketSummary[]>([])
  const [thread, setThread] = useState<Thread | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [composeBack, setComposeBack] = useState<'list' | 'thread' | 'ask' | null>(null)
  // Whether the conversation with the staff is available here (PostHog
  // Support); without it the form goes by mail.
  const [ticketsAvailable, setTicketsAvailable] = useState(false)
  // The AI assistant: where the layout says this company and user have it.
  const assistantOn = assistant && companyCtx?.supportAssistant === true && Boolean(companyCtx.company?.id)
  const [message, setMessage] = useState('')
  const [attachments, setAttachments] = useState<File[]>([])
  const [isPreparing, setIsPreparing] = useState(false)
  const [isSending, setIsSending] = useState(false)
  const [unread, setUnread] = useState(0)
  // Where the answer to a mailed message goes (the mail's Reply-To), for 'sent'.
  const [sentTo, setSentTo] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const attachmentGenerationRef = useRef(0)
  const listRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  // The compose and the reply box: never both on screen, so one ref.
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const viewport = useVisualViewport(open)

  const setOpen = useCallback(
    (next: boolean) => {
      if (openProp === undefined) setOpenState(next)
      onOpenChange?.(next)
    },
    [openProp, onOpenChange]
  )

  const showTicket = useCallback(async (ticketId: string, silent = false) => {
    if (!silent) setView('loading')
    const next = await loadThread(ticketId)
    if (!next) {
      // A failed poll keeps what is on screen. A failed open must not leave
      // the previous ticket's thread, and its reply box, under the error.
      if (silent) return
      setThread(null)
      setLoadFailed(true)
      setView('thread')
      return
    }
    setLoadFailed(false)
    setThread(next)
    setView('thread')
    if (next.unreadCount > 0) {
      await markThreadRead(ticketId)
      setTickets((prev) => prev.map((x) => (x.id === ticketId ? { ...x, unreadCount: 0 } : x)))
      setUnread((n) => Math.max(0, n - next.unreadCount))
    }
  }, [])

  // `openId` is the ticket a send just landed in: it opens whether or not the
  // ticket list has caught up with it yet.
  const bootstrap = useCallback(async (openId?: string | null) => {
    setView('loading')
    setThread(null)
    // Waits for an SDK that is still loading: asked once at open, a page that
    // had just loaded (the reply mail's ?support=1 link) got the empty mail
    // form instead of the answer (crm#1393).
    if (!(await whenConversationsReady())) {
      setTicketsAvailable(false)
      setComposeBack(assistantOn ? 'ask' : null)
      setView(assistantOn ? 'ask' : 'email')
      return
    }
    setTicketsAvailable(true)
    const list = sortByActivity(await listTickets())
    setTickets(list)
    setUnread(totalUnread(list))
    if (openId) {
      await showTicket(openId)
      return
    }
    // The assistant first, unless an answer from the staff is waiting: that
    // is what the user opened the dialog for.
    if (assistantOn && totalUnread(list) === 0) {
      setView('ask')
      return
    }
    const start = startView(list)
    if (start.view === 'thread') {
      await showTicket(start.ticketId)
      return
    }
    setComposeBack(null)
    setView(start.view)
  }, [showTicket, assistantOn])

  // Unread dot on the trigger: one cheap call when the trigger mounts, once
  // the SDK is ready (a trigger mounted with the page would otherwise never ask).
  useEffect(() => {
    if (variant === 'hidden') return
    let cancelled = false
    void whenConversationsReady().then(async (ready) => {
      if (!ready || cancelled) return
      const list = await listTickets()
      if (!cancelled) setUnread(totalUnread(list))
    })
    return () => {
      cancelled = true
    }
  }, [variant])

  // Deferred a tick so the effect itself sets no state (react-hooks rule);
  // bootstrap does its work after awaits anyway. The stored draft is picked
  // up here: this instance may be freshly mounted, or the text may have been
  // typed through another trigger.
  useEffect(() => {
    if (!open) return
    const id = setTimeout(() => {
      setMessage((current) => current || readSupportDraft())
      void bootstrap(null)
    }, 0)
    return () => clearTimeout(id)
  }, [open, bootstrap])

  // Keep the open thread fresh while the dialog is up, so a reply that lands
  // during the conversation shows without a reload.
  const viewingId = thread?.ticketId ?? null
  useEffect(() => {
    if (!open || view !== 'thread' || !viewingId) return
    const id = setInterval(() => void showTicket(viewingId, true), POLL_MS)
    return () => clearInterval(id)
  }, [open, view, viewingId, showTicket])

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [thread])

  // The message box grows with its text, so a long message reads in full
  // while it is written, up to what the dialog's max height leaves beside the
  // rest of the dialog; past that it scrolls inside (PH 216). Re-fitted on
  // everything that changes its text, its width or the room around it.
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    fitTextarea(el, panelRef.current, dialogMaxHeight(panelRef.current, viewport?.height ?? window.innerHeight))
  }, [message, view, viewport, attachments.length, thread, composeBack])

  if (companyCtx?.isSandbox) return null

  function showAttachmentError(error: AttachmentError) {
    if (error === 'unsupported') {
      toast({ title: t('attach_unsupported'), variant: 'destructive' })
      return
    }
    if (error === 'too_many') {
      toast({
        title: t('attach_too_many', { count: SUPPORT_MAX_ATTACHMENTS }),
        variant: 'destructive',
      })
      return
    }
    toast({
      title: t('attach_too_large', { limit: SUPPORT_MAX_ATTACHMENT_TOTAL_MB }),
      variant: 'destructive',
    })
  }

  async function addFiles(incoming: File[]) {
    if (!incoming.length || isPreparing || isSending) return

    const generation = attachmentGenerationRef.current
    setIsPreparing(true)
    try {
      const next = [...attachments]
      let firstError: AttachmentError | null = null

      for (const original of incoming) {
        if (!isSupportedAttachmentType(original.type)) {
          firstError ??= 'unsupported'
          continue
        }
        if (next.length >= SUPPORT_MAX_ATTACHMENTS) {
          firstError ??= 'too_many'
          break
        }

        const remaining = SUPPORT_MAX_ATTACHMENT_TOTAL_BYTES - totalBytes(next)
        const file = original.size > remaining && isShrinkableImage(original.type)
          ? await shrinkImageForUpload(original, remaining)
          : original

        if (file.size > remaining) {
          firstError ??= 'too_large'
          continue
        }
        next.push(file)
      }

      if (generation === attachmentGenerationRef.current) {
        setAttachments(next)
        if (firstError) showAttachmentError(firstError)
      }
    } finally {
      setIsPreparing(false)
    }
  }

  function resetAttachments() {
    attachmentGenerationRef.current += 1
    setAttachments([])
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  // Typed text is never dropped on close: it stays in the draft until it is
  // delivered (support ticket 102: an outside click used to discard it).
  function updateMessage(text: string) {
    setMessage(text)
    writeSupportDraft(text)
  }

  function clearMessage() {
    setMessage('')
    clearSupportDraft()
  }

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (!next) {
      resetAttachments()
      setView('loading')
    }
  }

  // With something typed or attached, an outside click or Escape must not
  // dismiss the dialog: those are easy to do by accident. The explicit
  // Avbryt / X still close it, and the text is kept as a draft either way.
  const hasUnsentInput = message.trim().length > 0 || attachments.length > 0
  function guardDismiss(event: Event) {
    if (hasUnsentInput) event.preventDefault()
  }

  async function handleCompose(e: React.FormEvent) {
    e.preventDefault()
    if (message.trim().length < 5) return

    setIsSending(true)
    const result = await submitFeedback({
      subject,
      message: message.trim(),
      files: attachments,
      // The composer only ever starts a new request: replies to an open ticket
      // go through handleReply. Without the flag the SDK appends to its current
      // ticket, which can be a resolved one this dialog no longer shows (it was
      // opened earlier, or remembered from a previous visit), and a message
      // there reaches nobody. So this is unconditional, not derived from state.
      newTicket: true,
    })
    setIsSending(false)

    if (!result.ok) {
      toast({
        title: t('send_failed_title'),
        description: result.error || t('send_failed_fallback'),
        variant: 'destructive',
      })
      return
    }

    clearMessage()
    resetAttachments()
    if (result.channels.includes('ticket')) {
      // The SDK made the new ticket its current one: open it, not the list.
      await bootstrap(currentTicketId())
      return
    }
    setSentTo(result.replyTo ?? null)
    setView('sent')
    // Long enough to read where the answer will come, not only "thanks".
    setTimeout(() => handleOpenChange(false), SENT_CLOSE_MS)
  }

  async function handleReply(e: React.FormEvent) {
    e.preventDefault()
    const text = message.trim()
    if (!text || !viewingId) return
    setIsSending(true)
    const res = await replyInThread(viewingId, text)
    setIsSending(false)
    if (!res) {
      toast({ title: t('send_failed_title'), description: t('reply_failed'), variant: 'destructive' })
      return
    }
    clearMessage()
    if (res.ticketId !== viewingId) await bootstrap(res.ticketId)
    else await showTicket(viewingId, true)
  }

  // Back to the list from a thread or the composer. Statuses and unread counts
  // may have moved meanwhile, so the list refreshes behind it; a failed fetch
  // ([]) keeps the one on screen.
  async function showList() {
    setView('list')
    const list = sortByActivity(await listTickets())
    if (list.length === 0) return
    setTickets(list)
    setUnread(totalUnread(list))
  }

  const fmt = (iso: string) =>
    new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso))

  // A ticket's name is the day it was opened: PostHog's ticket list carries no
  // subject, and the last message alone does not tell two tickets apart.
  const fmtDay = (iso: string) => {
    const d = new Date(iso)
    const sameYear = stockholmYearMonth(d).year === stockholmYearMonth().year
    return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) }).format(d)
  }

  const statusLabel = (s: TicketStatus) => t(`status_${s}`)

  // One draft for the dialog, not one per ticket: text typed as a reply moves
  // along to "Nytt ärende" (and back), which is what the customer who realises
  // mid-sentence that this is a separate matter wants.
  function startNewTicket(from: 'list' | 'thread') {
    setComposeBack(from)
    setView('compose')
  }

  // From the assistant to the staff: what the dialog would have opened on
  // without the assistant (the open ticket, the list, or the form), so a
  // user with a ticket under way writes in it and does not start a second.
  async function showStaff() {
    if (!ticketsAvailable) {
      setComposeBack('ask')
      setView('email')
      return
    }
    const start = startView(tickets)
    if (start.view === 'thread') {
      await showTicket(start.ticketId)
      return
    }
    setComposeBack(start.view === 'compose' ? 'ask' : null)
    setView(start.view)
  }

  // An answer sent on to a person: the form opens with the conversation as
  // its message, after whatever the user had already typed there, and the
  // user reads it before sending.
  function handOffToStaff(conversation: string) {
    updateMessage(mergeIntoDraft(message, conversation))
    setComposeBack('ask')
    setView(ticketsAvailable ? 'compose' : 'email')
  }

  // Any open ticket on screen takes a reply, and the reply names that ticket
  // (replyInThread; handleReply still checks where it landed). Pinning
  // replies to the ticket the dialog opened on left every other open ticket
  // read-only, so switching to one was a dead end (crm#1138).
  const canReply = Boolean(thread && !isResolved(thread.status))
  const { open: openTickets, resolved: resolvedTickets } = splitByStatus(tickets)
  const hasList = tickets.length > 1
  const openedAt = tickets.find((x) => x.id === viewingId)?.createdAt ?? thread?.messages[0]?.createdAt ?? null

  // No status on a row: the list does not say who wrote last, so a pending
  // ticket could read "Väntar på dig" under the customer's own message. The
  // section says open or resolved; the row says only what is new.
  const ticketRow = (x: TicketSummary) => {
    const fresh = x.unreadCount > 0
    return (
      <li key={x.id}>
        <button
          type="button"
          onClick={() => void showTicket(x.id)}
          className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-secondary/35 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <span className="min-w-0 flex-1">
            <span
              className={cn(
                'block truncate text-[13px]',
                isResolved(x.status) ? 'text-muted-foreground' : 'text-foreground',
                fresh && 'font-medium text-foreground'
              )}
            >
              {x.lastMessage || t('no_messages')}
            </span>
            <span className="mt-1 flex items-center gap-2 text-xs tabular-nums text-muted-foreground">
              {t('ticket_label', { date: fmtDay(x.createdAt) })}
              {fresh && (
                <span className="inline-flex items-center gap-1 text-foreground">
                  <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-primary" />
                  {t('new_reply')}
                </span>
              )}
            </span>
          </span>
          <ChevronRightIcon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        </button>
      </li>
    )
  }

  const ticketSection = (label: string, list: TicketSummary[]) =>
    list.length > 0 && (
      <section>
        <p className={SECTION_LABEL_CLASS}>{label}</p>
        <ul className="overflow-hidden divide-y divide-border">{list.map(ticketRow)}</ul>
      </section>
    )

  const triggerLabel = (
    <>
      {children ?? t('default_label')}
      {unread > 0 && (
        <span
          aria-label={t('unread_aria', { count: unread })}
          className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-primary align-middle"
        />
      )}
    </>
  )

  const trigger =
    variant === 'hidden' ? null : variant === 'muted' ? (
      <button
        type="button"
        className={cn(
          'inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer',
          className
        )}
      >
        <EnvelopeIcon className="h-3 w-3" />
        {triggerLabel}
      </button>
    ) : (
      <button
        type="button"
        className={cn(
          'inline-flex items-center gap-1 text-primary hover:text-primary/80 underline-offset-4 hover:underline transition-colors text-sm cursor-pointer',
          className
        )}
      >
        {triggerLabel}
      </button>
    )

  const composeForm = (
    <form onSubmit={handleCompose}>
      <Textarea
        ref={textareaRef}
        value={message}
        onChange={(e) => updateMessage(e.target.value)}
        placeholder={t('placeholder')}
        className="min-h-[120px] resize-none"
        maxLength={5000}
        disabled={isSending}
        autoFocus
      />
      <p className="text-xs text-muted-foreground mt-1.5">
        {t('char_count', { count: message.length })}
      </p>

      {attachments.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {attachments.map((file, index) => (
            <li
              key={`${file.name}-${file.size}-${index}`}
              className="ph-no-capture flex min-w-0 items-center gap-2 rounded-lg px-3 py-1 bg-control shadow-raised"
            >
              <DocumentTextIcon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-xs">
                {file.name}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => setAttachments((current) => current.filter((_, i) => i !== index))}
                disabled={isSending || isPreparing}
                aria-label={t('remove_attachment')}
                className="shrink-0"
              >
                <XMarkIcon className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-3 flex flex-col items-start gap-2 sm:flex-row sm:items-center">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={SUPPORT_ATTACHMENT_ACCEPT}
          className="hidden"
          disabled={isSending || isPreparing}
          onChange={(e) => {
            void addFiles(Array.from(e.target.files ?? []))
            e.target.value = ''
          }}
        />
        <Button
          type="button"
          variant="outline"
          disabled={isSending || attachments.length >= SUPPORT_MAX_ATTACHMENTS}
          loading={isPreparing}
          onClick={() => fileInputRef.current?.click()}
        >
          {!isPreparing && <PaperClipIcon className="h-3.5 w-3.5" />}
          {t('attach_label')}
        </Button>
        <span className="text-xs text-muted-foreground">
          {t('attach_hint', {
            count: SUPPORT_MAX_ATTACHMENTS,
            limit: SUPPORT_MAX_ATTACHMENT_TOTAL_MB,
          })}
        </span>
      </div>

      <DialogFooter className="mt-4">
        <Button
          type="button"
          variant="ghost"
          onClick={() => handleOpenChange(false)}
          disabled={isSending}
        >
          {t('cancel')}
        </Button>
        <Button
          type="submit"
          disabled={isPreparing || message.trim().length < 5}
          loading={isSending}
        >
          {isSending ? t('sending') : (
            <>
              <PaperAirplaneIcon className="h-4 w-4" />
              {t('send')}
            </>
          )}
        </Button>
      </DialogFooter>
    </form>
  )

  const replyForm = (
    <form onSubmit={handleReply} className="mt-3">
      <Textarea
        ref={textareaRef}
        value={message}
        onChange={(e) => updateMessage(e.target.value)}
        placeholder={t('reply_placeholder')}
        className="min-h-[80px] resize-none"
        maxLength={5000}
        disabled={isSending}
      />
      <DialogFooter className="mt-3">
        <Button type="button" variant="ghost" onClick={() => handleOpenChange(false)} disabled={isSending}>
          {t('cancel')}
        </Button>
        <Button type="submit" disabled={message.trim().length === 0} loading={isSending}>
          {!isSending && <PaperAirplaneIcon className="h-4 w-4" />}
          {isSending ? t('sending') : t('reply')}
        </Button>
      </DialogFooter>
    </form>
  )

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      {/* Told the visual viewport: an on-screen keyboard shrinks only that
          one, so a dialog measured from the layout viewport sits half behind
          the keyboard on a tablet (PH 216). Where it sits and how tall it may
          be stays the shared dialog's own rule. */}
      <DialogContent size={view === 'ask' ? 'form' : 'confirm'}
 ref={panelRef}
 
 style={dialogViewportStyle(viewport)}
 onInteractOutside={guardDismiss}
 onEscapeKeyDown={guardDismiss}
>
        <DialogHeader>
          <DialogTitle>{t('dialog_title')}</DialogTitle>
          <DialogDescription>
            {view === 'ask'
              ? t('ask_description')
              : view === 'thread' || view === 'list'
                ? t('thread_description')
                : t('dialog_description')}
          </DialogDescription>
        </DialogHeader>

        {view === 'loading' && (
          <div className="flex flex-col gap-2" aria-busy="true">
            <Skeleton className="h-12 w-full rounded-lg" />
            <Skeleton className="h-12 w-full rounded-lg" />
          </div>
        )}

        {view === 'ask' && companyCtx?.company?.id && (
          <SupportAsk
            companyId={companyCtx.company.id}
            ticketCount={tickets.length}
            onShowTickets={() => void showStaff()}
            onWriteToSupport={() => void showStaff()}
            onHandoff={handOffToStaff}
            onNavigate={() => handleOpenChange(false)}
          />
        )}

        {assistantOn && (view === 'list' || (view === 'thread' && !hasList)) && (
          <div>
            <Button type="button" variant="ghost" className="-ml-3" onClick={() => setView('ask')}>
              <ChevronLeftIcon className="h-4 w-4" />
              {t('ask_back')}
            </Button>
          </div>
        )}

        {view === 'list' && (
          <div className="flex flex-col gap-4">
            {ticketSection(t('open_section'), openTickets)}
            {ticketSection(t('resolved_section'), resolvedTickets)}
            <DialogFooter>
              <Button type="button" onClick={() => startNewTicket('list')}>
                <PlusIcon className="h-4 w-4" />
                {t('new_ticket')}
              </Button>
            </DialogFooter>
          </div>
        )}

        {view === 'sent' && (
          <div className="flex flex-col items-center py-6 gap-3">
            <div className="p-3 rounded-full bg-success/10">
              <PaperAirplaneIcon className="h-6 w-6 text-success" />
            </div>
            <p className="text-sm font-medium">{t('sent_by_email')}</p>
            <p className="text-center text-sm text-muted-foreground break-words">
              {sentTo ? t('reply_to_address', { email: sentTo }) : t('reply_to_own_address')}
            </p>
          </div>
        )}

        {(view === 'compose' || view === 'email') && composeBack && (
          <div>
            <Button
              type="button"
              variant="ghost"
              className="-ml-3"
              onClick={() =>
                composeBack === 'ask' ? setView('ask') : composeBack === 'list' ? void showList() : setView('thread')
              }
            >
              <ChevronLeftIcon className="h-4 w-4" />
              {composeBack === 'ask' ? t('ask_back') : composeBack === 'list' ? t('all_tickets') : t('back_to_ticket')}
            </Button>
          </div>
        )}

        {(view === 'compose' || view === 'email') && composeForm}

        {view === 'thread' && (
          <div>
            <div className="flex items-center gap-2">
              {hasList && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="-ml-2 shrink-0"
                  onClick={() => void showList()}
                  aria-label={t('all_tickets')}
                >
                  <ChevronLeftIcon className="h-4 w-4" />
                </Button>
              )}
              <div className="flex min-w-0 flex-1 items-center gap-2">
                {openedAt && (
                  <span className="truncate text-[13px] font-medium text-foreground">
                    {t('ticket_label', { date: fmtDay(openedAt) })}
                  </span>
                )}
                {thread && (
                  <span className="inline-flex h-5 shrink-0 items-center rounded-md border border-border px-2 text-xs text-muted-foreground">
                    {statusLabel(displayStatus(thread.status, thread.messages))}
                  </span>
                )}
              </div>
              {canReply && (
                <Button
                  type="button"
                  variant="ghost"
                  className="-mr-3 shrink-0"
                  onClick={() => startNewTicket('thread')}
                >
                  {t('new_ticket')}
                </Button>
              )}
            </div>

            {loadFailed ? (
              <p className="mt-4 text-sm text-muted-foreground">{t('load_failed')}</p>
            ) : (
              <div ref={listRef} className="mt-3 flex max-h-[45dvh] flex-col gap-3 overflow-y-auto pr-1">
                {thread?.messages.map((m) => (
                  <div key={m.id} className={cn('flex flex-col gap-1', m.from === 'me' ? 'items-end' : 'items-start')}>
                    <span className="text-xs text-muted-foreground">
                      {m.from === 'me' ? t('you') : (m.authorName ?? t('support_name'))}
                    </span>
                    <div
                      className={cn(
                        'max-w-[85%] whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-sm',
                        m.from === 'me' ? 'bg-secondary' : 'border border-border'
                      )}
                    >
                      {m.text}
                    </div>
                    <span className="text-xs tabular-nums text-muted-foreground">{fmt(m.createdAt)}</span>
                  </div>
                ))}
              </div>
            )}

            {canReply ? (
              replyForm
            ) : (
              !loadFailed && (
                <div className="mt-4 flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-xs text-muted-foreground">{t('resolved_hint')}</p>
                  <Button
                    type="button"
                    variant="outline"
                    className="shrink-0"
                    onClick={() => startNewTicket('thread')}
                  >
                    {t('new_ticket')}
                  </Button>
                </div>
              )
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
