import { redirect } from 'next/navigation'

// Företagsprofil (TIC-snapshot Bolagsuppgifter) now lives as a section on the
// Företag tab. Kept as a permanent redirect for old bookmarks and deep links.
export default function CompanyProfileSettingsPage() {
  redirect('/settings/company')
}
