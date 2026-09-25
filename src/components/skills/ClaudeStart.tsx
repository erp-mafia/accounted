'use client'

import { useTranslations } from 'next-intl'
import { ArrowUpRight, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { AI_CLIENTS } from '@/lib/onboarding/ai-clients'
import { CLAUDE_TARGETS, type ClaudeTarget } from './run'
import { useClaudeTarget } from './claude-target'
import styles from './skills.module.css'

/**
 * "Starta i Claude" with a choice of where: the web (default), Claude
 * Desktop or Cowork. The choice is remembered in this browser, so a Desktop
 * user picks it once. Only for Claude; other clients keep their one button.
 */
export function ClaudeStart({ onStart, size = 'lg' }: { onStart: (target: ClaudeTarget) => void; size?: 'lg' | 'sm' }) {
  const t = useTranslations('skills_registry')
  const [target, setTarget] = useClaudeTarget()
  const logo = AI_CLIENTS.find((c) => c.id === 'claude')!.logo
  return (
    <span className={styles.splitStart}>
      <Button size={size} className="gap-2 pl-4" onClick={() => onStart(target)}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={logo} alt="" width={16} height={16} className={styles.btnLogo} />
        {t(`start_in_${target}`)}
        <ArrowUpRight className="h-4 w-4" aria-hidden />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size={size === 'lg' ? 'icon' : 'icon-sm'} aria-label={t('start_where')}><ChevronDown className="h-4 w-4" aria-hidden /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>{t('start_where')}</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={target} onValueChange={(v) => setTarget(v as ClaudeTarget)}>
            {CLAUDE_TARGETS.map((o) => (
              <DropdownMenuRadioItem key={o} value={o} className="flex-col items-start gap-0.5">
                <span>{t(`open_in_${o}`)}</span>
                <small className={styles.muted}>{t(`open_in_${o}_note`)}</small>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  )
}
