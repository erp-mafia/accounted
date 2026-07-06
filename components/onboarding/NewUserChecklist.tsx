'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import {
  ArrowRight,
  CheckCircle2,
  FileCheck,
  FileText,
  Landmark,
  ArrowRightLeft,
  MessageCircle,
  ShieldCheck,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import { getBranding } from '@/lib/branding/service'

const branding = getBranding()

interface NewUserChecklistProps {
  onFreshStart: () => void
  className?: string
  /**
   * Per-step completion flags. The render flips each step from CTA to a
   * compact "done" card when its corresponding flag is true so the user
   * sees their progress without having to remember what they finished.
   */
  hasBookkeepingImported?: boolean
  hasBankConnected?: boolean
  hasSkatteverketConnected?: boolean
  hasAgentBuilt?: boolean
}

export default function NewUserChecklist({
  onFreshStart,
  className,
  hasBookkeepingImported,
  hasBankConnected,
  hasSkatteverketConnected,
  hasAgentBuilt,
}: NewUserChecklistProps) {
  const t = useTranslations('new_user_checklist')
  const hasMigration = ENABLED_EXTENSION_IDS.has('arcim-migration')
  const hasBanking = ENABLED_EXTENSION_IDS.has('enable-banking')
  const hasSkatteverket = ENABLED_EXTENSION_IDS.has('skatteverket')

  return (
    <div className={cn('min-h-[75vh] flex flex-col items-center justify-center px-4 sm:px-0 stagger-enter', className)}>
      <div className="w-full max-w-2xl">
        {/* Header: centered welcome. Data-import steps lead; building the
            assistant is the last step so a user coming from another system
            brings their books in first. */}
        <div className="text-center mb-8 md:mb-12">
          <h1 className="font-display text-2xl md:text-3xl tracking-tight">
            {t('welcome', { appName: branding.appName.toLowerCase() })}
          </h1>
          <p className="text-muted-foreground text-sm md:text-base leading-relaxed max-w-md mx-auto mt-3">
            {t('intro')}
          </p>
        </div>

        {/* Step 1: Migrate bookkeeping */}
        <div className="mb-6 md:mb-8">
          <div className="flex items-center gap-3 mb-4">
            <span className={cn(
              'h-7 w-7 rounded-full flex items-center justify-center text-xs font-semibold flex-shrink-0 tabular-nums',
              hasBookkeepingImported
                ? 'bg-secondary text-foreground'
                : 'bg-foreground text-background',
            )}>
              {hasBookkeepingImported ? <CheckCircle2 className="h-4 w-4" /> : '1'}
            </span>
            <h2 className="font-display text-base tracking-tight">
              {t('step1_title')}
            </h2>
          </div>

          {hasBookkeepingImported ? (
            <div className="ml-0 sm:ml-10 p-4 sm:p-6 rounded-lg border border-border bg-secondary/40">
              <p className="text-sm text-foreground font-medium">{t('step1_done_title')}</p>
              <p className="text-xs sm:text-sm text-muted-foreground mt-1">{t('step1_done_description')}</p>
            </div>
          ) : (
          <div className="space-y-3 ml-0 sm:ml-10">
            {hasMigration && (
              <Link
                href="/import?mode=migration"
                className="group block p-4 sm:p-6 rounded-lg border border-border bg-secondary/40 hover:bg-secondary/60 hover:border-primary/40 transition-colors duration-150"
              >
                <div className="flex items-start gap-3 sm:gap-4">
                  <div className="p-2 sm:p-3 rounded-lg bg-primary/[0.08] group-hover:bg-primary/[0.12] transition-colors flex-shrink-0">
                    <ArrowRightLeft className="h-4 w-4 sm:h-5 sm:w-5 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium group-hover:text-primary transition-colors text-sm sm:text-base">
                      {t('migrate_title')}
                    </p>
                    <p className="text-xs sm:text-sm text-muted-foreground mt-1 sm:mt-2 leading-relaxed underline decoration-foreground/20 underline-offset-2">
                      {t('migrate_description')}
                    </p>
                    <div className="flex flex-wrap gap-2 mt-3">
                      {([
                        { name: 'Fortnox', logo: '/logos/fortnox.svg' },
                        { name: 'Visma', logo: '/logos/visma.jpeg' },
                        { name: 'Bokio', logo: '/logos/bokio.png' },
                        { name: 'Björn Lundén', logo: '/logos/bjornlunden.png' },
                        { name: 'Briox', logo: '/logos/Briox_logo.png' },
                        { name: 'SIE4-fil', logo: null },
                      ] as const).map(provider => (
                        <div key={provider.name} className="flex items-center gap-1 rounded border border-border bg-muted/30 px-2 py-1">
                          {provider.logo ? (
                            <img src={provider.logo} alt={provider.name} className="h-3.5 w-3.5 sm:h-4 sm:w-4 shrink-0 rounded-sm object-contain" />
                          ) : (
                            <FileText className="h-3.5 w-3.5 sm:h-4 sm:w-4 shrink-0 text-muted-foreground" />
                          )}
                          <span className="text-[10px] sm:text-[11px] font-medium text-muted-foreground">{provider.name}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <ArrowRight className="h-4 w-4 text-muted-foreground/40 group-hover:text-primary/60 mt-1 flex-shrink-0 transition-colors" />
                </div>
              </Link>
            )}

            <Link
              href="/import?mode=sie"
              className="group block p-4 sm:p-6 rounded-lg border border-border hover:border-primary/40 hover:bg-primary/[0.02] transition-colors duration-150"
            >
              <div className="flex items-start gap-3 sm:gap-4">
                <div className="p-2 sm:p-3 rounded-lg bg-muted/60 group-hover:bg-primary/[0.08] transition-colors flex-shrink-0">
                  <FileText className="h-4 w-4 sm:h-5 sm:w-5 text-muted-foreground group-hover:text-primary transition-colors" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium group-hover:text-primary transition-colors text-sm sm:text-base">
                    {t('sie_title')}
                  </p>
                  <p className="text-xs sm:text-sm text-muted-foreground mt-1 sm:mt-2 leading-relaxed">
                    {t('sie_description')}
                  </p>
                </div>
                <ArrowRight className="h-4 w-4 text-muted-foreground/40 group-hover:text-primary/60 mt-1 flex-shrink-0 transition-colors" />
              </div>
            </Link>
          </div>
          )}
        </div>

        {/* Step 2: Connect bank */}
        <div className="mb-6 md:mb-8">
          <div className="flex items-center gap-3 mb-4">
            <span className={cn(
              'h-7 w-7 rounded-full flex items-center justify-center text-xs font-semibold flex-shrink-0 tabular-nums',
              hasBankConnected
                ? 'bg-secondary text-foreground'
                : 'bg-foreground text-background',
            )}>
              {hasBankConnected ? <CheckCircle2 className="h-4 w-4" /> : '2'}
            </span>
            <h2 className="font-display text-base tracking-tight">
              {t('step2_title')}
            </h2>
          </div>

          <div className="ml-0 sm:ml-10">
            {hasBankConnected ? (
              <div className="p-4 sm:p-6 rounded-lg border border-border bg-secondary/40">
                <p className="text-sm text-foreground font-medium">Bank kopplad</p>
                <p className="text-xs sm:text-sm text-muted-foreground mt-1">Transaktioner synkas automatiskt.</p>
              </div>
            ) : (
            <Link
              href={hasBanking ? '/import?mode=psd2' : '/import?mode=bank'}
              className="group block p-4 sm:p-6 rounded-lg border border-border hover:border-primary/40 hover:bg-primary/[0.02] transition-colors duration-150"
            >
              <div className="flex items-start gap-3 sm:gap-4">
                <div className="p-2 sm:p-3 rounded-lg bg-muted/60 group-hover:bg-primary/[0.08] transition-colors flex-shrink-0">
                  <Landmark className="h-4 w-4 sm:h-5 sm:w-5 text-muted-foreground group-hover:text-primary transition-colors" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium group-hover:text-primary transition-colors text-sm sm:text-base">
                    {t('bank_title')}
                  </p>
                  <p className="text-xs sm:text-sm text-muted-foreground mt-1 sm:mt-2 leading-relaxed">
                    {hasBanking
                      ? t('bank_description_psd2')
                      : t('bank_description_file')}
                  </p>
                </div>
                <ArrowRight className="h-4 w-4 text-muted-foreground/40 group-hover:text-primary/60 mt-1 flex-shrink-0 transition-colors" />
              </div>
            </Link>
            )}
          </div>
        </div>

        {/* Step 3: Connect Skatteverket, only when the extension is enabled.
            Optional: connecting here lets Accounted submit moms + AGI and read
            skattekonto saldo, but the user can skip and do it later from
            /settings/skatteverket. The OAuth flow returns to the dashboard
            via return_to=/, which clears the gate via the same path the
            user would take naturally. */}
        {hasSkatteverket && (
          <div className="mb-8 md:mb-12">
            <div className="flex items-center gap-3 mb-4">
              <span className={cn(
                'h-7 w-7 rounded-full flex items-center justify-center text-xs font-semibold flex-shrink-0 tabular-nums',
                hasSkatteverketConnected
                  ? 'bg-secondary text-foreground'
                  : 'bg-foreground text-background',
              )}>
                {hasSkatteverketConnected
                  ? <CheckCircle2 className="h-4 w-4" />
                  : '3'}
              </span>
              <h2 className="font-display text-base tracking-tight">
                {t('step3_title')}
              </h2>
              <span className="text-xs text-muted-foreground">{t('optional_suffix')}</span>
            </div>

            <div className="ml-0 sm:ml-10">
              {hasSkatteverketConnected ? (
                <div className="block p-4 sm:p-6 rounded-lg border border-border bg-secondary/40">
                  <div className="flex items-start gap-3 sm:gap-4">
                    <div className="p-2 sm:p-3 rounded-lg bg-background flex-shrink-0">
                      <FileCheck className="h-4 w-4 sm:h-5 sm:w-5 text-foreground" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm sm:text-base text-foreground">
                        {t('skatteverket_connected_title')}
                      </p>
                      <p className="text-xs sm:text-sm text-muted-foreground mt-1 sm:mt-2 leading-relaxed">
                        {t('skatteverket_connected_description')}
                      </p>
                    </div>
                  </div>
                </div>
              ) : (
                // eslint-disable-next-line @next/next/no-html-link-for-pages -- /api route, not a Next page
                <a
                  // Plain anchor: the authorize endpoint 302-redirects to
                  // skatteverket.se; <Link> would route via Next's client
                  // router which doesn't follow cross-origin redirects.
                  href="/api/extensions/ext/skatteverket/authorize?return_to=/"
                  className="group block p-4 sm:p-6 rounded-lg border border-border hover:border-primary/40 hover:bg-primary/[0.02] transition-colors duration-150"
                >
                  <div className="flex items-start gap-3 sm:gap-4">
                    <div className="p-2 sm:p-3 rounded-lg bg-muted/60 group-hover:bg-primary/[0.08] transition-colors flex-shrink-0">
                      <FileCheck className="h-4 w-4 sm:h-5 sm:w-5 text-muted-foreground group-hover:text-primary transition-colors" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium group-hover:text-primary transition-colors text-sm sm:text-base">
                        {t('skatteverket_connect_title')}
                      </p>
                      <p className="text-xs sm:text-sm text-muted-foreground mt-1 sm:mt-2 leading-relaxed">
                        {t('skatteverket_connect_description', { appName: branding.appName.toLowerCase() })}
                      </p>
                    </div>
                    <ArrowRight className="h-4 w-4 text-muted-foreground/40 group-hover:text-primary/60 mt-1 flex-shrink-0 transition-colors" />
                  </div>
                </a>
              )}
            </div>
          </div>
        )}

        {/* Build the assistant: always the last step, so a user migrating
            from another system brings their books in first. */}
        <div className="mb-8 md:mb-12">
          <div className="flex items-center gap-3 mb-4">
            <span className={cn(
              'h-7 w-7 rounded-full flex items-center justify-center text-xs font-semibold flex-shrink-0 tabular-nums',
              hasAgentBuilt
                ? 'bg-secondary text-foreground'
                : 'bg-foreground text-background',
            )}>
              {hasAgentBuilt ? <CheckCircle2 className="h-4 w-4" /> : (hasSkatteverket ? '4' : '3')}
            </span>
            <h2 className="font-display text-base tracking-tight">
              Skapa din assistent
            </h2>
          </div>

          <div className="ml-0 sm:ml-10">
            {hasAgentBuilt ? (
              <div className="p-4 sm:p-6 rounded-lg border border-border bg-secondary/40">
                <div className="flex items-start gap-3 sm:gap-4">
                  <div className="p-2 sm:p-3 rounded-lg bg-background flex-shrink-0">
                    <MessageCircle className="h-4 w-4 sm:h-5 sm:w-5 text-foreground" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm sm:text-base text-foreground">
                      Assistenten är klar
                    </p>
                    <p className="text-xs sm:text-sm text-muted-foreground mt-1 sm:mt-2 leading-relaxed">
                      Du kan börja chatta direkt. Justera tonalitet och kunskap i Inställningar &gt; Assistentens minne.
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <Link
                href="/onboarding/agent"
                className="group block p-4 sm:p-6 rounded-lg border border-border hover:border-primary/40 hover:bg-primary/[0.02] transition-colors duration-150"
              >
                <div className="flex items-start gap-3 sm:gap-4">
                  <div className="p-2 sm:p-3 rounded-lg bg-muted/60 group-hover:bg-primary/[0.08] transition-colors flex-shrink-0">
                    <MessageCircle className="h-4 w-4 sm:h-5 sm:w-5 text-muted-foreground group-hover:text-primary transition-colors" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="font-medium group-hover:text-primary transition-colors text-sm sm:text-base">
                        Bygg din bokföringsassistent
                      </p>
                      <Badge variant="secondary" className="uppercase tracking-wider">Beta</Badge>
                    </div>
                    <p className="text-xs sm:text-sm text-muted-foreground mt-1 sm:mt-2 leading-relaxed">
                      Några frågor om din verksamhet kalibrerar tonalitet, signatur och vad assistenten kan. Ju mer du delar, desto bättre förstår den dig.
                    </p>
                  </div>
                  <ArrowRight className="h-4 w-4 text-muted-foreground/40 group-hover:text-primary/60 mt-1 flex-shrink-0 transition-colors" />
                </div>
              </Link>
            )}
          </div>
        </div>

        {/* Escape hatch: a visible secondary action, not a muted ghost link,
            so users with nothing to import can clearly choose to start fresh. */}
        <div className="space-y-6">
          <div className="flex items-center gap-4">
            <div className="flex-1 h-px bg-border" />
            <span className="text-xs text-muted-foreground">{t('or_separator')}</span>
            <div className="flex-1 h-px bg-border" />
          </div>

          <div className="flex justify-center">
            <Button variant="outline" onClick={onFreshStart} className="group">
              {t('fresh_start')}
              <ArrowRight className="ml-2 h-4 w-4 group-hover:translate-x-0.5 transition-transform" />
            </Button>
          </div>

          <div className="flex items-center justify-center gap-2 pt-2">
            <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground/40" />
            <p className="text-xs text-muted-foreground/50">
              {t('security_note')}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
