'use client'

import { useCashAccounts } from '@/lib/reference-data/hooks'
import { bankLogoUrl } from '@/lib/reconciliation/bank-logos'
import type { RegistrySkillId } from '@/lib/agent-skills/registry'
import styles from './skills.module.css'

type Mark = 'gmail' | 'skatteverket' | 'banks'

/** What each skill works with, shown as the brands' own marks. */
const SKILL_MARKS: Partial<Record<RegistrySkillId, Mark>> = {
  kvittojakten: 'gmail',
  bookkeep: 'banks',
  'reconcile-month': 'banks',
  'quarterly-vat-review': 'skatteverket',
  'payroll-monthly': 'skatteverket',
  'tax-planning': 'skatteverket',
}

const MAX_BANKS = 3

/** The company's connected banks, one mark per bank. */
function useBankLogos(): string[] {
  const { cashAccounts } = useCashAccounts({ enabledOnly: true })
  const logos = cashAccounts.map((a) => bankLogoUrl(a.bank_name, a.name)).filter((url): url is string => !!url)
  return [...new Set(logos)].slice(0, MAX_BANKS)
}

export function SkillMarks({ id }: { id: RegistrySkillId }) {
  const mark = SKILL_MARKS[id]
  const banks = useBankLogos()
  if (!mark) return null
  if (mark === 'banks' && banks.length === 0) return null
  // Small static brand icons from public/logos: next/image adds nothing here.
  /* eslint-disable @next/next/no-img-element */
  return (
    <span className={styles.marks} aria-hidden>
      {mark === 'gmail' && <span className={styles.mark}><GmailMark /></span>}
      {mark === 'skatteverket' && <span className={styles.mark}><img src="/logos/skatteverket_color.svg" alt="" /></span>}
      {mark === 'banks' && banks.map((src) => <span key={src} className={styles.mark}><img src={src} alt="" /></span>)}
    </span>
  )
  /* eslint-enable @next/next/no-img-element */
}

function GmailMark() {
  return (
    <svg viewBox="0 0 48 48">
      <path fill="#4caf50" d="M45 16.2l-5 2.75-5 4.75V40h7c1.657 0 3-1.343 3-3V16.2z" />
      <path fill="#1e88e5" d="M3 16.2l3.614 1.71L11 22.7V40H4c-1.657 0-3-1.343-3-3V16.2z" />
      <polygon fill="#e53935" points="35,11.2 24,19.45 13,11.2 12,17 13,23.7 24,31.95 35,23.7 36,17" />
      <path fill="#c62828" d="M3 12.298V16.2l8 6.5V11.2L7.4 8.504A1.61 1.61 0 0 0 6.41 8.174C4.527 8.174 3 9.7 3 11.583v.715z" />
      <path fill="#fbc02d" d="M45 12.298V16.2l-8 6.5V11.2l3.6-2.696c.286-.214.633-.33.99-.33C43.473 8.174 45 9.7 45 11.583v.715z" />
    </svg>
  )
}
