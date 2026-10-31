#!/usr/bin/env bash
# Renders the three Chrome Web Store promotional tiles from promo.html with headless Chrome,
# at their exact sizes, into docs/store-assets/chrome/. Set CHROME to use another Chromium-based
# browser (for example CHROME=microsoft-edge).

set -Eeuo pipefail

source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
asset_dir="$(dirname "${source_dir}")"
chrome="${CHROME:-google-chrome}"

function render() {
  local tile="$1" width="$2" height="$3" output="$4"
  "${chrome}" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --allow-file-access-from-files --window-size="${width},${height}" \
    --screenshot="${asset_dir}/${output}" "file://${source_dir}/promo.html?tile=${tile}" >/dev/null 2>&1
  printf 'Rendered %s (%sx%s)\n' "${output}" "${width}" "${height}"
}

render marquee 1400 560 timesheet-for-jira-marquee-promo-tile.png
render large 1571 1001 timesheet-for-jira-promo-tile.png
render small 440 280 timesheet-for-jira-promo-tile-small.png
