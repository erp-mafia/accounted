'use client'

import { useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { SECTORS } from '@/lib/extensions/sectors'
import { resolveIcon } from '@/lib/extensions/icon-resolver'
import { Briefcase, ArrowRight, Loader2 } from 'lucide-react'

interface Step2SectorSelectionProps {
  onNext: (data: { sector_slug: string | null }) => void
  onBack: () => void
  isSaving: boolean
}

export default function Step2SectorSelection({ onNext, onBack, isSaving }: Step2SectorSelectionProps) {
  const [selected, setSelected] = useState<string | null>(null)

  const industrySectors = SECTORS.filter(s => s.slug !== 'general')

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg">Vilken bransch verkar du inom?</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Vi anpassar verktyg och tillägg baserat på din bransch. Du kan alltid ändra detta senare.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {industrySectors.map(sector => {
          const Icon = resolveIcon(sector.icon)
          const isSelected = selected === sector.slug
          return (
            <Card
              key={sector.slug}
              className={cn(
                'cursor-pointer transition-colors',
                isSelected
                  ? 'border-primary ring-2 ring-primary/20'
                  : 'hover:border-primary/50'
              )}
              onClick={() => setSelected(sector.slug)}
            >
              <CardContent className="pt-6">
                <div className="flex items-start gap-3">
                  <div className={cn(
                    'flex h-10 w-10 items-center justify-center rounded-lg flex-shrink-0',
                    isSelected ? 'bg-primary/10 text-primary' : 'bg-muted/50 text-muted-foreground'
                  )}>
                    <Icon className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">{sector.name}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{sector.description}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {sector.extensions.length} branschverktyg
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )
        })}

        {/* "Other" option */}
        <Card
          className={cn(
            'cursor-pointer transition-all',
            selected === 'other'
              ? 'border-primary ring-2 ring-primary/20'
              : 'hover:border-primary/50'
          )}
          onClick={() => setSelected('other')}
        >
          <CardContent className="pt-6">
            <div className="flex items-start gap-3">
              <div className={cn(
                'flex h-10 w-10 items-center justify-center rounded-lg flex-shrink-0',
                selected === 'other' ? 'bg-primary/10 text-primary' : 'bg-muted/50 text-muted-foreground'
              )}>
                <Briefcase className="h-5 w-5" />
              </div>
              <div>
                <p className="text-sm font-medium">Annan bransch</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Generella verktyg utan branschspecifika tillägg
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="flex items-center justify-between pt-4">
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={onBack}>
            Tillbaka
          </Button>
          <Button variant="ghost" onClick={() => onNext({ sector_slug: null })}>
            Hoppa över
          </Button>
        </div>
        <Button
          onClick={() => onNext({ sector_slug: selected === 'other' ? null : selected })}
          disabled={!selected || isSaving}
        >
          {isSaving ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Sparar...
            </>
          ) : (
            <>
              Nästa
              <ArrowRight className="ml-2 h-4 w-4" />
            </>
          )}
        </Button>
      </div>
    </div>
  )
}
