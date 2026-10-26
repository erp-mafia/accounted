import {
  ArrowsRightLeftIcon,
  BellIcon,
  BriefcaseIcon,
  BuildingLibraryIcon,
  CalendarIcon,
  ChatBubbleOvalLeftIcon,
  CloudIcon,
  CommandLineIcon,
  CreditCardIcon,
  DocumentCheckIcon,
  EnvelopeIcon,
  InboxIcon,
  PuzzlePieceIcon,
  ShoppingBagIcon,
  ShoppingCartIcon,
  type Icon,
} from '@/components/icons'

// Keys are the names extension manifests carry. They date from the lucide set
// and stay as they are, so no manifest changes; each resolves to a Heroicon.
const ICON_MAP: Record<string, Icon> = {
  Bell: BellIcon,
  Inbox: InboxIcon,
  Landmark: BuildingLibraryIcon,
  ShoppingCart: ShoppingCartIcon,
  Puzzle: PuzzlePieceIcon,
  Briefcase: BriefcaseIcon,
  ArrowRightLeft: ArrowsRightLeftIcon,
  Mail: EnvelopeIcon,
  MessageCircle: ChatBubbleOvalLeftIcon,
  Calendar: CalendarIcon,
  Cloud: CloudIcon,
  CreditCard: CreditCardIcon,
  FileCheck: DocumentCheckIcon,
  ShoppingBag: ShoppingBagIcon,
  Terminal: CommandLineIcon,
}

export function resolveIcon(name: string): Icon {
  return ICON_MAP[name] ?? PuzzlePieceIcon
}
