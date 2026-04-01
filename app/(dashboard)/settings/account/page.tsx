'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Sun, Moon, Monitor, LogOut } from 'lucide-react'
import { useTheme } from 'next-themes'
import { createClient } from '@/lib/supabase/client'
import { SecuritySettings } from '@/components/settings/SecuritySettings'
import { CalendarFeedSettings } from '@/components/settings/CalendarFeedSettings'
import { AccountDangerZone } from '@/components/settings/AccountDangerZone'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import { useSettings } from '@/components/settings/useSettings'

export default function AccountSettingsPage() {
  const router = useRouter()
  const supabase = createClient()
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  const hasCalendarExtension = ENABLED_EXTENSION_IDS.has('calendar')
  const { settings } = useSettings()

  useEffect(() => { setMounted(true) }, [])

  async function handleLogout() {
    await supabase.auth.signOut()
    router.push('/login')
  }

  return (
    <div className="space-y-8">
      {/* Appearance */}
      <section className="space-y-4">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Utseende
        </h2>
        {mounted && (
          <div className="flex gap-3">
            {([
              { value: 'light', label: 'Ljust', icon: Sun },
              { value: 'dark', label: 'Mörkt', icon: Moon },
              { value: 'system', label: 'System', icon: Monitor },
            ] as const).map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                type="button"
                onClick={() => setTheme(value)}
                className={`flex items-center gap-2 rounded-lg border-2 px-4 py-2.5 text-sm font-medium transition-colors ${
                  theme === value
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:border-primary/40'
                }`}
              >
                <Icon className="h-4 w-4 text-muted-foreground" />
                {label}
              </button>
            ))}
          </div>
        )}
      </section>

      {/* Security */}
      <div className="border-t border-border/8 pt-8">
        <SecuritySettings />
      </div>

      {/* Calendar feed */}
      {hasCalendarExtension && (
        <div className="border-t border-border/8 pt-8">
          <CalendarFeedSettings />
        </div>
      )}

      {/* Logout */}
      <section className="border-t border-border/8 pt-8">
        <Card>
          <CardHeader>
            <CardTitle>Kontoinställningar</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between p-4 border rounded-lg">
              <div>
                <p className="font-medium">Logga ut</p>
                <p className="text-sm text-muted-foreground">Logga ut från ditt konto</p>
              </div>
              <Button variant="outline" onClick={handleLogout}>
                <LogOut className="mr-2 h-4 w-4" />
                Logga ut
              </Button>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* Delete account — only for non-sandbox */}
      {!settings?.is_sandbox && <AccountDangerZone />}
    </div>
  )
}
