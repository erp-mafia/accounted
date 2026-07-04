import { NextResponse } from 'next/server'

/**
 * DELETE /api/team/members/[id]
 * Removing team members is disabled: teams are single-user.
 */
export async function DELETE() {
  return NextResponse.json(
    { error: 'Team har bara en ägare och kan inte ändras.' },
    { status: 403 }
  )
}
