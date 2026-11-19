import { SettingsShell } from '@/components/settings/SettingsShell'
import { SettingsTopBarProvider } from '@/components/settings/SettingsTopBar'

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-8">
      {/* The top bar names the section (SettingsTopBar.tsx); the section hands it its help and action. */}
      <SettingsTopBarProvider>
        <SettingsShell>{children}</SettingsShell>
      </SettingsTopBarProvider>
    </div>
  )
}
