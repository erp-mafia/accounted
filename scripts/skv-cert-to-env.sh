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
# beside it in the same environment protects nothing; mark it Sensitive in
# Vercel. The PIN comes from $SKV_P12_PIN, the keyring (secret-tool, attributes
# in $SKV_SECRET_TOOL_ATTRS) or a hidden prompt, and reaches openssl through
# the environment, never argv.
#
# Usage:
#   scripts/skv-cert-to-env.sh <file.p12> info                      # subject, serial, validity; no secrets
#   scripts/skv-cert-to-env.sh <file.p12> vercel [production]       # npx vercel env add, per value
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

value_of() {
  case $1 in
    SKATTEVERKET_SYSTEM_CERT_PEM_B64) cert_pem | b64 ;;
    SKATTEVERKET_SYSTEM_KEY_PEM_B64) key_pem | b64 ;;
  esac
}
NAMES=(SKATTEVERKET_SYSTEM_CERT_PEM_B64 SKATTEVERKET_SYSTEM_KEY_PEM_B64)

case $target in
  info)
    cert_pem | openssl x509 -noout -subject -issuer -serial -startdate -enddate
    ;;

  vercel)
    for name in "${NAMES[@]}"; do
      echo "Adding $name to Vercel ($vercel_env)..." >&2
      if ! value_of "$name" | npx vercel env add "$name" "$vercel_env"; then
        echo "Failed. If $name already exists, remove it first: npx vercel env rm $name $vercel_env" >&2
        exit 1
      fi
    done
    echo "Done. Mark both as Sensitive in the Vercel dashboard, then redeploy: env vars are read at deploy." >&2
    ;;

  clipboard)
    if command -v wl-copy >/dev/null 2>&1; then copy=(wl-copy) clear=(wl-copy --clear)
    elif command -v xclip >/dev/null 2>&1; then copy=(xclip -selection clipboard) clear=(sh -c 'printf "" | xclip -selection clipboard')
    elif command -v pbcopy >/dev/null 2>&1; then copy=(pbcopy) clear=(sh -c 'printf "" | pbcopy')
    else echo "No clipboard tool found (wl-copy, xclip or pbcopy)." >&2; exit 1
    fi
    for name in "${NAMES[@]}"; do
      value_of "$name" | "${copy[@]}"
      read -rp "Copied $name. Paste it into Vercel (type Sensitive), then press Enter. " _
    done
    "${clear[@]}"
    echo "Clipboard cleared. Redeploy: env vars are read at deploy." >&2
    ;;

  env-local)
    echo "This writes the private key to .env.local in plain text." >&2
    read -rp "Only for Expisoft's TEST certificate. Type 'test' to continue: " answer
    [[ $answer == test ]] || { echo "Aborted." >&2; exit 1; }
    file=.env.local
    touch "$file"
    for name in "${NAMES[@]}"; do
      tmp=$(mktemp)
      grep -v "^$name=" "$file" >"$tmp" || true
      cat "$tmp" >"$file"
      rm -f "$tmp"
      printf '%s=%s\n' "$name" "$(value_of "$name")" >>"$file"
      echo "Wrote $name to $file." >&2
    done
    ;;

  *)
    usage
    ;;
esac
