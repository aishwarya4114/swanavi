#!/usr/bin/env sh
# Secrets scan for this folder. Run from the folder root:  sh scripts/check-secrets.sh
# Prints only file:line (never the matched text). Exits 1 if anything is found.
#
# Flags:
#   1. a 64-hex string on a line that also mentions private / secret / mnemonic / seed
#   2. EVM_PRIVATE_KEY=0x... or MERCHANT_PRIVATE_KEY=0x... followed by a value (a key assigned, not just named)
#   3. any .env file (any name ending in .env or starting with .env)
#   4. any file inside a *-state*/ or agent-state folder (retained purchases, merchant SQLite stores)
#   5. the hackathon-only helper files, which must not be committed

set -u
root="${1:-.}"
found=0

# Files to scan: everything tracked-worthy, excluding node_modules and this script itself.
files=$(find "$root" -type f \
  -not -path '*/node_modules/*' \
  -not -path '*/.git/*' \
  -not -name 'check-secrets.sh' \
  -not -name 'package-lock.json')

# 1. 64-hex next to a secret-ish word (case-insensitive)
for f in $files; do
  grep -n -i -E '0x[0-9a-f]{64}|[^0-9a-f][0-9a-f]{64}[^0-9a-f]' "$f" 2>/dev/null \
    | grep -i -E 'private|secret|mnemonic|seed' \
    | cut -d: -f1 \
    | while read -r line; do
        echo "possible private key: $f:$line"
      done
done
hits=$(for f in $files; do grep -n -i -E '0x[0-9a-f]{64}|[^0-9a-f][0-9a-f]{64}[^0-9a-f]' "$f" 2>/dev/null | grep -i -c -E 'private|secret|mnemonic|seed'; done | awk '{s+=$1} END {print s+0}')
[ "$hits" -gt 0 ] && found=1

# 2. a key variable assigned a hex value
for f in $files; do
  grep -n -E '(EVM_PRIVATE_KEY|MERCHANT_PRIVATE_KEY|AGENT_PRIVATE_KEY|MERCHANT_SUBMITTER_KEY)=0x[0-9a-fA-F]{8,}' "$f" 2>/dev/null \
    | cut -d: -f1 \
    | while read -r line; do
        echo "key assigned a value: $f:$line"
      done
done
hits=$(for f in $files; do grep -c -E '(EVM_PRIVATE_KEY|MERCHANT_PRIVATE_KEY|AGENT_PRIVATE_KEY|MERCHANT_SUBMITTER_KEY)=0x[0-9a-fA-F]{8,}' "$f" 2>/dev/null; done | awk '{s+=$1} END {print s+0}')
[ "$hits" -gt 0 ] && found=1

# 3. .env files
envs=$(find "$root" -type f \( -name '.env' -o -name '.env.*' -o -name '*.env' \) -not -path '*/node_modules/*')
if [ -n "$envs" ]; then
  for f in $envs; do echo "env file present: $f"; done
  found=1
fi

# 4. state folders
states=$(find "$root" -type f \( -path '*-state*/*' -o -path '*/agent-state/*' \) -not -path '*/node_modules/*')
if [ -n "$states" ]; then
  for f in $states; do echo "state file present: $f"; done
  found=1
fi

# 5. hackathon-only helpers
helpers=$(find "$root" -maxdepth 2 -type f \( -name 'ap4m-hackathon-sdk*' -o -name 'ap4m-agent.js' -o -name 'ap4m-x402.mjs' -o -name 'example-x402-*' -o -name 'verify-receipt.mjs' \) -not -path '*/node_modules/*')
if [ -n "$helpers" ]; then
  for f in $helpers; do echo "hackathon helper present (do not commit): $f"; done
  found=1
fi

if [ "$found" -eq 0 ]; then
  echo "check-secrets: clean"
  exit 0
fi
echo "check-secrets: FOUND (see lines above)"
exit 1
