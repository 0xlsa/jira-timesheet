#!/usr/bin/env bash

set -Eeuo pipefail

ASSET_DIR="docs/store-assets/chrome"

if ! command -v identify >/dev/null 2>&1; then
  echo "ERROR: ImageMagick 'identify' is required." >&2
  exit 1
fi


function check_asset() {
  local filename="$1"
  local expected_dimensions="$2"
  local path="${ASSET_DIR}/${filename}"

  if [[ ! -f "${path}" ]]; then
    echo "ERROR: Missing asset: ${path}" >&2
    return 1
  fi

  local format
  local dimensions

  format=$(identify -format '%m' "${path}")
  dimensions=$(identify -format '%wx%h' "${path}")

  if [[ "${format}" != "PNG" ]]; then
    echo "ERROR: ${filename}: expected PNG, got ${format}" >&2
    return 1
  fi

  if [[ "${dimensions}" != "${expected_dimensions}" ]]; then
    echo "ERROR: ${filename}: expected ${expected_dimensions}, got ${dimensions}" >&2
    return 1
  fi

  printf 'OK: %-45s %s\n' "${filename}" "${dimensions}"
}


check_asset "timesheet-for-jira-marquee-promo-tile.png" "1400x560"

check_asset "timesheet-for-jira-promo-tile.png" "1571x1001"

check_asset "timesheet-for-jira-promo-tile-small.png" "440x280"


echo "All Chrome Web Store promotional assets passed validation."
