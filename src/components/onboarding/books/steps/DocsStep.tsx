'use client'

import { useTranslations } from 'next-intl'
import { InkText } from '@/components/onboarding/journey/ink'
import { Button } from '@/components/ui/button'
import { MailboxList } from '@/components/inkorg/AddMailboxDialog'
import type { MailboxDoor } from '@/lib/inkorg/mailboxes'
import type { BooksCtx } from '../context'

/** The ways in that connect without leaving the page: WhatsApp and Gmail open other pages and stay out. */
const DOCS_DOORS: readonly MailboxDoor[] = ['intake_email', 'kivra', 'billo']

/** Underlagen: where receipts and invoices arrive, the mailbox rows inline. */
export function DocsStep({ ctx }: { ctx: BooksCtx }) {
  const t = useTranslations('books')
  return (
    <div className="jny-qstep">
      <h1 className="jny-qtitle">
        <InkText text={t('docs_title')} />
      </h1>
      <p className="agent-lead">{t('docs_sub')}</p>
      <div className="docs-list">
        <MailboxList doors={DOCS_DOORS} receiveOnly connectVariant="outline" />
      </div>
      <div className="jny-qactions">
        <Button size="lg" onClick={() => ctx.dispatch({ type: 'AFTER_DOCS', flags: ctx.flags })}>{t('continue')}</Button>
      </div>
    </div>
  )
}
