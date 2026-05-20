'use client'

import Link from 'next/link'
import {
  ArrowRight,
  CheckCircle2,
  FileCheck,
  FileText,
  Landmark,
  ArrowRightLeft,
  ShieldCheck,
  Wand2,
} from 'lucide-react'
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
  const hasMigration = ENABLED_EXTENSION_IDS.has('arcim-migration')
  const hasBanking = ENABLED_EXTENSION_IDS.has('enable-banking')
  const hasSkatteverket = ENABLED_EXTENSION_IDS.has('skatteverket')

  return (
    <div className={cn('min-h-[75vh] flex flex-col items-center justify-center px-4 sm:px-0 stagger-enter', className)}>
      <div className="w-full max-w-2xl">
        {/* Header */}
        <div className="text-center mb-8 md:mb-12">
          <h1 className="font-display text-2xl md:text-3xl font-medium tracking-tight">
            Välkommen till {branding.appName.toLowerCase()}
          </h1>
          <p className="text-muted-foreground text-sm md:text-base leading-relaxed max-w-md mx-auto mt-3">
            Börja med att hämta din bokföring, sedan kopplar du banken.
            Ingenting ändras i ditt nuvarande system.
          </p>
        </div>

        {/* Step 1: Migrate bookkeeping */}
        <div className="mb-6 md:mb-8">
          <div className="flex items-center gap-3 mb-4">
            <span className={cn(
              'h-7 w-7 rounded-full flex items-center justify-center text-xs font-semibold flex-shrink-0 tabular-nums',
              hasBookkeepingImported
                ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                : 'bg-foreground text-background',
            )}>
              {hasBookkeepingImported ? <CheckCircle2 className="h-4 w-4" /> : '1'}
            </span>
            <h2 className="font-display text-base font-medium tracking-tight">
              Hämta din bokföring
            </h2>
          </div>

          {hasBookkeepingImported ? (
            <div className="ml-0 sm:ml-10 p-4 sm:p-5 rounded-xl border border-emerald-500/30 bg-emerald-500/[0.04]">
              <p className="text-sm text-emerald-900 dark:text-emerald-200 font-medium">Bokföring importerad</p>
              <p className="text-xs sm:text-sm text-muted-foreground mt-1">Klart. Du kan importera fler perioder senare från Importera-vyn.</p>
            </div>
          ) : (
          <div className="ml-0 sm:ml-10">
            {/* Single entry point for the bookkeeping step. The /import hub
                page renders the full picker (migration vs SIE upload vs
                csv data etc.) so the welcome surface stays compact. */}
            <Link
              href="/import"
              className="group block p-4 sm:p-5 rounded-xl border border-primary/20 bg-primary/[0.02] hover:bg-primary/[0.05] hover:border-primary/40 transition-all duration-150 active:scale-[0.99]"
            >
              <div className="flex items-start gap-3 sm:gap-4">
                <div className="p-2 sm:p-2.5 rounded-lg bg-primary/[0.08] group-hover:bg-primary/[0.12] transition-colors flex-shrink-0">
                  <ArrowRightLeft className="h-4 w-4 sm:h-5 sm:w-5 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium group-hover:text-primary transition-colors text-sm sm:text-base">
                    Importera bokföring
                  </p>
                  <p className="text-xs sm:text-sm text-muted-foreground mt-1 sm:mt-1.5 leading-relaxed">
                    {hasMigration
                      ? 'Hämta automatiskt från ditt nuvarande system, eller ladda upp en SIE4-fil. Inget ändras i ditt befintliga system.'
                      : 'Ladda upp en SIE4-fil från ditt nuvarande bokföringsprogram.'}
                  </p>
                  {hasMigration && (
                    <div className="flex flex-wrap gap-1.5 sm:gap-2 mt-2.5 sm:mt-3">
                      {([
                        { name: 'Fortnox', logo: '/logos/fortnox.svg' },
                        { name: 'Visma', logo: '/logos/visma.jpeg' },
                        { name: 'Bokio', logo: '/logos/bokio.png' },
                        { name: 'Björn Lundén', logo: '/logos/bjornlunden.png' },
                        { name: 'Briox', logo: '/logos/Briox_logo.png' },
                        { name: 'SIE4-fil', logo: null },
                      ] as const).map(provider => (
                        <div key={provider.name} className="flex items-center gap-1 sm:gap-1.5 rounded border border-border/60 bg-muted/30 px-1.5 sm:px-2 py-0.5 sm:py-1">
                          {provider.logo ? (
                            <img src={provider.logo} alt={provider.name} className="h-3.5 w-3.5 sm:h-4 sm:w-4 shrink-0 rounded-sm object-contain" />
                          ) : (
                            <FileText className="h-3.5 w-3.5 sm:h-4 sm:w-4 shrink-0 text-muted-foreground" />
                          )}
                          <span className="text-[10px] sm:text-[11px] font-medium text-muted-foreground">{provider.name}</span>
                        </div>
                      ))}
                    </div>
                  )}
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
                ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                : 'bg-foreground text-background',
            )}>
              {hasBankConnected ? <CheckCircle2 className="h-4 w-4" /> : '2'}
            </span>
            <h2 className="font-display text-base font-medium tracking-tight">
              Koppla din bank
            </h2>
          </div>

          <div className="ml-0 sm:ml-10">
            {hasBankConnected ? (
              <div className="p-4 sm:p-5 rounded-xl border border-emerald-500/30 bg-emerald-500/[0.04]">
                <p className="text-sm text-emerald-900 dark:text-emerald-200 font-medium">Bank kopplad</p>
                <p className="text-xs sm:text-sm text-muted-foreground mt-1">Transaktioner synkas automatiskt.</p>
              </div>
            ) : (
            <Link
              href={hasBanking ? '/import?mode=psd2' : '/import?mode=bank'}
              className="group block p-4 sm:p-5 rounded-xl border border-border/60 hover:border-primary/40 hover:bg-primary/[0.02] transition-all duration-150 active:scale-[0.99]"
            >
              <div className="flex items-start gap-3 sm:gap-4">
                <div className="p-2 sm:p-2.5 rounded-lg bg-muted/60 group-hover:bg-primary/[0.08] transition-colors flex-shrink-0">
                  <Landmark className="h-4 w-4 sm:h-5 sm:w-5 text-muted-foreground group-hover:text-primary transition-colors" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium group-hover:text-primary transition-colors text-sm sm:text-base">
                    Anslut ditt bankkonto
                  </p>
                  <p className="text-xs sm:text-sm text-muted-foreground mt-1 sm:mt-1.5 leading-relaxed">
                    {hasBanking
                      ? 'Koppla via PSD2, transaktioner synkas automatiskt varje dag.'
                      : 'Importera kontoutdrag från din bank, CSV, OFX och de flesta svenska banker.'}
                  </p>
                </div>
                <ArrowRight className="h-4 w-4 text-muted-foreground/40 group-hover:text-primary/60 mt-1 flex-shrink-0 transition-colors" />
              </div>
            </Link>
            )}
          </div>
        </div>

        {/* Step 3: Connect Skatteverket — only when the extension is enabled.
            Optional: connecting here lets gnubok submit moms + AGI and read
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
                  ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                  : 'bg-foreground text-background',
              )}>
                {hasSkatteverketConnected
                  ? <CheckCircle2 className="h-4 w-4" />
                  : '3'}
              </span>
              <h2 className="font-display text-base font-medium tracking-tight">
                Anslut Skatteverket
              </h2>
              <span className="text-xs text-muted-foreground">— valfritt</span>
            </div>

            <div className="ml-0 sm:ml-10">
              {hasSkatteverketConnected ? (
                <div className="block p-4 sm:p-5 rounded-xl border border-emerald-500/30 bg-emerald-500/[0.04]">
                  <div className="flex items-start gap-3 sm:gap-4">
                    <div className="p-2 sm:p-2.5 rounded-lg bg-emerald-500/[0.10] flex-shrink-0">
                      <FileCheck className="h-4 w-4 sm:h-5 sm:w-5 text-emerald-700 dark:text-emerald-400" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm sm:text-base text-emerald-900 dark:text-emerald-200">
                        Skatteverket anslutet
                      </p>
                      <p className="text-xs sm:text-sm text-muted-foreground mt-1 sm:mt-1.5 leading-relaxed">
                        Du kan nu skicka momsdeklaration och AGI direkt, samt se saldot på skattekontot.
                      </p>
                    </div>
                  </div>
                </div>
              ) : (
                // eslint-disable-next-line @next/next/no-html-link-for-pages -- /api route, not a Next page
                <a
                  // Plain anchor — the authorize endpoint 302-redirects to
                  // skatteverket.se; <Link> would route via Next's client
                  // router which doesn't follow cross-origin redirects.
                  href="/api/extensions/ext/skatteverket/authorize?return_to=/"
                  className="group block p-4 sm:p-5 rounded-xl border border-border/60 hover:border-primary/40 hover:bg-primary/[0.02] transition-all duration-150 active:scale-[0.99]"
                >
                  <div className="flex items-start gap-3 sm:gap-4">
                    <div className="p-2 sm:p-2.5 rounded-lg bg-muted/60 group-hover:bg-primary/[0.08] transition-colors flex-shrink-0">
                      <FileCheck className="h-4 w-4 sm:h-5 sm:w-5 text-muted-foreground group-hover:text-primary transition-colors" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium group-hover:text-primary transition-colors text-sm sm:text-base">
                        Anslut till Skatteverket med BankID
                      </p>
                      <p className="text-xs sm:text-sm text-muted-foreground mt-1 sm:mt-1.5 leading-relaxed">
                        Skicka momsdeklaration och arbetsgivardeklaration direkt, och hämta saldot på skattekontot — utan att lämna {branding.appName.toLowerCase()}.
                      </p>
                    </div>
                    <ArrowRight className="h-4 w-4 text-muted-foreground/40 group-hover:text-primary/60 mt-1 flex-shrink-0 transition-colors" />
                  </div>
                </a>
              )}
            </div>
          </div>
        )}

        {/* Step 4: Build the agent. Required — the rest of the app routes
            users to /chat as the front door, so an unbuilt agent leaves the
            home screen feeling empty. Once verified_at is set, the parent
            redirects /  → /chat and this checklist is no longer rendered. */}
        <div className="mb-8 md:mb-12">
          <div className="flex items-center gap-3 mb-4">
            <span className={cn(
              'h-7 w-7 rounded-full flex items-center justify-center text-xs font-semibold flex-shrink-0 tabular-nums',
              hasAgentBuilt
                ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                : 'bg-foreground text-background',
            )}>
              {hasAgentBuilt ? <CheckCircle2 className="h-4 w-4" /> : (hasSkatteverket ? '4' : '3')}
            </span>
            <h2 className="font-display text-base font-medium tracking-tight">
              Skapa din assistent
            </h2>
          </div>

          <div className="ml-0 sm:ml-10">
            {hasAgentBuilt ? (
              <div className="p-4 sm:p-5 rounded-xl border border-emerald-500/30 bg-emerald-500/[0.04]">
                <div className="flex items-start gap-3 sm:gap-4">
                  <div className="p-2 sm:p-2.5 rounded-lg bg-emerald-500/[0.10] flex-shrink-0">
                    <Wand2 className="h-4 w-4 sm:h-5 sm:w-5 text-emerald-700 dark:text-emerald-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm sm:text-base text-emerald-900 dark:text-emerald-200">
                      Assistenten är klar
                    </p>
                    <p className="text-xs sm:text-sm text-muted-foreground mt-1 sm:mt-1.5 leading-relaxed">
                      Du kan börja chatta direkt. Justera tonalitet och kunskap i Inställningar &gt; Assistentens minne.
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <Link
                href="/onboarding/agent"
                className="group block p-4 sm:p-5 rounded-xl border border-border/60 hover:border-primary/40 hover:bg-primary/[0.02] transition-all duration-150 active:scale-[0.99]"
              >
                <div className="flex items-start gap-3 sm:gap-4">
                  <div className="p-2 sm:p-2.5 rounded-lg bg-muted/60 group-hover:bg-primary/[0.08] transition-colors flex-shrink-0">
                    <Wand2 className="h-4 w-4 sm:h-5 sm:w-5 text-muted-foreground group-hover:text-primary transition-colors" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium group-hover:text-primary transition-colors text-sm sm:text-base">
                      Bygg din bokföringsassistent
                    </p>
                    <p className="text-xs sm:text-sm text-muted-foreground mt-1 sm:mt-1.5 leading-relaxed">
                      En kort intervju kalibrerar tonalitet, signatur och vad assistenten ska kunna. Tar under en minut.
                    </p>
                  </div>
                  <ArrowRight className="h-4 w-4 text-muted-foreground/40 group-hover:text-primary/60 mt-1 flex-shrink-0 transition-colors" />
                </div>
              </Link>
            )}
          </div>
        </div>

        {/* Escape hatch */}
        <div className="space-y-5">
          <div className="flex items-center gap-4">
            <div className="flex-1 h-px bg-border/60" />
            <span className="text-xs text-muted-foreground">eller</span>
            <div className="flex-1 h-px bg-border/60" />
          </div>

          <div className="text-center">
            <button
              onClick={onFreshStart}
              className="text-sm text-muted-foreground hover:text-foreground transition-colors inline-flex items-center gap-1.5 group"
            >
              Jag startar en ny verksamhet utan tidigare bokföring
              <ArrowRight className="h-3.5 w-3.5 group-hover:translate-x-0.5 transition-transform" />
            </button>
          </div>

          <div className="flex items-center justify-center gap-2 pt-2">
            <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground/40" />
            <p className="text-xs text-muted-foreground/50">
              Din data är krypterad och lagras säkert i Sverige
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
