// Parallel-slot fallback. Next.js renders this for the `@settings` slot on
// every route where the intercepting route below does NOT match (i.e. every
// page except an in-app soft navigation to /settings/*, and every hard load).
// Returning null means the slot contributes nothing in those cases.
export default function SettingsSlotDefault() {
  return null
}
