// Avatar registry for the specialized accountant agent.
//
// The dicebear "notionists" style: clean line illustrations that match the
// editorial monochrome brand without the cartoony feel of most avatar
// libraries. 8 hand-picked seeds give distinct faces without being
// overwhelming. The user picks one during Phase B review; the choice is
// persisted as agent_profiles.avatar_id.
//
// The SVGs are SELF-HOSTED under public/agent-avatars, generated once from the
// dicebear API with the seeds recorded below. They used to be loaded from
// api.dicebear.com on every render, which meant every authenticated page view
// of an accounting product sent the user's IP, user-agent and referer to a
// third party, and put a CDN this app does not control on the path of a
// logged-in surface. A self-hosted or firewalled install simply showed no
// faces at all.
//
// Licence: the Notionists set is by Zoish under CC0 1.0 (public domain, no
// attribution required). Each file carries that statement in its own RDF
// metadata, so the terms travel with the asset.
//
// To regenerate or add a seed:
//   curl -o public/agent-avatars/<id>.svg \
//     "https://api.dicebear.com/9.x/notionists/svg?seed=<seed>&radius=50&backgroundColor=f5f3ed"

export interface AvatarOption {
  id: string
  label: string
  url: string
  /** The dicebear seed this file was generated from. Documentation, not runtime. */
  seed: string
}

// Labels are just for the picker tooltip; the user names the agent themselves
// in the adjacent text field. `seed` is not read at runtime: it records what
// each file was generated from, so the set can be regenerated reproducibly.
export const AVATAR_OPTIONS: readonly AvatarOption[] = [
  { id: 'notionists-1', label: 'Linn', url: '/agent-avatars/notionists-1.svg', seed: 'linn-revisor-1' },
  { id: 'notionists-2', label: 'Erik', url: '/agent-avatars/notionists-2.svg', seed: 'erik-revisor-2' },
  { id: 'notionists-3', label: 'Maja', url: '/agent-avatars/notionists-3.svg', seed: 'maja-revisor-3' },
  { id: 'notionists-4', label: 'Anders', url: '/agent-avatars/notionists-4.svg', seed: 'anders-revisor-4' },
  { id: 'notionists-5', label: 'Karin', url: '/agent-avatars/notionists-5.svg', seed: 'karin-revisor-5' },
  { id: 'notionists-6', label: 'Johan', url: '/agent-avatars/notionists-6.svg', seed: 'johan-revisor-6' },
  { id: 'notionists-7', label: 'Eva', url: '/agent-avatars/notionists-7.svg', seed: 'eva-revisor-7' },
  { id: 'notionists-8', label: 'Per', url: '/agent-avatars/notionists-8.svg', seed: 'per-revisor-8' },
]

export function getAvatarUrl(avatarId: string | null | undefined): string | null {
  if (!avatarId) return null
  return AVATAR_OPTIONS.find((a) => a.id === avatarId)?.url ?? null
}
