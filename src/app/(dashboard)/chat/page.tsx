import ChatEmptyState from '@/components/agent/ChatEmptyState'
import { leaveWhenChatSwitchedOff } from './chat-switch'

export const dynamic = 'force-dynamic'

// Empty state for /chat. The sidebar (in the layout) shows the list; this
// view appears when no specific conversation is selected. Offers an obvious
// entry to start a fresh general.help conversation.
export default function ChatIndexPage() {
  leaveWhenChatSwitchedOff()
  return <ChatEmptyState />
}
