'use client'

import { useTranslations } from 'next-intl'
import { InkText } from '@/components/onboarding/journey/ink'
import { Button } from '@/components/ui/button'
import { MailboxList } from '@/components/inkorg/AddMailboxDialog'
import type { MailboxDoor } from '@/lib/inkorg/mailboxes'
import type { BooksCtx } from '../context'

/**
 * The company's digital mailbox, connected without leaving the page. The
 * inbox address, WhatsApp and Gmail stay out: they are set up from Inkorg.
 */
const DOCS_DOORS: readonly MailboxDoor[] = ['kivra', 'billo']

/**
 * Underlagen: where receipts and invoices arrive, the mailbox rows inline.
 * Shown only to a company Kivra or Billo can serve (BooksFlags.hasDocs); a
 * company that already has its mailbox at Kivra is offered Kivra alone.
 */
export function DocsStep({ ctx }: { ctx: BooksCtx }) {
  const t = useTranslations('books')
  return (
    <div className="jny-qstep">
      <h1 className="jny-qtitle">
        <InkText text={t('docs_title')} />
      </h1>
      <p className="agent-lead">{t('docs_sub')}</p>
      <div className="docs-list">
        <MailboxList doors={DOCS_DOORS} receiveOnly oneDigitalMailbox connectVariant="outline" connectLabel={t('docs_connect')} />
      </div>
      <div className="jny-qactions">
        <Button size="lg" onClick={() => ctx.dispatch({ type: 'AFTER_DOCS', flags: ctx.flags })}>{t('continue')}</Button>
      </div>
    </div>
  )
}
