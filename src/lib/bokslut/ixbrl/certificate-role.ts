/**
 * The fastställelseintyg's företrädarroll is an enumeration in Bolagsverket's
 * comp-base schema (se-comp-base 2020-12-01): Styrelseledamot,
 * Styrelsesuppleant, Verkställande direktör, Likvidator, Likvidatorssuppleant.
 * Any other value is a schema error at Bolagsverket.
 *
 * The signer roster speaks the app's vocabulary (SIGNER_ROLES): a
 * Styrelseordförande signs the intyg in the capacity of board member, and
 * "VD" abbreviates verkställande direktör. Who may sign is unchanged
 * (CERTIFICATE_SIGNER_ROLES, every roster role); only the word written into
 * the document and sent to Bolagsverket is translated here. Translating where
 * the role is written, not where it is stored, also covers versions locked
 * before this existed.
 *
 * An unknown role passes through unchanged so the FactWriter's enumeration
 * check fails generation loudly instead of a guess being filed.
 */

const TAXONOMY_ROLE_BY_ROSTER_ROLE: Record<string, string> = {
  styrelseledamot: 'Styrelseledamot',
  styrelseordförande: 'Styrelseledamot',
  styrelsesuppleant: 'Styrelsesuppleant',
  vd: 'Verkställande direktör',
  'verkställande direktör': 'Verkställande direktör',
  likvidator: 'Likvidator',
  likvidatorssuppleant: 'Likvidatorssuppleant',
}

export function certificateRole(role: string): string {
  const key = role.trim().replace(/\s+/g, ' ').toLocaleLowerCase('sv')
  return TAXONOMY_ROLE_BY_ROSTER_ROLE[key] ?? role
}
