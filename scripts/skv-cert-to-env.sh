#!/usr/bin/env bash
# Turn Expisoft's organisationslegitimation (.p12) into the two values the
# Skatteverket system auth reads
# (src/extensions/general/skatteverket/lib/system-auth/config.ts):
#
#   SKATTEVERKET_SYSTEM_CERT_PEM_B64  certificate plus chain, PEM, base64
#   SKATTEVERKET_SYSTEM_KEY_PEM_B64   private key, unencrypted PKCS#8 PEM, base64
#
# The key is never written to disk or the terminal: each value is piped
# straight to its target. It is stored unencrypted because a passphrase kept
# beside it in the same environment protects nothing; Vercel stores both as
# Sensitive (write-only). The PIN comes from $SKV_P12_PIN, the keyring (secret-tool, attributes
# in $SKV_SECRET_TOOL_ATTRS) or a hidden prompt, and reaches openssl through
# the environment, never argv.
#
# Usage:
#   scripts/skv-cert-to-env.sh <file.p12> info                      # subject, serial, validity; no secrets
#   scripts/skv-cert-to-env.sh <file.p12> vercel [production|preview]  # npx vercel env add --sensitive
#   scripts/skv-cert-to-env.sh <file.p12> clipboard                 # one value at a time, for the dashboard
#   scripts/skv-cert-to-env.sh <file.p12> env-local                 # .env.local, Expisoft TEST certificate only
set -euo pipefail

usage() {
  sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
  exit 2
}

[[ $# -ge 2 ]] || usage
p12=$1
target=$2
vercel_env=${3:-production}
[[ -f $p12 ]] || { echo "No such file: $p12" >&2; exit 1; }
# Sensitive variables exist only in production and preview.
[[ $vercel_env == production || $vercel_env == preview ]] || { echo "Vercel environment must be production or preview." >&2; exit 1; }

if [[ -z ${SKV_P12_PIN:-} ]] && command -v secret-tool >/dev/null 2>&1; then
  # shellcheck disable=SC2086 # the attributes are space-separated key/value pairs on purpose
  SKV_P12_PIN=$(secret-tool lookup ${SKV_SECRET_TOOL_ATTRS:-service expisoft cert accounted} 2>/dev/null || true)
fi
if [[ -z ${SKV_P12_PIN:-} ]]; then
  read -rsp "PIN for $p12: " SKV_P12_PIN
  echo >&2
fi
export SKV_P12_PIN

# Older test certificates use RC2, which OpenSSL 3 only reads with -legacy.
legacy=()
if ! openssl pkcs12 -in "$p12" -nokeys -passin env:SKV_P12_PIN >/dev/null 2>&1; then
  if openssl pkcs12 -legacy -in "$p12" -nokeys -passin env:SKV_P12_PIN >/dev/null 2>&1; then
    legacy=(-legacy)
  else
    echo "Could not open $p12: wrong PIN, or not a PKCS#12 file." >&2
    exit 1
  fi
fi

cert_pem() {
  openssl pkcs12 ${legacy[@]+"${legacy[@]}"} -in "$p12" -nokeys -passin env:SKV_P12_PIN 2>/dev/null |
    sed -n '/-----BEGIN CERTIFICATE-----/,/-----END CERTIFICATE-----/p'
}
key_pem() {
  openssl pkcs12 ${legacy[@]+"${legacy[@]}"} -in "$p12" -nocerts -nodes -passin env:SKV_P12_PIN 2>/dev/null | openssl pkey
}
b64() { base64 | tr -d '\n'; }

# The base64 value for one variable, or exit: an extraction that yields no
# PEM (say a .p12 without a private key) must never be stored as an empty
# value and reported as done.
value_of() {
  local pem
  case $1 in
    SKATTEVERKET_SYSTEM_CERT_PEM_B64) pem=$(cert_pem) || true; [[ $pem == *"-----BEGIN CERTIFICATE-----"* ]] ;;
    SKATTEVERKET_SYSTEM_KEY_PEM_B64) pem=$(key_pem) || true; [[ $pem == *"-----BEGIN PRIVATE KEY-----"* ]] ;;
  esac || { echo "No usable $1 in $p12: nothing was written." >&2; exit 1; }
  printf '%s\n' "$pem" | b64
}
NAMES=(SKATTEVERKET_SYSTEM_CERT_PEM_B64 SKATTEVERKET_SYSTEM_KEY_PEM_B64)

# Both values are extracted and checked before anything is written, so a
# missing key never leaves a target with the certificate alone.
collect() {
  CERT_VALUE=$(value_of SKATTEVERKET_SYSTEM_CERT_PEM_B64)
  KEY_VALUE=$(value_of SKATTEVERKET_SYSTEM_KEY_PEM_B64)
}
value_for() {
  if [[ $1 == SKATTEVERKET_SYSTEM_CERT_PEM_B64 ]]; then printf '%s' "$CERT_VALUE"; else printf '%s' "$KEY_VALUE"; fi
}
[[ $target == info ]] || collect

case $target in
  info)
    cert_pem | openssl x509 -noout -subject -issuer -serial -startdate -enddate
    ;;

  vercel)
    for name in "${NAMES[@]}"; do
      value=$(value_for "$name")
      echo "Adding $name to Vercel ($vercel_env, sensitive)..." >&2
      if ! printf '%s' "$value" | npx vercel env add "$name" "$vercel_env" --sensitive; then
        echo "Failed. If $name already exists, remove it first: npx vercel env rm $name $vercel_env" >&2
        exit 1
      fi
    done
    unset value CERT_VALUE KEY_VALUE
    echo "Done. Redeploy: env vars are read at deploy." >&2
    ;;

  clipboard)
    if command -v wl-copy >/dev/null 2>&1; then copy=(wl-copy) clear=(wl-copy --clear)
    elif command -v xclip >/dev/null 2>&1; then copy=(xclip -selection clipboard) clear=(sh -c 'printf "" | xclip -selection clipboard')
    elif command -v pbcopy >/dev/null 2>&1; then copy=(pbcopy) clear=(sh -c 'printf "" | pbcopy')
    else echo "No clipboard tool found (wl-copy, xclip or pbcopy)." >&2; exit 1
    fi
    for name in "${NAMES[@]}"; do
      value=$(value_for "$name")
      printf '%s' "$value" | "${copy[@]}"
      read -rp "Copied $name. Paste it into Vercel (type Sensitive), then press Enter. " _
    done
    unset value
    "${clear[@]}"
    echo "Clipboard cleared. Redeploy: env vars are read at deploy." >&2
    ;;

  env-local)
    echo "This writes the private key to .env.local in plain text." >&2
    read -rp "Only for Expisoft's TEST certificate. Type 'test' to continue: " answer
    [[ $answer == test ]] || { echo "Aborted." >&2; exit 1; }
    file=.env.local
    # Owner-only before the key goes in, whether the file is new or not.
    umask 077
    touch "$file"
    chmod 600 "$file"
    for name in "${NAMES[@]}"; do
      value=$(value_for "$name")
      tmp=$(mktemp)
      grep -v "^$name=" "$file" >"$tmp" || true
      cat "$tmp" >"$file"
      rm -f "$tmp"
      printf '%s=%s\n' "$name" "$value" >>"$file"
      echo "Wrote $name to $file." >&2
    done
    unset value
    ;;

  *)
    usage
    ;;
esac
