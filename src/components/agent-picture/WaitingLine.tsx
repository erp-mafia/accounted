'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import type { PictureWaiting } from '@/lib/agent-context/agent-picture'
import { waitingLine, waitsOnReader } from '@/lib/agent-context/agent-picture-view'
import { PROPOSALS_HREF, QUESTIONS_HREF } from './agent-panel-parts'

const LINK_CLASS = 'font-medium text-strong underline-offset-2 hover:underline'

/**
 * The line under the company's name on its card: how many questions wait
 * for an answer and how many proposals wait for approval, across every
 * agent, each part leading to its own page. Nothing when nothing waits. The
 * numbers are the ones Hem and the menu show (GET /api/wiki/picture reads
 * them through the same counters).
 *
 * The line says that they wait on the reader only for someone who can act
 * on what it names (`canAnswer` a question, `canApprove` a proposal: both
 * need more than read access). For anyone else it says what waits, with the
 * same links.
 */
export function WaitingLine({ waiting, canAnswer = true, canApprove = true }: { waiting: PictureWaiting | null; canAnswer?: boolean; canApprove?: boolean }) {
  const t = useTranslations('wiki')
  const line = waitingLine(waiting)
  if (!line) return null
  // The same sentence without whom it waits on, for a reader who cannot act on it.
  const plain = waitsOnReader(line, { canAnswer, canApprove }) ? '' : '_plain'
  const toQuestions = (chunks: ReactNode) => (
    <Link href={QUESTIONS_HREF} className={LINK_CLASS}>
      {chunks}
    </Link>
  )
  const toProposals = (chunks: ReactNode) => (
    <Link href={PROPOSALS_HREF} className={LINK_CLASS}>
      {chunks}
    </Link>
  )
  return (
    <span className="text-xs tabular-nums text-foreground/80">
      {line.kind === 'both'
        ? t.rich(`picture.waiting_both${plain}`, { questions: line.questions, proposals: line.proposals, toQuestions, toProposals })
        : line.kind === 'questions'
          ? t.rich(`picture.waiting_questions${plain}`, { count: line.count, toQuestions })
          : t.rich(`picture.waiting_proposals${plain}`, { count: line.count, toProposals })}
    </span>
  )
}
