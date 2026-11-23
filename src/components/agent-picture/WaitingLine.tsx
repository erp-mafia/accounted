'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import type { PictureWaiting } from '@/lib/agent-context/agent-picture'
import { waitingLine } from '@/lib/agent-context/agent-picture-view'
import { PROPOSALS_HREF, QUESTIONS_HREF } from './agent-panel-parts'

const LINK_CLASS = 'font-medium text-strong underline-offset-2 hover:underline'

/**
 * The line under the company's name on its card: how many questions wait
 * for an answer and how many proposals wait for approval, across every
 * agent, each part leading to its own page. Nothing when nothing waits. The
 * numbers are the ones Hem and the menu show (GET /api/wiki/picture reads
 * them through the same counters).
 */
export function WaitingLine({ waiting }: { waiting: PictureWaiting | null }) {
  const t = useTranslations('wiki')
  const line = waitingLine(waiting)
  if (!line) return null
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
        ? t.rich('picture.waiting_both', { questions: line.questions, proposals: line.proposals, toQuestions, toProposals })
        : line.kind === 'questions'
          ? t.rich('picture.waiting_questions', { count: line.count, toQuestions })
          : t.rich('picture.waiting_proposals', { count: line.count, toProposals })}
    </span>
  )
}
