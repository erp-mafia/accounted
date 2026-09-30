import { getBranding } from '@/lib/branding/service'
import { escapeHtml, sanitizeSubjectLine } from './user-text'

/**
 * Community sharing emails. "Publicerad" goes to the author once the item's
 * page is live on accounted.se, with one-click shares to LinkedIn and X (the
 * page has its own share card) and a link to make a post image with their
 * photo (the page's #dela box). "Att granska" goes to Accounted's reviewers
 * when an item is shared. Titles and handles are written by users: escaped.
 * Same calm layout as the other notices, signed by the app, the destination
 * of every button shown in plain text.
 */

const SERIF = `Georgia, 'Times New Roman', serif`
const SANS = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`

export type CommunityEmailKind = 'workflow' | 'rules' | 'analysis'

const KIND_DEFINITE: Record<CommunityEmailKind, string> = { workflow: 'arbetsflödet', rules: 'kunskapen', analysis: 'analysen' }

export interface PublishedEmailData {
  title: string
  handle: string
  pageUrl: string
}

/** The share text for X, in the author's voice. LinkedIn takes only the link and shows the page's card. */
export function publishedShareLinks(data: PublishedEmailData): { linkedin: string; x: string } {
  const text = `Jag har delat "${data.title}", en öppen instruktion för AI och bokföring i ${getBranding().appName}.`
  return {
    linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(data.pageUrl)}`,
    x: `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(data.pageUrl)}`,
  }
}

export function publishedEmailSubject(data: PublishedEmailData): string {
  return sanitizeSubjectLine(`${data.title} är publicerad`)
}

function layout(title: string, content: string, footer: string): string {
  const { appName } = getBranding()
  return `
<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
</head>
<body style="margin: 0; padding: 0; font-family: ${SANS}; line-height: 1.6; color: #374151; background-color: #f5f4f1;">
  <div style="max-width: 560px; margin: 0 auto; padding: 40px 20px;">
    <div style="background: #ffffff; border: 1px solid #e7e5e0; border-radius: 12px; padding: 40px;">
      <div style="font-family: ${SERIF}; font-size: 19px; color: #111111; margin-bottom: 28px;">${appName}</div>
      <h1 style="margin: 0 0 16px 0; font-family: ${SERIF}; font-size: 23px; font-weight: 400; color: #111111; line-height: 1.3;">${title}</h1>
      ${content}
      <div style="padding-top: 20px; border-top: 1px solid #ececea;">
        <p style="margin: 0 0 12px 0; font-size: 14px; color: #374151;">Med vänliga hälsningar,<br><strong>${appName}</strong></p>
        <p style="margin: 0; font-size: 12.5px; color: #9ca3af;">${footer}</p>
      </div>
    </div>
  </div>
</body>
</html>
`
}

const PRIMARY = 'display: inline-block; background: #1a1a1a; color: #ffffff; padding: 12px 26px; border-radius: 99px; text-decoration: none; font-weight: 500; font-size: 14px;'
const SECONDARY = 'display: inline-block; background: #ffffff; color: #1a1a1a; border: 1px solid #d6d3cd; padding: 11px 25px; border-radius: 99px; text-decoration: none; font-weight: 500; font-size: 14px;'

export function publishedEmailHtml(data: PublishedEmailData): string {
  const { appName } = getBranding()
  const share = publishedShareLinks(data)
  const title = escapeHtml(data.title)
  const handle = escapeHtml(data.handle)
  const page = escapeHtml(data.pageUrl)
  const content = `
      <p style="margin: 0 0 14px 0; font-size: 15px;"><strong>${title}</strong> är granskad och ligger nu öppet på accounted.se, delad av @${handle}. Alla kan använda den med sin egen AI.</p>
      <p style="margin: 0 0 24px 0; font-size: 15px;">Vill du dela den? Sidan har ett eget delningskort, så den syns snyggt på LinkedIn och X.</p>
      <div style="margin-bottom: 12px;">
        <a href="${escapeHtml(share.linkedin)}" style="${PRIMARY} margin: 0 8px 8px 0;">Dela på LinkedIn</a>
        <a href="${escapeHtml(share.x)}" style="${SECONDARY} margin: 0 8px 8px 0;">Dela på X</a>
      </div>
      <p style="margin: 0 0 32px 0; font-size: 14px; color: #6b7280;">Vill du lägga upp en bild med ditt foto? <a href="${page}#dela" style="color: #1a1a1a;">Gör den här</a>.</p>`
  const footer = `Du får det här mejlet eftersom du delade en instruktion från ${appName}. Vill du ta tillbaka den? Öppna den under Instruktioner och välj Dra tillbaka.`
  return layout('Din instruktion är publicerad', content, footer)
}

export function publishedEmailText(data: PublishedEmailData): string {
  const { appName } = getBranding()
  const share = publishedShareLinks(data)
  return [
    'Din instruktion är publicerad',
    '',
    `${data.title} är granskad och ligger nu öppet på accounted.se, delad av @${data.handle}. Alla kan använda den med sin egen AI.`,
    '',
    'Vill du dela den? Sidan har ett eget delningskort, så den syns snyggt på LinkedIn och X.',
    '',
    `Dela på LinkedIn: ${share.linkedin}`,
    `Dela på X: ${share.x}`,
    `Gör en bild med ditt foto att lägga upp: ${data.pageUrl}#dela`,
    '',
    'Med vänliga hälsningar,',
    appName,
    '',
    `Du får det här mejlet eftersom du delade en instruktion från ${appName}. Vill du ta tillbaka den? Öppna den under Instruktioner och välj Dra tillbaka.`,
  ].join('\n')
}

export interface ReviewRequestEmailData {
  title: string
  handle: string
  kind: CommunityEmailKind
  reviewUrl: string
}

export function reviewRequestEmailSubject(data: ReviewRequestEmailData): string {
  return sanitizeSubjectLine(`Att granska: ${data.title}`)
}

export function reviewRequestEmailHtml(data: ReviewRequestEmailData): string {
  const { appName } = getBranding()
  const review = escapeHtml(data.reviewUrl)
  const content = `
      <p style="margin: 0 0 24px 0; font-size: 15px;">@${escapeHtml(data.handle)} har delat ${KIND_DEFINITE[data.kind]} <strong>${escapeHtml(data.title)}</strong>. Den publiceras först när den är granskad.</p>
      <div style="margin-bottom: 12px;"><a href="${review}" style="${PRIMARY}">Öppna granskningen</a></div>
      <p style="margin: 0 0 32px 0; font-size: 13px; color: #9ca3af;">Knappen leder till ${review}.</p>`
  return layout('Ny instruktion att granska', content, `Du får det här mejlet eftersom du granskar delade instruktioner i ${appName}.`)
}

export function reviewRequestEmailText(data: ReviewRequestEmailData): string {
  const { appName } = getBranding()
  return [
    'Ny instruktion att granska',
    '',
    `@${data.handle} har delat ${KIND_DEFINITE[data.kind]} ${data.title}. Den publiceras först när den är granskad.`,
    '',
    `Öppna granskningen: ${data.reviewUrl}`,
    '',
    `Du får det här mejlet eftersom du granskar delade instruktioner i ${appName}.`,
  ].join('\n')
}
