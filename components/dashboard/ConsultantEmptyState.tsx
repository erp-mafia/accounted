'use client'

import Link from 'next/link'
import { Building2, Plus } from 'lucide-react'

interface ConsultantEmptyStateProps {
  firstName?: string | null
}

export default function ConsultantEmptyState({ firstName }: ConsultantEmptyStateProps) {
  const hour = new Date().getHours()
  const greeting = hour < 5 ? 'God natt' : hour < 10 ? 'Godmorgon' : hour < 14 ? 'Hej' : hour < 18 ? 'God eftermiddag' : 'God kväll'

  return (
    <div className="stagger-enter">
      <header className="mb-16">
        <h1 className="font-display text-2xl md:text-3xl tracking-tight">
          {greeting}{firstName ? `, ${firstName}` : ''}
        </h1>
      </header>

      <div className="flex flex-col items-center text-center max-w-md mx-auto">
        <div className="w-12 h-12 rounded-xl bg-muted/60 flex items-center justify-center mb-5">
          <Building2 className="h-5 w-5 text-muted-foreground" />
        </div>

        <h2 className="font-display text-lg mb-2">
          Inga företag ännu
        </h2>
        <p className="text-sm text-muted-foreground mb-8">
          Lägg till ditt första kundföretag för att komma igång med bokföringen.
        </p>

        <Link
          href="/onboarding"
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
        >
          <Plus className="h-4 w-4" />
          Lägg till företag
        </Link>
      </div>
    </div>
  )
}
