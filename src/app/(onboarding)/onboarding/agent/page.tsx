import { redirect } from 'next/navigation'
import { CHAT_REPLACED_HREF } from '@/app/(dashboard)/chat/chat-switch'

// /onboarding/agent built the built-in assistant. The build is gone; the
// address stays so an old link or bookmark does not end in a 404, and leads to
// /chat: the chat for a company that has it, and for every other company the
// page that says what took its place.
export default function AgentOnboardingPage() {
  redirect(CHAT_REPLACED_HREF)
}
