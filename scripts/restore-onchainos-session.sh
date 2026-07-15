#!/bin/sh
# scripts/restore-onchainos-session.sh
# Restore the onchainos Agentic Wallet session from a base64-encoded env var.
# This is the headless-container replacement for `onchainos wallet login` +
# OTP verification. The session was created on a machine with email access
# (the user's local machine or VPS), then exported and base64-encoded.
#
# Usage:
#   1. Set ONCHAINOS_SESSION_B64 as a Railway env var (NOT in the repo).
#   2. This script decodes + extracts on container startup, before the
#      Node app boots.
#   3. The onchainos CLI then finds the session in $ONCHAINOS_HOME and
#      uses the Agentic Wallet for all paid x402 calls.
#
# Security:
#   - The session contains an encrypted session key, not a seed phrase.
#   - Railway encrypts env vars at rest.
#   - The base64 is decoded only inside the container and never written
#     to disk in plaintext form (chmod 600 immediately after extract).

set -e

if [ -z "$ONCHAINOS_SESSION_B64" ]; then
  echo "[restore-session] ONCHAINOS_SESSION_B64 not set, skipping"
  echo "[restore-session] onchainos calls will fail unless ONCHAINOS_API_KEY env vars are set"
  exit 0
fi

# Make sure target dir exists
mkdir -p "$ONCHAINOS_HOME"

# Decode base64 → tar.gz
echo "$ONCHAINOS_SESSION_B64" | base64 -d > /tmp/onchainos-session.tar.gz

# Extract on top of $ONCHAINOS_HOME. Tar contains paths like `.onchainos/...`
# so we cd to / and extract, then move to the configured home.
cd /
tar -xzf /tmp/onchainos-session.tar.gz -C / 2>&1 || {
  echo "[restore-session] tar extract failed"
  exit 1
}

# Move .onchainos contents to ONCHAINOS_HOME if they were extracted at the default location
if [ -d "/.onchainos" ] && [ "/.onchainos" != "$ONCHAINOS_HOME" ]; then
  cp -a /.onchainos/. "$ONCHAINOS_HOME/" 2>/dev/null || true
  rm -rf /.onchainos
fi

# Lock down permissions (session files include encrypted keys)
chmod 700 "$ONCHAINOS_HOME" 2>/dev/null || true
chmod 600 "$ONCHAINOS_HOME"/* 2>/dev/null || true
chmod 600 "$ONCHAINOS_HOME"/.* 2>/dev/null || true

# Cleanup
rm -f /tmp/onchainos-session.tar.gz

echo "[restore-session] session restored to $ONCHAINOS_HOME"
ls -la "$ONCHAINOS_HOME" 2>&1 | head
