# Regenerate Chrome Web Store Assets

## Objective

Update the Chrome Web Store promotional images for Timesheet for Jira to reflect the current application while preserving the established branding.

## Instructions

Read and follow:

- `docs/store-assets/CLAUDE.md`
- `docs/store-assets/chrome/CLAUDE.md`

Inspect the current promotional assets, the application implementation, and the reference screenshot:

`docs/store-assets/chrome/references/current-overview.png`

The reference screenshot represents the intended current application UI. If it is missing, do not silently substitute an outdated screenshot. Locate a suitable current screenshot or ask for one.

## Assets

Regenerate these three images in place:

| Filename | Required dimensions |
|---|---:|
| `docs/store-assets/chrome/timesheet-for-jira-marquee-promo-tile.png` | 1400 × 560 px |
| `docs/store-assets/chrome/timesheet-for-jira-promo-tile.png` | 1571 × 1001 px |
| `docs/store-assets/chrome/timesheet-for-jira-promo-tile-small.png` | 440 × 280 px |

Preserve the filenames and directory structure.

## Design Requirements

- Maintain the existing Timesheet for Jira logo and visual identity.
- Use the reference screenshot to represent the current application.
- Inspect the existing assets before changing their composition.
- Preserve the light background, blue accents, navy typography, rounded cards, and restrained shadows.
- Keep the product name and primary headline prominent.
- Communicate the principal product benefits accurately:
  - Weekly timesheet overview.
  - Worklog creation and management.
  - Synchronisation with Jira.
  - Support for Jira Cloud and Data Center / Server.
- Use concise supporting text and consistent feature illustrations.
- Ensure text remains legible at the final image dimensions.
- Use the wide banner's own composition rather than resizing another asset.
- Simplify the small tile appropriately for its limited space.
- Use actual application screenshots for product UI.
- Do not invent controls, features, or interface details.

## Workflow

1. Inspect all three existing assets.
2. Inspect the reference screenshot and current application implementation.
3. Identify outdated UI, text, or design elements.
4. Plan the changes required for each asset.
5. Reuse existing source design files or editing scripts when available.
6. Generate or edit the assets using an appropriate, reproducible workflow.
7. Export each image at its required dimensions.
8. Validate and visually inspect the final files.

Do not overwrite the reference screenshot.

Do not modify unrelated application functionality or project files.

Do not claim to have captured, generated, or inspected images if those actions were not performed.

## Validation

Run:

```bash
bash docs/store-assets/chrome/scripts/validate-assets.sh
```

Then inspect the final images visually.

Verify:

- Correct dimensions and PNG format.
- Readable headlines and supporting text.
- Correct logo and branding.
- Accurate application UI.
- No unintended cropping, distortion, or rendering artefacts.
- Consistency across all three assets.
- No credentials or sensitive information.

If a check fails, fix the problem and repeat validation.

## Final Report

Summarise:

1. Changes made to each image.
2. How the reference screenshot was used.
3. Final image dimensions and file sizes.
4. Validation performed.
5. Any remaining limitations.

Do not report success for checks that were not completed.
