'use client'

import { InstructionDetail } from '@/components/skills/InstructionDetail'
import { SandboxShell, providePackBody } from '../fixtures'

/** The client half of the demo item page: hands the pack's real text to the fixtures, then renders the page. */
export function SandboxItem({ segment, packBody }: { segment: string; packBody: { id: string; body: string } | null }) {
  if (packBody) providePackBody(packBody.id, packBody.body)
  return <SandboxShell><InstructionDetail segment={segment} backHref="/sandbox/agenter" /></SandboxShell>
}
