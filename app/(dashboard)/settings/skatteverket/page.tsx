import { redirect } from 'next/navigation'

// Skatteverket-anslutningen ligger numera som en sektion under Skatt-fliken.
// Behålls som permanent omdirigering för gamla bokmärken och djuplänkar.
export default function SkatteverketSettingsPage() {
  redirect('/settings/tax')
}
