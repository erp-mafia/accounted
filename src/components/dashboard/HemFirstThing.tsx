'use client'

import { useRef, useState, type ReactNode } from 'react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useBankConnectFlow, type BankConnectFlow } from '@/components/bank-feed/use-bank-connect-flow'
import { useOpenPaymentsAvailability } from '@/components/bank-feed/use-open-payments-availability'
import { Button } from '@/components/ui/button'
import { DrawnCheck } from '@/components/ui/done-chip'
import { useBookingScreenEnabled } from '@/contexts/CompanyContext'
import { toBookDoor } from '@/lib/bookkeeping/to-book'
import {
  AI_CLIENTS,
  aiPrefilledChatLink,
  openAiConnector,
  pickConnectedAiClient,
  type AiClient,
} from '@/lib/onboarding/ai-clients'
import type { FirstThingKind, FirstThingLead } from '@/lib/onboarding/first-thing'
import { saveUiState } from '@/lib/ui-state/client'
import { AI_TASK_LABEL_KEY, aiTaskHref, type AiTask } from '@/lib/worklist/ai-task'
import { KvittojaktenButton } from './KvittojaktenButton'

interface HemFirstThingProps {
  kind: FirstThingKind
  lead: FirstThingLead
  /** What comes after the first thing (at most three). */
  after: AiTask[]
  /** The AI clients whose connection belongs to this company (a hand-off prompt names no company). */
  clients: AiClient[]
  /** Where "connect the bank" leads where the bank dialog does not open in place (the checklist's bank step). */
  bankHref: string
  /** Where a bank statement file is imported. */
  bankFileHref: string
  /** The company's inbox page (WorklistCounts.inboxHref). */
  inboxHref: string | null
  companyId: string
}

/**
 * Hem for a new company: what is already in, one named first thing, what
 * comes after it, and one quiet button that brings the usual Hem back. It
 * shows the counts and lists Hem already reads and decides nothing about the
 * books. The one primary button of the page is in here; the top bar carries
 * none. Laid out as the app's state block (components/ui/empty-state):
 * centered where the first row would be, everything on one axis.
 */
export function HemFirstThing({ kind, lead, after, clients, bankHref, bankFileHref, inboxHref, companyId }: HemFirstThingProps) {
  const t = useTranslations('dashboard')
  const router = useRouter()
  const bookingScreen = useBookingScreenEnabled()
  const [closing, setClosing] = useState(false)
  const [failed, setFailed] = useState(false)

  const clientId = pickConnectedAiClient(clients)
  const client = AI_CLIENTS.find((c) => c.id === clientId) ?? null
  const bookHref = toBookDoor(bookingScreen, aiTaskHref('book_transaction', inboxHref))
  const prompt = t('first_thing_book_prompt')

  async function showAll() {
    setClosing(true)
    setFailed(false)
    try {
      const res = await saveUiState({ first_thing_closed: { [companyId]: new Date().toISOString() } })
      if (!res.ok) throw new Error('save failed')
      router.refresh()
    } catch {
      setFailed(true)
      setClosing(false)
    }
  }

  const link = (href: string, label: string, variant: 'default' | 'link') => (
    <Button asChild variant={variant} size={variant === 'default' ? 'toolbar' : undefined}>
      <Link href={href}>{label}</Link>
    </Button>
  )

  // What is in already, and only that: the books, the bank, each connected AI.
  const inMarks: { key: string; label: string }[] = []
  if (lead === 'books' || lead === 'books_and_bank') inMarks.push({ key: 'books', label: t('first_thing_in_books') })
  if (lead === 'bank' || lead === 'books_and_bank') inMarks.push({ key: 'bank', label: t('first_thing_in_bank') })
  for (const id of clients) {
    const name = AI_CLIENTS.find((c) => c.id === id)?.name
    if (name) inMarks.push({ key: `ai-${id}`, label: name })
  }

  let title: string
  let why: string
  let primary: ReactNode
  let second: ReactNode = null

  if (kind === 'connect_bank') {
    title = t('first_thing_connect_title')
    why = t('first_thing_connect_why')
    primary = <ConnectBank href={bankHref} label={t('first_thing_connect_action')} />
    second = link(bankFileHref, t('first_thing_connect_file'), 'link')
  } else if (kind === 'import_bank_file') {
    title = t('first_thing_import_title')
    why = t('first_thing_import_why')
    primary = link(bankFileHref, t('first_thing_import_action'), 'default')
  } else if (kind === 'book_bank_rows') {
    if (client) {
      title = t('first_thing_book_ai_title', { client: client.name })
      why = t('first_thing_book_ai_why')
      primary = (
        <Button type="button" size="toolbar" onClick={() => openAiConnector(aiPrefilledChatLink(client.id, prompt))}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={client.logo} alt="" className="h-3.5 w-3.5 rounded-full" />
          {t('first_thing_book_ai_open', { client: client.name })}
        </Button>
      )
      second = link(bookHref, t('first_thing_book_here_alt'), 'link')
    } else {
      title = t('first_thing_book_title')
      why = t('first_thing_book_why')
      primary = link(bookHref, t('first_thing_book_action'), 'default')
    }
  } else if (kind === 'find_receipts') {
    title = t('first_thing_receipts_title')
    why = t('first_thing_receipts_why')
    primary =
      clients.length > 0 ? (
        <KvittojaktenButton clients={clients} />
      ) : (
        link(aiTaskHref('verifikat_missing_document', inboxHref), t('first_thing_receipts_action'), 'default')
      )
  } else {
    title = t('first_thing_documents_title')
    why = t('first_thing_documents_why')
    primary = link(aiTaskHref('inbox_document', inboxHref), t('first_thing_documents_action'), 'default')
  }

  return (
    <section
      className="mx-auto flex max-w-[560px] flex-col items-center pb-2 pt-10 text-center animate-rise"
      aria-labelledby="hem-first-thing-title"
    >
      {inMarks.length > 0 && (
        <ul className="mb-5 flex flex-wrap items-center justify-center gap-x-5 gap-y-2" aria-label={t('first_thing_in_label')}>
          {inMarks.map((mark, index) => (
            <li key={mark.key} className="inline-flex items-center gap-1.5 text-[13px] text-foreground">
              {/* Each check draws a moment after the one before it. */}
              <DrawnCheck delayMs={150 + index * 120} />
              {mark.label}
            </li>
          ))}
        </ul>
      )}

      <h2 id="hem-first-thing-title" className="text-xl font-medium text-strong text-balance">
        {title}
      </h2>
      <p className="mt-1 text-[13px] text-muted-foreground text-balance">{why}</p>

      <div className="mt-5 flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
        {primary}
        {second}
      </div>

      {after.length > 0 && (
        <div className="mt-10 w-full max-w-sm space-y-1 text-left">
          <h3 className="text-[12px] font-medium text-muted-foreground">{t('first_thing_after_title')}</h3>
          <ol className="border-t-hairline">
            {after.map((task, index) => (
              <li key={task.category} className="border-b-hairline">
                <Link
                  href={
                    task.category === 'book_transaction'
                      ? bookHref
                      : aiTaskHref(task.category, inboxHref)
                  }
                  className="flex min-h-11 items-center gap-3 text-[13px] hover:bg-secondary/35"
                >
                  {/* The first thing is number one: the list goes on from two. */}
                  <span className="w-4 text-muted-foreground tabular-nums">{index + 2}</span>
                  <span className="min-w-0 flex-1 truncate text-foreground">{t(AI_TASK_LABEL_KEY[task.category])}</span>
                  <span className="tabular-nums text-muted-foreground">{task.count}</span>
                </Link>
              </li>
            ))}
          </ol>
        </div>
      )}

      <div className="mt-6 space-y-1">
        <Button type="button" variant="ghost" onClick={showAll} loading={closing}>
          {t('first_thing_show_all')}
        </Button>
        {failed && (
          <p className="text-[13px] text-destructive" role="alert">
            {t('first_thing_close_failed')}
          </p>
        )}
      </div>
    </section>
  )
}

/** The bank dialog, loaded when it is first opened. */
const BankConnectDialog = dynamic(() => import('@/components/bank-feed/BankConnectDialog').then((mod) => mod.BankConnectDialog), { ssr: false })

/**
 * "Koppla banken". Where the company's bank is connected through the BankID
 * dialog, the button opens that dialog right here, and once it closes after a
 * connection the page reads the company again (the first thing is then the
 * next one). Elsewhere, and until that is known, it is the link to where a
 * bank is connected. A bank that signs on its own page comes back to the bank
 * settings, which take the dialog up again.
 */
function ConnectBank({ href, label }: { href: string; label: string }) {
  const router = useRouter()
  const openPayments = useOpenPaymentsAvailability()
  const bankFlow = useBankConnectFlow('banking')
  const connected = useRef(false)
  if (openPayments.status !== 'available') {
    return (
      <Button asChild size="toolbar">
        <Link href={href}>{label}</Link>
      </Button>
    )
  }
  // The dialog shows its own last step first: the page is read again when it closes.
  const flow: BankConnectFlow = {
    ...bankFlow,
    close: () => {
      bankFlow.close()
      if (connected.current) router.refresh()
    },
  }
  return (
    <>
      <Button type="button" size="toolbar" onClick={() => bankFlow.open('new')}>
        {label}
      </Button>
      {bankFlow.isOpen ? (
        <BankConnectDialog
          flow={flow}
          onConnected={() => {
            connected.current = true
          }}
        />
      ) : null}
    </>
  )
}
