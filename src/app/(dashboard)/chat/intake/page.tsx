import { redirect } from 'next/navigation'
import { CHAT_REPLACED_HREF } from '../chat-switch'

// /chat/intake started the interview that followed the assistant's build.
// Both are gone; the address stays so an old link does not end in a 404, and
// leads to /chat: the chat for a company that has it, and for every other
// company the page that says what took its place.
export default function ChatIntakePage() {
  redirect(CHAT_REPLACED_HREF)
}
