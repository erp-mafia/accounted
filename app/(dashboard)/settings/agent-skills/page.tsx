import { redirect } from 'next/navigation'

// Merged into the "Assistenten" tab (Kompetens view). Kept as a permanent
// redirect for old links.
export default function AgentSkillsSettingsPage() {
  redirect('/settings/assistant?view=skills')
}
