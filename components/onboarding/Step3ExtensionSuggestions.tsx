'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { getSector } from '@/lib/extensions/sectors'
import { resolveIcon } from '@/lib/extensions/icon-resolver'
import { useTranslations } from 'next-intl'
import { ArrowRight, Loader2 } from 'lucide-react'
import type { SectorSlug, ExtensionDefinition, ExtensionCategory } from '@/lib/extensions/types'

const CATEGORY_LABEL_KEY: Record<ExtensionCategory, string> = {
  accounting: 'category_accounting',
  reports: 'category_reports',
  import: 'category_import',
  operations: 'category_operations',
}

interface Step3Props {
  sectorSlug: string | null
  onNext: (data: { enabled_extensions: { sector_slug: string; extension_slug: string }[] }) => void
  onBack: () => void
  isSaving: boolean
}

export default function Step3ExtensionSuggestions({ sectorSlug, onNext, onBack, isSaving }: Step3Props) {
  const tExt = useTranslations('extensions')
  const generalSector = getSector('general')
  const selectedSector = sectorSlug ? getSector(sectorSlug as SectorSlug) : null

  const [toggles, setToggles] = useState<Record<string, boolean>>({})

  const handleToggle = (ext: ExtensionDefinition) => {
    const key = `${ext.sector}/${ext.slug}`
    setToggles(prev => ({ ...prev, [key]: !prev[key] }))
  }

  const handleSubmit = () => {
    const enabled = Object.entries(toggles)
      .filter(([, enabled]) => enabled)
      .map(([key]) => {
        const [sector_slug, extension_slug] = key.split('/')
        return { sector_slug, extension_slug }
      })
    onNext({ enabled_extensions: enabled })
  }

  const handleSkip = () => {
    onNext({ enabled_extensions: [] })
  }

  // Group: first general, then sector-specific
  const sections: { label: string; extensions: ExtensionDefinition[] }[] = []
  if (generalSector) {
    sections.push({ label: generalSector.name, extensions: generalSector.extensions })
  }
  if (selectedSector) {
    sections.push({ label: selectedSector.name, extensions: selectedSector.extensions })
  }

  const enabledCount = Object.values(toggles).filter(Boolean).length

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Välj dina tillägg</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Aktivera de verktyg du vill använda. Du kan alltid ändra detta senare under Tillägg.
        </p>
      </div>

      {sections.map(section => (
        <div key={section.label}>
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            {section.label}
          </h3>
          <div className="space-y-2">
            {section.extensions.map(ext => {
              const Icon = resolveIcon(ext.icon)
              const key = `${ext.sector}/${ext.slug}`
              const isEnabled = toggles[key] ?? false
              return (
                <div
                  key={key}
                  className={cn(
                    'flex items-center justify-between gap-3 rounded-lg border p-3 transition-colors',
                    isEnabled && 'border-primary/30 bg-primary/5'
                  )}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className={cn(
                      'flex h-9 w-9 items-center justify-center rounded-lg flex-shrink-0',
                      isEnabled ? 'bg-primary/10 text-primary' : 'bg-muted/50 text-muted-foreground'
                    )}>
                      <Icon className="h-4 w-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium">{ext.name}</p>
                        <span className="text-[10px] text-muted-foreground">
                          {tExt(CATEGORY_LABEL_KEY[ext.category])}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground line-clamp-1">{ext.description}</p>
                    </div>
                  </div>
                  <Switch
                    checked={isEnabled}
                    onCheckedChange={() => handleToggle(ext)}
                  />
                </div>
              )
            })}
          </div>
        </div>
      ))}

      <div className="flex items-center justify-between pt-4">
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={onBack}>
            Tillbaka
          </Button>
          <Button variant="ghost" onClick={handleSkip}>
            Hoppa över
          </Button>
        </div>
        <Button onClick={handleSubmit} disabled={isSaving}>
          {isSaving ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Sparar...
            </>
          ) : (
            <>
              {enabledCount > 0 ? `Nästa (${enabledCount} valda)` : 'Nästa'}
              <ArrowRight className="ml-2 h-4 w-4" />
            </>
          )}
        </Button>
      </div>
    </div>
  )
}
