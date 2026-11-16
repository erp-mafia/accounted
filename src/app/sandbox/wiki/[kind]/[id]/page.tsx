'use client'

/** Internal demo of a wiki record page with example data. Auth-free (/sandbox). */

import { use, useState } from 'react'
import { WikiRecordPage } from '@/components/wiki/WikiRecordPage'
import { SandboxShell, addSandboxApi } from '../../../agenter/fixtures'
import { wikiSandboxApi } from '../../fixtures'

export default function WikiRecordSandboxPage({ params }: { params: Promise<{ kind: string; id: string }> }) {
  const { kind, id } = use(params)
  useState(() => addSandboxApi(wikiSandboxApi))
  return (
    <SandboxShell>
      <WikiRecordPage kind={kind} id={id} />
    </SandboxShell>
  )
}
