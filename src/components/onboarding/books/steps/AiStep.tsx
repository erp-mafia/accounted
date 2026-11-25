'use client'

import { useTranslations } from 'next-intl'
import { InkText } from '@/components/onboarding/journey/ink'
import { Button } from '@/components/ui/button'
import { AgentChips } from '../ui/AgentChips'
import { useAiConnection } from '../ui/use-ai-connection'
import type { BooksCtx } from '../context'

/**
 * Din AI: the title, the lead and the connector chips. One way forward is always there: Fortsätt when a client is
 * connected, a quiet Fortsätt utan AI otherwise.
 */
export function AiStep({ ctx }: { ctx: BooksCtx }) {
  const t = useTranslations('books')
  const { connection, connected, onConnect } = useAiConnection(ctx.findings)
  const hasClient = connected.length > 0

  return (
    <div className="jny-qstep">
      <h1 className="jny-qtitle">
        <InkText text={t('ai_step_title')} />
      </h1>
      <p className="agent-lead">{t('ai_lead')}</p>
      <AgentChips connection={connection} onConnect={onConnect} />
      <div className="jny-qactions">
        {hasClient ? (
          <Button size="lg" onClick={() => ctx.dispatch({ type: 'AFTER_AI', flags: ctx.flags })}>{t('continue')}</Button>
        ) : (
          <Button variant="ghost" className="text-muted-foreground" onClick={() => ctx.dispatch({ type: 'AFTER_AI', flags: ctx.flags })}>
            {t('ai_continue_without')}
          </Button>
        )}
      </div>
    </div>
  )
}
