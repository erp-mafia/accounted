import {
  Bell,
  Inbox,
  Landmark,
  ShoppingCart,
  Puzzle,
  Briefcase,
  ArrowRightLeft,
  Mail,
  MessageCircle,
  Calendar,
  Cloud,
  CreditCard,
  FileCheck,
  ShoppingBag,
  Terminal,
  type LucideIcon,
} from 'lucide-react'

const ICON_MAP: Record<string, LucideIcon> = {
  Bell,
  Inbox,
  Landmark,
  ShoppingCart,
  Puzzle,
  Briefcase,
  ArrowRightLeft,
  Mail,
  MessageCircle,
  Calendar,
  Cloud,
  CreditCard,
  FileCheck,
  ShoppingBag,
  Terminal,
}

export function resolveIcon(name: string): LucideIcon {
  return ICON_MAP[name] ?? Puzzle
}
