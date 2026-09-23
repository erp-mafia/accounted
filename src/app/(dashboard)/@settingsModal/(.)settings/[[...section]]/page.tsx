import { SettingsModal } from '@/components/settings/SettingsModal'

// Intercepting route: catches in-app soft navigations to /settings and
// /settings/<section> and renders them as a modal in the `@settings` slot,
// leaving the page the user came from mounted in the background `children` slot.
// Hard loads / refreshes / pasted deep-links bypass interception and resolve to
// the real full-page settings route instead. The optional catch-all captures
// the bare /settings path (section === undefined → default in SettingsModal).
export default async function InterceptedSettingsModal({
  params,
}: {
  params: Promise<{ section?: string[] }>
}) {
  const { section } = await params
  return <SettingsModal sectionId={section?.[0]} />
}
