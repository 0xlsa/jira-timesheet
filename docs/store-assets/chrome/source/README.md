# Promotional tile sources

The three Chrome Web Store promotional tiles in `docs/store-assets/chrome/` are rendered from these files:

| File | What it is |
| --- | --- |
| `promo.html` | The layout of all three tiles: the logo (`icons/icon128.png`), the product name, headline, feature list, and the screenshot. `?tile=marquee`, `?tile=large`, or `?tile=small` selects the tile. The feature list is written once, in `FEATURES`, so the marquee and the large tile always say the same thing; the small tile has no feature list. |
| `app-overview@2x.png` | Screenshot of the extension, which supplies all of the product UI. Nothing in it is redrawn. |
| `render.sh` | Renders the tiles at their exact sizes with headless Chrome. |

## Regenerating the tiles

```bash
bash docs/store-assets/chrome/source/render.sh
```

The script overwrites the three PNGs in `docs/store-assets/chrome/`. It needs Google Chrome (or set `CHROME` to another Chromium-based browser) and the Roboto font, which the extension's system font stack uses on Linux. With a different font installed, text widths change, so check the output.

## Updating the screenshot

`app-overview@2x.png` is a 2× capture (1704 × 1920 px) of the extension in the light theme: the app's column of a 1280 px wide window. It shows the week of Oct 19–25, 2026, with Tuesday selected and its worklogs expanded, and My Active Issues collapsed (its default; its header shows the running timer and the pending worklog). It uses the same demonstration data as the screenshots in `docs/screenshots/`.

It's captured with the screenshots, by `docs/screenshots/source/capture.py` (see its README):

1. Run `python3 docs/screenshots/source/capture.py app-overview`.
2. Run `render.sh`.
3. Check each tile at its real size. The crops in `promo.html` (`.shot` and `.shot img` for each tile) may need adjusting if the layout moved.
