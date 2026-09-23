import { redirect } from 'next/navigation'

// Säkerhetskopia + Google Drive-molnsynkronisering ligger numera under
// /import (Importera/Exportera). Den här sidan finns kvar endast som en
// permanent omdirigering så att gamla bokmärken och cloud-backup-extensionens
// `settingsPanel.path` fortfarande tar användaren till rätt plats.
//
// Query-parametrar följer med: Googles OAuth-callback landar här med
// `?cloud_backup=connected_first` (m.fl.) och kortet på /import läser dem
// för att visa rätt toast och börja polla efter första synken.
export default async function BackupSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const qs = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string') qs.set(key, value)
  }
  // Set last so an incoming ?view=... can never override the intended view.
  qs.set('view', 'export')
  redirect(`/import?${qs.toString()}#cloud-backup`)
}
