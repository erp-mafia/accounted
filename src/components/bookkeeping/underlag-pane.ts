import type { UploadedFile } from './DocumentUploadZone'

/**
 * The underlag pane in Ny verifikation (crm#1954): the file attached in the
 * form, shown beside the konteringsrader so nobody books with the paper on
 * the desk. Which file it shows and whether it is open are decided here, so
 * the dialog only renders the answer.
 */

/** A finished upload the pane can show: it has its document id by now. */
export interface ViewableUnderlag {
  id: string
  fileName: string
  /** The file's own type, null when the browser did not know it (the viewer then asks the server). */
  mime: string | null
}

/** The uploaded files the pane can show, in the order they are listed in the form. */
export function viewableUnderlag(files: readonly UploadedFile[]): ViewableUnderlag[] {
  const viewable: ViewableUnderlag[] = []
  for (const file of files) {
    if (file.status !== 'uploaded' || !file.id) continue
    if (viewable.some((v) => v.id === file.id)) continue
    viewable.push({ id: file.id, fileName: file.fileName, mime: file.file.type || null })
  }
  return viewable
}

/**
 * The one to show: the one picked in the switcher while it is still
 * attached, else the first. Null when nothing is uploaded yet.
 */
export function shownUnderlag(
  underlag: readonly ViewableUnderlag[],
  pickedId: string | null,
): ViewableUnderlag | null {
  return underlag.find((u) => u.id === pickedId) ?? underlag[0] ?? null
}

/**
 * Whether the pane is open. With nothing to show it never is. Otherwise the
 * person's own choice (the show/hide control) wins once made; until then it
 * opens by itself only where it fits beside the form, and a narrow screen
 * keeps the form alone until asked.
 */
export function underlagPaneOpen({
  hasUnderlag,
  wide,
  choice,
}: {
  hasUnderlag: boolean
  wide: boolean
  choice: boolean | null
}): boolean {
  if (!hasUnderlag) return false
  return choice ?? wide
}
