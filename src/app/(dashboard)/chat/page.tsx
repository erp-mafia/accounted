import ChatEmptyState from '@/components/agent/ChatEmptyState'
import { ChatReplaced } from '@/components/agent/ChatReplaced'
import { assistantChatUntil } from '@/lib/env/assistant-chat-switch'
import { getDashboardCompanyId } from '../request-context'
import { chatSwitchedOnFor } from './chat-switch'

export const dynamic = 'force-dynamic'

// Empty state for /chat. The sidebar (in the layout) shows the list; this
// view appears when no specific conversation is selected. Offers an obvious
// entry to start a fresh general.help conversation.
//
// A company without the chat (ASSISTANT_CHAT_ENABLED) is shown what took its
// place instead: this is where the Chatt row in the menu and its other pages
// lead.
export default async function ChatIndexPage() {
  const companyId = await getDashboardCompanyId()
  if (!chatSwitchedOnFor(companyId)) return <ChatReplaced until={assistantChatUntil()} />
  return <ChatEmptyState />
}
