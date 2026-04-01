'use client'

import { useEffect, useState } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { SettingsNav } from '@/components/settings/SettingsSidebar'
import { useCompany } from '@/contexts/CompanyContext'
import { createClient } from '@/lib/supabase/client'

const TAB_TO_ROUTE: Record<string, string> = {
  company: '/settings/company',
  invoicing: '/settings/invoicing',
  bookkeeping: '/settings/bookkeeping',
  tax: '/settings/tax',
  team: '/settings/team',
  banking: '/settings/banking',
  templates: '/settings/templates',
  account: '/settings/account',
  api: '/settings/api',
}

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const searchParams = useSearchParams()
  const router = useRouter()
  const { company } = useCompany()
  const [isSandbox, setIsSandbox] = useState(false)

  // Fetch sandbox status
  useEffect(() => {
    if (!company?.id) return
    const supabase = createClient()
    supabase
      .from('company_settings')
      .select('is_sandbox')
      .eq('company_id', company.id)
      .single()
      .then(({ data }) => {
        if (data?.is_sandbox) setIsSandbox(true)
      })
  }, [company?.id])

  // Handle legacy ?tab= URLs
  useEffect(() => {
    const tab = searchParams.get('tab')
    if (tab && TAB_TO_ROUTE[tab]) {
      router.replace(TAB_TO_ROUTE[tab])
    }
  }, [searchParams, router])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl md:text-3xl font-medium tracking-tight">Inställningar</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Hantera ditt företag och konto
        </p>
      </div>

      <SettingsNav isSandbox={isSandbox} />

      <div>{children}</div>
    </div>
  )
}
