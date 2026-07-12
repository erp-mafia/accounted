// Avatar registry for the specialized accountant agent.
//
// We use the dicebear "notionists" style: clean line illustrations that
// match the editorial monochrome brand without the cartoony feel of most
// avatar libraries. 8 hand-picked seeds give distinct faces without being
// overwhelming. The user picks one during Phase B review; the choice is
// persisted as agent_profiles.avatar_id.
//
// URLs are served by dicebear's free CDN. They're public SVGs derived from
// the seed only: no user data leaves gnubok. If we ever need fully offline
// generation, swap to @dicebear/core npm package and render server-side.

export interface AvatarOption {
  id: string
  label: string
  url: string
}

// Build URL from seed. Public dicebear CDN. ?radius=50 rounds the bounding
// box; ?backgroundColor=transparent keeps the editorial paper-white feel.
function dicebearNotionists(seed: string): string {
  return `https://api.dicebear.com/9.x/notionists/svg?seed=${encodeURIComponent(seed)}&radius=50&backgroundColor=f5f3ed`
}

// Eight neutral seeds: names chosen to produce visibly different faces.
// Labels are just for the picker tooltip; the user names the agent
// themselves in the adjacent text field.
export const AVATAR_OPTIONS: readonly AvatarOption[] = [
  { id: 'notionists-1', label: 'Linn', url: dicebearNotionists('linn-revisor-1') },
  { id: 'notionists-2', label: 'Erik', url: dicebearNotionists('erik-revisor-2') },
  { id: 'notionists-3', label: 'Maja', url: dicebearNotionists('maja-revisor-3') },
  { id: 'notionists-4', label: 'Anders', url: dicebearNotionists('anders-revisor-4') },
  { id: 'notionists-5', label: 'Karin', url: dicebearNotionists('karin-revisor-5') },
  { id: 'notionists-6', label: 'Johan', url: dicebearNotionists('johan-revisor-6') },
  { id: 'notionists-7', label: 'Eva', url: dicebearNotionists('eva-revisor-7') },
  { id: 'notionists-8', label: 'Per', url: dicebearNotionists('per-revisor-8') },
]

export function getAvatarUrl(avatarId: string | null | undefined): string | null {
  if (!avatarId) return null
  return AVATAR_OPTIONS.find((a) => a.id === avatarId)?.url ?? null
}
