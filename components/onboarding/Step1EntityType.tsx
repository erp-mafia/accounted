'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Loader2, ArrowRight, Building2, User, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { EntityType } from '@/types'

interface Step1Props {
  initialData: { entity_type?: EntityType }
  onNext: (data: { entity_type: EntityType }) => void
  isSaving: boolean
}

export default function Step1EntityType({ initialData, onNext, isSaving }: Step1Props) {
  const t = useTranslations('onboarding')
  const [selected, setSelected] = useState<EntityType | undefined>(initialData.entity_type)

  // "Enskild firma" and "Aktiebolag" are statutory legal entity types: kept
  // in Swedish in both locales.
  const entityOptions: {
    value: EntityType | string
    label: string
    description: string
    icon: typeof Building2
    disabled?: boolean
  }[] = [
    {
      value: 'enskild_firma',
      label: 'Enskild firma',
      description: t('step1_ef_description'),
      icon: User,
    },
    {
      value: 'aktiebolag',
      label: 'Aktiebolag',
      description: t('step1_ab_description'),
      icon: Building2,
    },
  ]

  const handleNext = () => {
    if (!selected) {
      const msg = 'step 1: fortsätt clicked without entity type selected'
      console.error('[onboarding]', msg)
      fetch('/api/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: msg }) }).catch(() => {})
      return
    }
    onNext({ entity_type: selected })
  }

  return (
    <div className="space-y-8">
      <div className="grid gap-3">
        {entityOptions.map((option) => {
          const Icon = option.icon
          const isSelected = selected === option.value
          return (
            <button
              key={option.value}
              type="button"
              disabled={option.disabled}
              onClick={() => !option.disabled && setSelected(option.value as EntityType)}
              className="text-left w-full"
            >
              <Card
                className={cn(
                  'relative p-4 transition-colors',
                  option.disabled
                    ? 'opacity-50 cursor-not-allowed'
                    : 'cursor-pointer hover:border-primary/50',
                  isSelected && 'border-primary ring-2 ring-primary/20'
                )}
              >
                <div className="flex items-start gap-4">
                  <div className={cn(
                    'p-2 rounded-lg',
                    isSelected ? 'bg-primary/10' : 'bg-muted/50'
                  )}>
                    <Icon className={cn(
                      'h-5 w-5',
                      isSelected ? 'text-primary' : 'text-muted-foreground'
                    )} />
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{option.label}</span>
                      {option.disabled && (
                        <Badge variant="secondary" className="text-xs">{t('coming_soon')}</Badge>
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground mt-0.5">
                      {option.description}
                    </p>
                  </div>
                  {isSelected && (
                    <div className="flex-shrink-0 p-1 rounded-full bg-primary text-primary-foreground">
                      <Check className="h-3.5 w-3.5" />
                    </div>
                  )}
                </div>
              </Card>
            </button>
          )
        })}
      </div>

      <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-3">
        <Button
          onClick={handleNext}
          disabled={!selected || isSaving}
          size="lg"
          className="w-full sm:w-auto"
        >
          {isSaving ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t('saving')}
            </>
          ) : (
            <>
              {t('continue')}
              <ArrowRight className="ml-2 h-4 w-4" />
            </>
          )}
        </Button>
      </div>
    </div>
  )
}
