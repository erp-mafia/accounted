'use client'

import type { AiClient } from '@/lib/onboarding/ai-clients'
import type { AiTask } from '@/lib/worklist/ai-task'
import { KvittojaktenButton } from './KvittojaktenButton'

/**
 * The AI action on an Att göra row. Only "Verifikat utan underlag" carries
 * one: Kvittojakten, whose prompt names a skill and no tenant data, so it
 * opens the chat prefilled in one click. The generic "Gör med Claude"
 * handoff was pulled from the rows and page headers on 2026-09-24 (founder:
 * it was everywhere) and deleted on 2026-10-12; the MCP accounting-task tool
 * still offers its task list (lib/ai-handoff/tasks).
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
