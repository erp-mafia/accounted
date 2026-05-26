import { redirect } from 'next/navigation'

// Säkerhetskopia + Google Drive-molnsynkronisering ligger numera under
// /import (Importera/Exportera). Den här sidan finns kvar endast som en
// permanent omdirigering så att gamla bokmärken och cloud-backup-extensionens
// `settingsPanel.path` fortfarande tar användaren till rätt plats.
export default function BackupSettingsPage() {
  redirect('/import?view=export#cloud-backup')
}
