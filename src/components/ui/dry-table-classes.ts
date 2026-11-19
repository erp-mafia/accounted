/**
 * The list table's cell classes, in a module without 'use client', so a
 * server component can read them as plain strings. Imported from the client
 * module dry-table.tsx a server component would get a reference, not the
 * string, and cn() around it drops the class. dry-table.tsx re-exports them.
 */
export const LIST_BLEED_CLASS = '-mx-2'
export const TH_CLASS =
  'h-8 px-2 text-left align-middle text-[12px] font-medium leading-4 text-muted-foreground border-b-hairline whitespace-nowrap'
export const TD_CLASS = 'h-11 px-2 py-3 border-b-hairline align-top'
