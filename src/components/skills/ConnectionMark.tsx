'use client'

import { FileText, Globe, Landmark } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useCashAccounts } from '@/lib/reference-data/hooks'
import { cashAccountLogoUrl } from '@/lib/cash-accounts/labels'
import type { AgentConnection } from '@/lib/agent-skills/agents'
import { GmailMark } from './SkillMarks'
import styles from './skills.module.css'

export /** A connection with its brand mark: the company's bank, Skatteverket, Peppol, or what lives in the AI. */
function ConnectionMark({ kind }: { kind: AgentConnection }) {
  const { cashAccounts } = useCashAccounts({ enabledOnly: true })
  const bank = cashAccounts.map(cashAccountLogoUrl).find((url): url is string => !!url)
  /* eslint-disable @next/next/no-img-element */
  if (kind === 'skatteverket') return <img src="/logos/skatteverket_color.svg" alt="" />
  if (kind === 'mail') return <GmailMark />
  if (kind === 'bank') return bank ? <img src={bank} alt="" /> : <Landmark className="h-4 w-4" aria-hidden />
  if (kind === 'peppol') return <FileText className="h-4 w-4" aria-hidden />
  return <Globe className="h-4 w-4" aria-hidden />
  /* eslint-enable @next/next/no-img-element */
}

/** The sources an agent works with, as a row of small marks on its card. */
export function SourceMarks({ connections }: { connections: readonly AgentConnection[] }) {
  const t = useTranslations('skills_registry')
  if (connections.length === 0) return null
  return (
    <span className={styles.marks}>
      {connections.map((c) => <span key={c} className={styles.mark} title={t(`conn_${c}`)}><ConnectionMark kind={c} /></span>)}
    </span>
  )
}
