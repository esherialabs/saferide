#!/usr/bin/env bash
# Build a release-signed SafeRide APK on any host with JDK 17 and the Android SDK.
# Follows docs/release/android-release-playbook.md: clean source from git, expo prebuild,
# Gradle assembleRelease, then verify the package, version and signer.
#
# Secrets come from the environment or from files and are never printed:
#   SAFERIDE_ANDROID_KEYSTORE_PATH          keystore file (outside the repo)
#   SAFERIDE_ANDROID_KEYSTORE_PASSWORD      or SAFERIDE_ANDROID_KEYSTORE_PASSWORD_FILE
#   SAFERIDE_ANDROID_KEY_ALIAS
#   SAFERIDE_ANDROID_KEY_PASSWORD           or SAFERIDE_ANDROID_KEY_PASSWORD_FILE (defaults to the store password)
# Toolchain (any one of): JAVA_HOME + ANDROID_HOME already set, or SAFERIDE_TOOLS_ENV pointing at a
# file that exports them. The public build environment (EXPO_PUBLIC_*) must already be in the environment.
# Optional: SAFERIDE_OUT_DIR (default ./outputs/signed-android), SAFERIDE_WORK_DIR, EAS_BUILD_PROFILE
# (default android-release-apk), SAFERIDE_ARCHS (default arm64-v8a), SAFERIDE_BUILD_TOOLS_VERSION and
# SAFERIDE_ANDROID_PLATFORM (exact versions to require, e.g. 35.0.0 and android-35; unset means newest present),
# SAFERIDE_GRADLE_WORKERS (default 4: this account is capped at 1,024 tasks).
# Usage: scripts/build-signed-android-local.sh [--check]   (--check validates inputs only, builds nothing)
set -euo pipefail
umask 077

die() { echo "build-signed-android-local: $*" >&2; exit 1; }

# Secrets must not reach a `bash -x` trace. Tracing is switched off around every line that
# touches one and restored afterwards; the `{ set +x; } 2>/dev/null` form keeps the switch
# itself out of the trace.
XTRACE=0
case $- in *x*) XTRACE=1;; esac
trace_off() { { set +x; } 2>/dev/null; }
trace_restore() { if [ "$XTRACE" = 1 ]; then set -x; fi; }
CHECK_ONLY=false
[ "${1:-}" = "--check" ] && CHECK_ONLY=true

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Reads a secret from VAR or from the file named by VAR_FILE into a shell variable. It is not
# exported here: only the Gradle step gets it, so npm and prebuild never see it.
read_secret() { # name of variable
  trace_off
  local var="$1" filevar="${1}_FILE" file rc=0
  file="${!filevar:-}"
  if [ -n "$file" ]; then
    if [ -r "$file" ]; then printf -v "$var" '%s' "$(<"$file")"; else rc=2; fi
  fi
  if [ "$rc" = 0 ] && [ -z "${!var:-}" ]; then rc=1; fi
  # A value that came in through the environment must stop reaching child processes too.
  if [ "$rc" = 0 ]; then export -n "$var"; fi
  trace_restore
  [ "$rc" != 2 ] || die "$filevar is set but the file is not readable"
  return "$rc"
}

[ -n "${SAFERIDE_TOOLS_ENV:-}" ] && { [ -r "$SAFERIDE_TOOLS_ENV" ] || die "SAFERIDE_TOOLS_ENV is not readable"; . "$SAFERIDE_TOOLS_ENV"; }

keystore="${SAFERIDE_ANDROID_KEYSTORE_PATH:-}"
[ -n "$keystore" ] || die "SAFERIDE_ANDROID_KEYSTORE_PATH is required"
[ -f "$keystore" ] && [ -r "$keystore" ] || die "keystore file not found or not readable"
case "$(basename "$keystore")" in debug.keystore|*debug*) die "refusing a debug keystore for a release build";; esac
keystore_real="$(readlink -f "$keystore")"
repo_real="$(readlink -f "$repo_root")"
case "$keystore_real" in "$repo_real"/*) die "keystore must live outside the repository (symlinks are followed)";; esac
read_secret SAFERIDE_ANDROID_KEYSTORE_PASSWORD || die "SAFERIDE_ANDROID_KEYSTORE_PASSWORD (or _FILE) is required"
[ -n "${SAFERIDE_ANDROID_KEY_ALIAS:-}" ] || die "SAFERIDE_ANDROID_KEY_ALIAS is required"
if ! read_secret SAFERIDE_ANDROID_KEY_PASSWORD; then
  trace_off
  SAFERIDE_ANDROID_KEY_PASSWORD="$SAFERIDE_ANDROID_KEYSTORE_PASSWORD"
  trace_restore
fi

[ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/java" ] || die "JAVA_HOME (JDK 17) is required"
[ -n "${ANDROID_HOME:-}" ] && [ -d "$ANDROID_HOME" ] || die "ANDROID_HOME is required"
export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$ANDROID_HOME}" PATH="$JAVA_HOME/bin:$PATH"
# First line looks like: openjdk version "17.0.20.1" 2026-07-21 (or "1.8.0_402" for Java 8).
java_major="$("$JAVA_HOME/bin/java" -version 2>&1 | sed -n '1s/[^"]*"\([0-9]*\).*/\1/p')"
[ "$java_major" = "17" ] || die "JDK 17 is required (found ${java_major:-unknown})"
if [ -n "${SAFERIDE_BUILD_TOOLS_VERSION:-}" ]; then
  bt_dir="$ANDROID_HOME/build-tools/$SAFERIDE_BUILD_TOOLS_VERSION"
  [ -d "$bt_dir" ] || die "build-tools $SAFERIDE_BUILD_TOOLS_VERSION not found under ANDROID_HOME"
else
  bt_dir="$(ls -d "$ANDROID_HOME"/build-tools/*/ 2>/dev/null | sort -V | tail -1 || true)"
  bt_dir="${bt_dir%/}"
fi
apksigner="$bt_dir/apksigner"
aapt="$bt_dir/aapt"
[ -x "$apksigner" ] && [ -x "$aapt" ] || die "Android build-tools (apksigner, aapt) not found under ANDROID_HOME"
if [ -n "${SAFERIDE_ANDROID_PLATFORM:-}" ]; then
  [ -d "$ANDROID_HOME/platforms/$SAFERIDE_ANDROID_PLATFORM" ] \
    || die "platform $SAFERIDE_ANDROID_PLATFORM not found under ANDROID_HOME"
fi

git -C "$repo_root" diff --quiet && git -C "$repo_root" diff --cached --quiet \
  || die "working tree has uncommitted changes; the build uses committed source only"
commit="$(git -C "$repo_root" rev-parse HEAD)"

echo "build-tools: $(basename "$bt_dir")"
# React Native compiles native code with the NDK and CMake. If they are not installed, Gradle
# downloads them (needs network, accepted SDK licences and a writable ANDROID_HOME).
for tool in ndk cmake; do
  [ -d "$ANDROID_HOME/$tool" ] || echo "note: no $tool under ANDROID_HOME; Gradle will try to download it" >&2
done

if $CHECK_ONLY; then
  echo "inputs ok for commit ${commit:0:12}; nothing was built"
  exit 0
fi

if [ -n "${SAFERIDE_WORK_DIR:-}" ]; then
  work="$SAFERIDE_WORK_DIR"
else
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT
fi
out="${SAFERIDE_OUT_DIR:-$repo_root/outputs/signed-android}"
mkdir -p "$work/src" "$out"
git -C "$repo_root" archive HEAD | tar -x -C "$work/src"
cd "$work/src"

export EXPO_NO_DOTENV=1 EAS_BUILD_PLATFORM=android SAFERIDE_REQUIRE_RELEASE_SIGNING=true
export EAS_BUILD_PROFILE="${EAS_BUILD_PROFILE:-android-release-apk}"
archs="${SAFERIDE_ARCHS:-arm64-v8a}"

# No signing secret is exported yet, so install scripts cannot read one.
npm ci --no-audit --no-fund
npx expo prebuild --platform android --clean --no-install
grep -q "SAFERIDE_ANDROID_KEYSTORE_PATH" android/app/build.gradle \
  || die "prebuild did not add the release signing hook; refusing to build"
workers="${SAFERIDE_GRADLE_WORKERS:-4}"
# The signing secrets exist in the environment of this subshell only.
(
  export SAFERIDE_ANDROID_KEYSTORE_PASSWORD SAFERIDE_ANDROID_KEY_PASSWORD
  cd android && ./gradlew --no-daemon --console=plain --max-workers="$workers" \
    "-Dorg.gradle.workers.max=$workers" :app:assembleRelease \
    "-PreactNativeArchitectures=$archs" \
    -Psaferide.litertlm.enabled=true -Psaferide.litertlm.version=0.16.0 \
    -Psaferide.litertlm.realRuntimeAllowed=true
)

apk="$(ls android/app/build/outputs/apk/release/*.apk | head -1)"
"$apksigner" verify --print-certs "$apk" > "$work/signer.txt"
grep -qi "CN=Android Debug" "$work/signer.txt" && die "APK is signed with the Android debug certificate"
badging="$("$aapt" dump badging "$apk" | sed -n '1p')"

name="saferide-${commit:0:12}-signed.apk"
cp "$apk" "$out/$name"
sha="$(sha256sum "$out/$name" | cut -d' ' -f1)"
printf '%s  %s\n' "$sha" "$name" > "$out/$name.sha256"
cp "$work/signer.txt" "$out/$name.signer.txt"
echo "built $out/$name"
echo "sha256 $sha"
echo "$badging"
grep -i "SHA-256 digest" "$work/signer.txt" | head -1
