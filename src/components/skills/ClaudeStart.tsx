'use client'

import { useTranslations } from 'next-intl'
import { ArrowUpRight, Bot, Check, ChevronDown, Globe, Monitor, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { AI_CLIENTS } from '@/lib/onboarding/ai-clients'
import { CLAUDE_TARGETS, type ClaudeTarget } from './run'
import { useClaudeTarget } from './claude-target'
import styles from './skills.module.css'

const TARGET_ICONS: Record<ClaudeTarget, LucideIcon> = { web: Globe, desktop: Monitor, cowork: Bot }

/**
 * "Starta i Claude" as the app's split button (components/ui/split-button):
 * one joined button, the caret opens where else it can start. Picking a
 * place starts there and makes it the button's face; the choice is
 * remembered in this browser, so a Desktop user picks it once. Only for
 * Claude; other clients keep their one button.
 */
export function ClaudeStart({ onStart, size = 'lg' }: { onStart: (target: ClaudeTarget) => void; size?: 'lg' | 'sm' }) {
  const t = useTranslations('skills_registry')
  const [target, setTarget] = useClaudeTarget()
  const logo = AI_CLIENTS.find((c) => c.id === 'claude')!.logo
  function start(next: ClaudeTarget) {
    setTarget(next)
    onStart(next)
  }
  return (
    <span className={styles.splitStart}>
      <Button size={size} className="gap-2 rounded-r-none pl-4" onClick={() => onStart(target)}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={logo} alt="" width={16} height={16} className={styles.btnLogo} />
        {t(`start_in_${target}`)}
        <ArrowUpRight className="h-4 w-4" aria-hidden />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size={size} className="rounded-l-none border-l border-primary-foreground/20 px-2.5" aria-label={t('start_where')}>
            <ChevronDown className="h-4 w-4" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[260px]">
          {CLAUDE_TARGETS.map((o) => {
            const Icon = TARGET_ICONS[o]
            return (
              <DropdownMenuItem key={o} className="items-start gap-2.5 py-2" onSelect={() => start(o)}>
                <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] text-foreground">{t(`open_in_${o}`)}</span>
                  <span className="block text-[11px] leading-snug text-muted-foreground">{t(`open_in_${o}_note`)}</span>
                </span>
                {o === target && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />}
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  )
}
