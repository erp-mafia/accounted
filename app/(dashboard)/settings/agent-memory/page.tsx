import { redirect } from 'next/navigation'

// Merged into the "Assistenten" tab. Kept as a permanent redirect so existing
// links (e.g. AgentChat's "what I remember" affordance) and old bookmarks land
// in the right place.
export default function AgentMemorySettingsPage() {
  redirect('/settings/assistant')
}
