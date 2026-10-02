'use client'

import type { AiClient } from '@/lib/onboarding/ai-clients'
import type { AiTask } from '@/lib/worklist/ai-task'
import { KvittojaktenButton } from './KvittojaktenButton'

/**
 * The AI action on an Att göra row. Only "Verifikat utan underlag" carries
 * one: Kvittojakten, whose prompt names a skill and no tenant data, so it
 * opens the chat prefilled in one click. The generic "Gör med Claude"
 * handoff (components/ai-handoff/HandoffButton) was pulled from the rows and
 * page headers on 2026-09-24 (founder: it was everywhere); the component and
 * its task kinds are kept so it can come back per surface.
 */
export function AiTaskAction({ task, ...props }: {
  clients: AiClient[]
  task: AiTask
  preferredClient?: AiClient
  onOpen?: () => void
  disabled?: boolean
}) {
  if (task.category !== 'verifikat_missing_document') return null
  return <KvittojaktenButton {...props} />
}
