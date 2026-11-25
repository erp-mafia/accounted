'use client'

import { useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
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
  /** The AI clients this person has connected. */
  clients: AiClient[]
  /** Where "connect the bank" leads (the checklist's bank step). */
  bankHref: string
  /** Where "upload a document" leads (the checklist's receipts step). */
  receiptsHref: string
  /** The company's inbox page (WorklistCounts.inboxHref). */
  inboxHref: string | null
  companyId: string
}

/**
 * Hem for a new company: one named first thing, what comes after it, and one
 * quiet button that brings the usual Hem back. It shows the counts and
 * lists Hem already reads and decides nothing about the books. The one
 * primary button of the page is in here; the top bar carries none.
 */
export function HemFirstThing({ kind, lead, after, clients, bankHref, receiptsHref, inboxHref, companyId }: HemFirstThingProps) {
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
    <Button asChild variant={variant}>
      <Link href={href}>{label}</Link>
    </Button>
  )

  let title: string
  let why: string
  let primary: ReactNode
  let second: ReactNode = null

  if (kind === 'connect_bank') {
    title = t('first_thing_connect_title')
    why = t('first_thing_connect_why')
    primary = link(bankHref, t('first_thing_connect_action'), 'default')
    second = link(receiptsHref, t('first_thing_connect_upload'), 'link')
  } else if (kind === 'book_bank_rows') {
    if (client) {
      title = t('first_thing_book_ai_title', { client: client.name })
      why = t('first_thing_book_ai_why')
      primary = (
        <Button type="button" onClick={() => openAiConnector(aiPrefilledChatLink(client.id, prompt))}>
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
    <section className="stagger-enter max-w-xl space-y-6" aria-labelledby="hem-first-thing-title">
      <div className="space-y-2">
        <p className="text-[13px] text-muted-foreground">{t(`first_thing_lead_${lead}`)}</p>
        <h2 id="hem-first-thing-title" className="text-[20px] font-medium text-strong">
          {title}
        </h2>
        <p className="text-[13px] text-muted-foreground">{why}</p>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {primary}
        {second}
      </div>

      {after.length > 0 && (
        <div className="space-y-1">
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

      <div className="space-y-1">
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
