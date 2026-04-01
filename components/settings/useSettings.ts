'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { useCompany } from '@/contexts/CompanyContext'
import type { CompanySettings } from '@/types'

export function useSettings() {
  const router = useRouter()
  const { company } = useCompany()
  const [settings, setSettings] = useState<CompanySettings | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  const fetchSettings = useCallback(async () => {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { router.push('/login'); return }

    if (company?.id) {
      const { data } = await supabase
        .from('company_settings')
        .select('*')
        .eq('company_id', company.id)
        .single()
      setSettings(data)
    }

    setIsLoading(false)
  }, [company?.id, router])

  useEffect(() => {
    fetchSettings()
  }, [fetchSettings])

  const updateSettings = useCallback((updates: Partial<CompanySettings>) => {
    setSettings(prev => prev ? { ...prev, ...updates } as CompanySettings : null)
  }, [])

  return { settings, isLoading, updateSettings, refetch: fetchSettings }
}
