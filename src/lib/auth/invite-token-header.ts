/**
 * The request header the invite pages send an invitation token in when they
 * ask GET /api/team/accept who the invitation is for.
 *
 * A header, never a query parameter: a URL is written to access logs, kept in
 * browser history and can leave in a Referer header, and a token has no
 * business in any of them (CASA 2.1.1). The route refuses a request that
 * still carries `token` in its query string.
 *
 * This file imports nothing on purpose: the invite and register pages are
 * client components and read the name from here, the route reads it too.
 */
export const INVITE_TOKEN_HEADER = 'X-Invite-Token'
