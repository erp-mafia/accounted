/**
 * Stil v3 field and menu classes, shared by every primitive that draws a
 * field (Input, Textarea, SelectTrigger, ToolbarSearch, the pickers) or a
 * menu row (DropdownMenu, Select, comboboxes). A hand-rolled field or menu
 * composes these instead of picking its own border, height or hover.
 */

/** The look of a field: raised control surface, focus halo, invalid and disabled states. */
export const FIELD_CLASS =
  'field-surface w-full rounded-lg text-[13px] text-foreground transition-shadow duration-150 placeholder:text-muted-foreground focus-visible:outline-none focus-visible:field-focus aria-invalid:field-invalid disabled:cursor-not-allowed disabled:field-disabled'

/** A single-line field: 32px (40px on touch), 10px insets. */
export const FIELD_LINE_CLASS = 'flex h-8 px-2.5 pointer-coarse:h-10'

/**
 * A select trigger or text field that sits in a page toolbar next to the
 * pickers and ToolbarSearch. Since Stil v3 a field is 32px everywhere, so
 * this only drops the field's full width.
 */
export const TOOLBAR_FIELD_CLASS = 'h-8 w-auto'

/** A row in a menu, listbox or combobox: 30px, 6px radius, the hover wash. */
export const MENU_ITEM_CLASS =
  'relative flex min-h-7.5 w-full cursor-default select-none items-center gap-2 rounded-md px-2.5 text-[13px] text-foreground outline-none transition-colors duration-150 focus:bg-secondary/60 data-[highlighted]:bg-secondary/60 data-[disabled]:pointer-events-none data-[disabled]:opacity-40'

/** A group label inside a menu: 12px/500 in sentence case, never small caps. */
export const MENU_LABEL_CLASS = 'px-2.5 pb-1 pt-2 text-[12px] font-medium leading-4 text-muted-foreground'

/** The divider between menu groups: a hairline across the menu. */
export const MENU_SEPARATOR_CLASS = '-mx-1 my-1 h-[0.5px] bg-line'
