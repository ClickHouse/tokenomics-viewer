#!/bin/bash
set -euo pipefail

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
output_dir="${TOKENOMICS_APP_OUTPUT_DIR:-$script_dir/dist}"
signing_identity="${TOKENOMICS_CODESIGN_IDENTITY:--}"
run_tests=1

if [[ -z "${DEVELOPER_DIR:-}" && -d /Applications/Xcode.app/Contents/Developer ]]; then
    export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
fi

build_cache_dir="$script_dir/.build/tokenomics-cache"
export XDG_CACHE_HOME="$build_cache_dir/xdg"
export CLANG_MODULE_CACHE_PATH="$build_cache_dir/clang-module-cache"
export SWIFTPM_MODULECACHE_OVERRIDE="$build_cache_dir/swift-module-cache"
swiftpm_cache_dir="$build_cache_dir/swiftpm-cache"
swiftpm_config_dir="$build_cache_dir/swiftpm-config"
swiftpm_security_dir="$build_cache_dir/swiftpm-security"
mkdir -p \
    "$XDG_CACHE_HOME" \
    "$CLANG_MODULE_CACHE_PATH" \
    "$SWIFTPM_MODULECACHE_OVERRIDE" \
    "$swiftpm_cache_dir" \
    "$swiftpm_config_dir" \
    "$swiftpm_security_dir"

swift_package_options=(
    --disable-sandbox
    --cache-path "$swiftpm_cache_dir"
    --config-path "$swiftpm_config_dir"
    --security-path "$swiftpm_security_dir"
    --scratch-path "$script_dir/.build"
)

usage() {
    echo "Usage: $0 [--skip-tests] [--output DIR] [--sign IDENTITY]"
    echo
    echo "Builds and verifies Tokenomics.app. Tests run by default."
    echo "The default signing identity is '-' (ad-hoc, for local development)."
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --skip-tests)
            run_tests=0
            shift
            ;;
        --output)
            [[ $# -ge 2 ]] || { echo "--output requires a directory" >&2; exit 2; }
            output_dir="$2"
            shift 2
            ;;
        --sign)
            [[ $# -ge 2 ]] || { echo "--sign requires an identity" >&2; exit 2; }
            signing_identity="$2"
            shift 2
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "Unknown argument: $1" >&2
            usage >&2
            exit 2
            ;;
    esac
done

[[ -n "$output_dir" && "$output_dir" != "/" ]] || {
    echo "Refusing unsafe output directory: $output_dir" >&2
    exit 2
}

command -v xcrun >/dev/null || { echo "xcrun is required" >&2; exit 1; }
command -v codesign >/dev/null || { echo "codesign is required" >&2; exit 1; }
command -v plutil >/dev/null || { echo "plutil is required" >&2; exit 1; }

if [[ $run_tests -eq 1 ]]; then
    echo "==> Running Swift tests"
    (
        cd "$script_dir"
        xcrun swift test "${swift_package_options[@]}" -Xswiftc -warnings-as-errors
    )
fi

echo "==> Building release executable"
(
    cd "$script_dir"
    xcrun swift build -c release "${swift_package_options[@]}" -Xswiftc -warnings-as-errors
)
bin_dir="$(cd "$script_dir" && xcrun swift build -c release "${swift_package_options[@]}" --show-bin-path)"
executable="$bin_dir/TokenomicsMenubar"
[[ -x "$executable" ]] || { echo "Missing release executable: $executable" >&2; exit 1; }

mkdir -p "$output_dir"
staging_dir="$(mktemp -d "$output_dir/.Tokenomics.app.XXXXXX")"
cleanup() {
    [[ ! -d "$staging_dir" ]] || rm -rf -- "$staging_dir"
}
trap cleanup EXIT

mkdir -p "$staging_dir/Contents/MacOS"
install -m 0755 "$executable" "$staging_dir/Contents/MacOS/TokenomicsMenubar"
install -m 0644 "$script_dir/Info.plist" "$staging_dir/Contents/Info.plist"
plutil -lint "$staging_dir/Contents/Info.plist"

echo "==> Signing app bundle with: $signing_identity"
if [[ "$signing_identity" == "-" ]]; then
    codesign --force --sign - "$staging_dir"
else
    codesign --force --options runtime --timestamp --sign "$signing_identity" "$staging_dir"
fi
codesign --verify --deep --strict --verbose=2 "$staging_dir"

app_path="$output_dir/Tokenomics.app"
rm -rf -- "$app_path"
mv "$staging_dir" "$app_path"
trap - EXIT

bundle_identifier="$(plutil -extract CFBundleIdentifier raw -o - "$app_path/Contents/Info.plist")"
[[ "$bundle_identifier" == "com.tokenomics.viewer.menubar" ]] || {
    echo "Unexpected bundle identifier: $bundle_identifier" >&2
    exit 1
}

echo "==> Built and verified $app_path"
