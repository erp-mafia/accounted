'use client'

import { useTranslations } from 'next-intl'
import { HandoffButton } from '@/components/ai-handoff/HandoffButton'
import { WORKLIST_TASK_KINDS } from '@/lib/ai-handoff/tasks'
import type { AiClient } from '@/lib/onboarding/ai-clients'
import type { AiTask } from '@/lib/worklist/ai-task'
import { KvittojaktenButton } from './KvittojaktenButton'

export function AiTaskAction({ task, ...props }: {
  clients: AiClient[]
  task: AiTask
  preferredClient?: AiClient
  onOpen?: () => void
  disabled?: boolean
}) {
  const t = useTranslations('dashboard')
  // "Verifikat utan underlag" hands over Kvittojakten: its prompt names a
  // skill and no tenant data, so it opens the chat prefilled in one click.
  if (task.category === 'verifikat_missing_document') {
    return <KvittojaktenButton {...props} />
  }
  return <HandoffButton {...props} task={{
    kind: WORKLIST_TASK_KINDS[task.category],
    request: t(`ai_task_${task.category}`, { count: task.count }),
    ...(task.category === 'book_skattekonto' ? { scope: { source: 'skatteverket' as const } } : {}),
  }} />
}
