'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Loader2, Check } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'

interface SettingsFormWrapperProps {
  children: React.ReactNode
  onSave?: (formData: FormData) => Record<string, unknown>
  className?: string
}

export function SettingsFormWrapper({ children, onSave, className }: SettingsFormWrapperProps) {
  const { toast } = useToast()
  const [isSaving, setIsSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const handleSubmit = useCallback(async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!onSave) return

    const formData = new FormData(e.currentTarget)
    const updates = onSave(formData)

    if (!updates || Object.keys(updates).length === 0) return

    setIsSaving(true)
    setSaved(false)

    try {
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      })

      const result = await response.json()

      if (!response.ok) {
        throw new Error(result.error || 'Kunde inte spara inställningar')
      }

      setSaved(true)
      timerRef.current = setTimeout(() => setSaved(false), 2000)
    } catch (error) {
      toast({
        title: 'Kunde inte spara',
        description: error instanceof Error ? error.message : 'Försök igen.',
        variant: 'destructive',
      })
    }

    setIsSaving(false)
  }, [onSave, toast])

  return (
    <form onSubmit={handleSubmit} className={className}>
      {children}

      <div className="flex items-center justify-end gap-3 mt-8">
        {saved && (
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground animate-in fade-in duration-200">
            <Check className="h-3.5 w-3.5" />
            Sparat
          </span>
        )}
        <Button type="submit" disabled={isSaving} size="sm">
          {isSaving ? (
            <>
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              Sparar...
            </>
          ) : (
            'Spara ändringar'
          )}
        </Button>
      </div>
    </form>
  )
}
