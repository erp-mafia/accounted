'use client'

/** Internal demo of the wiki's context view with example data. Auth-free (/sandbox). */

import { Suspense, useState } from 'react'
import { useTranslations } from 'next-intl'
import { PageHeader } from '@/components/ui/page-header'
import { HelpPopover } from '@/components/ui/help-popover'
import { WikiViews } from '@/components/wiki/WikiViews'
import { SandboxShell, addSandboxApi } from '../agenter/fixtures'
import { wikiSandboxApi } from './fixtures'

export default function WikiSandboxPage() {
  useState(() => addSandboxApi(wikiSandboxApi))
  const t = useTranslations('wiki')
  return (
    <SandboxShell>
      <PageHeader title={t('title')} help={<HelpPopover>{t('help')}</HelpPopover>} />
      <Suspense>
        <WikiViews facts />
      </Suspense>
    </SandboxShell>
  )
}
