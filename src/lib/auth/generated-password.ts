import crypto from 'crypto'

/**
 * Server-generated passwords for auth users who will never see them (a BankID
 * signup creates the account with one and records `has_password: false`).
 *
 * The password still has to pass the GoTrue password policy of whatever
 * project the app runs against, and the app cannot read that policy. GoTrue
 * (`checkPasswordStrength`) applies three rules:
 *
 *   1. at most 72 bytes (bcrypt), else `validation_failed`;
 *   2. at least `password_min_length` bytes, else `weak_password`;
 *   3. for every set in `password_required_characters`, at least one character
 *      of that set, else `weak_password`.
 *
 * The sets a Supabase project can choose are lowercase, uppercase, digits and
 * the symbol class below. A generator that does not know these rules passes
 * only by luck: 32 random bytes as base64url carry '-' or '_' (the only two
 * symbols in that alphabet) on about 74 percent of draws, so with symbols
 * required roughly one signup in four was refused as `weak_password`.
 *
 * This one satisfies every rule by construction, whichever of those policies
 * is active: one character drawn from each class, the rest drawn from all
 * four, shuffled. (A self-hosted operator can hand-write an arbitrary set in
 * GOTRUE_PASSWORD_REQUIRED_CHARACTERS; only the four classes are guaranteed,
 * though 60 characters spread over all of printable ASCII make a miss on a
 * narrower custom set unlikely.)
 */

/** GoTrue rejects anything longer: bcrypt reads at most 72 bytes. */
export const GOTRUE_MAX_PASSWORD_BYTES = 72

/**
 * Every character is one byte. 64 deliberately stays clear of the 72-byte
 * ceiling instead of sitting on it: at exactly 72 the password is accepted only
 * while GoTrue compares "longer than 72", and an Auth version, fork or
 * self-hosted build that compares "72 or longer", or counts differently, would
 * then refuse EVERY generated password, with GoTrue outside this repo's test
 * loop. The price of the margin is a project whose `password_min_length` is set
 * to 65..72, which would refuse nearly every human password too.
 */
export const GENERATED_PASSWORD_LENGTH = 64

/**
 * The four character sets GoTrue can require. `symbols` is GoTrue's symbol
 * class verbatim (the `lower_upper_letters_digits_symbols` preset). Together
 * they are the 94 printable ASCII characters other than the space.
 */
export const PASSWORD_CHARACTER_CLASSES = {
  lowercase: 'abcdefghijklmnopqrstuvwxyz',
  uppercase: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digits: '0123456789',
  symbols: '!@#$%^&*()_+-=[]{};\'\\:"|<>?,./`~',
} as const

const REQUIRED_CLASSES = Object.values(PASSWORD_CHARACTER_CLASSES)
const FULL_ALPHABET = REQUIRED_CLASSES.join('')

/**
 * Returns a random password that every Supabase password policy accepts.
 *
 * Entropy: the 60 characters that are not class guarantees are independent and
 * uniform over 94 symbols, so no password is more likely than 94^-60, which is
 * at least 393 bits (the generator this replaces had 256). The guaranteed
 * characters and the shuffle only add to that.
 *
 * `randomInt(max)` must return a uniform integer in [0, max). The default,
 * `crypto.randomInt`, is a CSPRNG with rejection sampling, so indexing an
 * alphabet with it has no modulo bias. The parameter exists for tests only.
 */
export function generateAuthPassword(
  randomInt: (max: number) => number = crypto.randomInt
): string {
  const chars: string[] = []

  for (const characterClass of REQUIRED_CLASSES) {
    chars.push(characterClass[randomInt(characterClass.length)])
  }
  while (chars.length < GENERATED_PASSWORD_LENGTH) {
    chars.push(FULL_ALPHABET[randomInt(FULL_ALPHABET.length)])
  }

  // Fisher-Yates, so the guaranteed characters do not sit at known positions.
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1)
    const swap = chars[i]
    chars[i] = chars[j]
    chars[j] = swap
  }

  return chars.join('')
}
