'use client'

/** Internal demo of the Agenter list with example data. Auth-free (/sandbox). */

import { Suspense } from 'react'
import { SkillsPage } from '@/components/skills/SkillsPage'
import { SandboxShell } from './fixtures'

export default function AgenterSandboxPage() {
  return <SandboxShell><Suspense><SkillsPage hrefBase="/sandbox/agenter" /></Suspense></SandboxShell>
}
