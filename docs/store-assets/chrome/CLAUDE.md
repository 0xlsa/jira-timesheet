# Chrome Web Store Promotional Assets

## Purpose

This directory contains the promotional images used to present **Timesheet for Jira** in the Chrome Web Store.

Whenever creating, updating, or reviewing these assets, follow the guidelines in this document.

The objective is to maintain a consistent visual identity, accurately represent the current product, and produce polished promotional graphics without unnecessarily redesigning existing assets.

## 1. Asset Inventory

The following promotional assets are maintained in this directory:

| Filename | Dimensions | Aspect Ratio | Purpose |
|---|---:|---:|---|
| `timesheet-for-jira-marquee-promo-tile.png` | 1400 × 560 px | 2.5:1 | Wide promotional banner |
| `timesheet-for-jira-promo-tile.png` | 1571 × 1001 px | ~1.57:1 | Standard promotional tile |
| `timesheet-for-jira-promo-tile-small.png` | 440 × 280 px | ~1.57:1 | Small promotional tile |

These dimensions describe the existing files. Before changing an asset, inspect the current files and verify the target dimensions against the repository requirements and the current Chrome Web Store specifications.

Do not change filenames or dimensions without a clear reason.

If an asset is added, update this inventory.

## 2. Source of Truth

Use the following sources in order of priority:

1. **Current extension implementation:** The actual UI, components, styles, icons, and behaviour in the repository.
2. **Current product screenshots:** Screenshots captured from the running extension.
3. **Existing promotional assets:** The established visual identity, layout conventions, and composition.
4. **This document:** The rules for maintaining visual consistency.

Promotional assets must represent the actual product.

Do not invent UI components, settings, controls, integrations, or functionality that do not exist in the implementation.

When the interface changes, update only the parts of the promotional artwork necessary to keep it accurate.

Do not treat an old promotional screenshot as proof that a feature still exists.

## 3. Brand Identity

Maintain the existing Timesheet for Jira visual identity.

### Logo and product identity

- Use the established Timesheet for Jira calendar-and-clock logo.
- Preserve the logo's proportions and visual integrity.
- Do not stretch, distort, or arbitrarily recolour the logo.
- Keep the product name clearly readable.
- Do not substitute an unrelated icon or invent a new logo as part of a routine asset update.

### Colour palette

The existing design uses:

- **Primary blue:** Interactive elements, branding, and emphasis.
- **Dark navy:** Main headings and important text.
- **Light blue-grey:** Backgrounds and supporting surfaces.
- **White:** Cards and application surfaces.
- **Green:** Selected-day emphasis and successful or completed states.
- **Muted grey:** Secondary information and inactive or empty states.
- **Purple and amber:** Supporting feature illustrations where appropriate.

Inspect the existing assets and the application's CSS to determine the actual colour values before introducing or modifying colours.

Do not approximate existing brand colours if their exact values can be obtained from the repository.

Maintain sufficient contrast between text, icons, and their backgrounds.

### Typography

- Use the existing font family and weights wherever possible.
- Use bold, prominent typography for the main promotional headline.
- Use clear secondary headings for individual features.
- Use regular-weight text for supporting descriptions.
- Preserve consistent hierarchy between headings, labels, and descriptions.
- Avoid unnecessarily small text that becomes illegible at the target image size.

Inspect the existing assets and application styles before selecting fonts or changing typography.

Do not introduce new font families without a clear design requirement.

## 4. Visual Style

The established promotional style is clean, modern, light, and product-focused.

Preserve the following characteristics:

- Light backgrounds with subtle blue gradients or soft decorative shapes.
- Rounded corners and restrained shadows.
- Clear separation between content areas.
- Consistent spacing and alignment.
- Simple, recognisable feature icons.
- Blue accents that reinforce the product identity.
- A balance between promotional text and the application screenshot.

Avoid:

- Excessive decoration.
- Heavy shadows or unnecessary borders.
- Inconsistent corner radii.
- Excessive gradients or saturated colours.
- Dense paragraphs.
- Tiny text that cannot be read at the intended display size.
- Unrelated illustrations that distract from the product.
- Arbitrary redesigns of established assets.

The extension UI should remain the primary visual proof of the product's functionality.

## 5. Product Screenshot Guidelines

Product screenshots must come from the actual extension whenever possible.

### Capturing screenshots

Before capturing a screenshot:

1. Build or run the current extension.
2. Open the extension in the appropriate browser.
3. Configure a representative state of the application.
4. Use realistic, non-sensitive example data.
5. Capture the relevant UI at a suitable resolution.

Use synthetic Jira issues, worklogs, and account details for promotional material.

Never expose real authentication tokens, passwords, private Jira information, customer data, or other sensitive information.

### Screenshot accuracy

Screenshots must accurately represent the current product.

In particular:

- Use the actual application layout and styling.
- Show real controls and components.
- Keep dates, totals, issue keys, and worklog information internally consistent.
- Ensure visible controls correspond to existing functionality.
- Do not add fake buttons or UI elements to make the product appear more capable.
- Do not manually recreate the interface when a screenshot of the actual application can be captured.

### Screenshot composition

When incorporating a screenshot into a promotional asset:

- Show enough of the application to communicate its value.
- Keep the important UI elements legible.
- Avoid cropping essential controls or content.
- Preserve the screenshot's aspect ratio unless a deliberate crop is necessary.
- Use perspective, scaling, or framing consistently with the existing artwork.
- Avoid excessive distortion or perspective effects that make the interface difficult to read.

If the screenshot becomes too small to read, simplify the composition rather than shrinking the interface further.

## 6. Asset-Specific Guidelines

### 6.1 Wide promotional banner

File:

`timesheet-for-jira-marquee-promo-tile.png`

Target dimensions: **1400 × 560 px**

Aspect ratio: **2.5:1**

Purpose:

Present the product's identity, core value proposition, and main capabilities in a wide format.

The existing composition uses:

- Product logo and name.
- A prominent promotional headline.
- Supporting feature descriptions and illustrations.
- A large screenshot of the extension.
- A light background with blue decorative elements.

Preserve this overall composition unless a redesign is explicitly requested.

When updating the banner:

1. Keep the product identity prominent.
2. Use a concise, high-impact headline.
3. Limit supporting content to the most important features.
4. Keep feature descriptions concise and readable.
5. Give the application screenshot sufficient space.
6. Maintain balance between the text area and screenshot.
7. Ensure the composition works at the exact target dimensions.

Do not simply scale up the standard promotional tile to create the banner.

The wide banner requires its own composition.

### 6.2 Standard promotional tile

File:

`timesheet-for-jira-promo-tile.png`

Target dimensions: **1571 × 1001 px**

Aspect ratio: approximately **1.57:1**

Purpose:

Provide a larger promotional overview of the extension.

The existing design combines the product identity, headline, feature highlights, and a prominent product screenshot.

Preserve this structure and visual hierarchy.

When updating the tile:

1. Keep the product name and main headline prominent.
2. Use the available space to explain the principal product benefits.
3. Keep supporting feature illustrations visually consistent.
4. Show a representative screenshot of the current extension.
5. Avoid overcrowding the text area.
6. Ensure the screenshot remains recognisable and sufficiently large.
7. Maintain the established light, blue-accented visual style.

The standard tile should communicate the product's value without requiring the viewer to inspect every detail of the screenshot.

### 6.3 Small promotional tile

File:

`timesheet-for-jira-promo-tile-small.png`

Target dimensions: **440 × 280 px**

Aspect ratio: approximately **1.57:1**

Purpose:

Provide a compact promotional representation of the extension.

The small tile shares the standard tile's aspect ratio but has substantially less space for detail.

When updating the tile:

1. Preserve the core visual identity.
2. Prioritise the product name and recognisable application UI.
3. Use minimal supporting text.
4. Avoid small feature descriptions that become illegible.
5. Simplify decorative elements where necessary.
6. Preserve the established visual relationship with the standard tile.

Do not assume the small tile can be produced by blindly resizing the standard tile.

Inspect the result at its actual display size. If the text or screenshot details become unreadable, simplify the composition while preserving the design.

## 7. Keeping Promotional Assets in Sync with the Product

The promotional assets should evolve alongside the extension.

When significant UI changes are made, review the assets for outdated information.

Examples include:

- Changes to the header or navigation.
- Changes to weekly summary cards.
- Changes to weekday cards.
- Changes to the worklog list.
- Changes to connection settings.
- Changes to synchronisation controls.
- Changes to the product logo or branding.
- Changes to the principal product features.

Do not update every promotional asset for every minor code change.

Update an asset when its displayed UI, text, or feature descriptions are no longer accurate, or when an explicit request calls for an update.

When updating an existing asset:

1. Inspect the current image.
2. Compare it with the current extension.
3. Identify the outdated elements.
4. Preserve the established composition and styling.
5. Update only what is necessary.
6. Verify the resulting image at its intended dimensions.

When a substantial product change makes the existing composition unsuitable, propose a revised layout before making unnecessary large-scale changes.

## 8. Editing and Generation Workflow

Choose the editing method appropriate to the task.

Prefer editing an existing asset when the requested change is small and the original composition remains suitable.

Examples include:

- Replacing an outdated screenshot.
- Correcting a feature description.
- Updating a heading.
- Adjusting a minor alignment issue.
- Updating a colour to match the established palette.

Create a new composition when the existing layout no longer represents the product or cannot accommodate the requested changes.

For generated artwork:

- Use generation for suitable decorative elements or illustrations.
- Do not rely on generated images for accurate product UI, exact text, or precise interface controls.
- Use real screenshots for the application interface.
- Add text and product screenshots using tools that preserve their accuracy and layout.

When editing the images programmatically, use reproducible scripts or source files where practical.

If a source design file already exists, inspect and reuse it rather than recreating the artwork from a flattened PNG.

Do not overwrite the original asset until the updated version has been validated.

## 9. Export Requirements

The final assets must:

- Be PNG files unless the repository or current store requirements specify otherwise.
- Use the required dimensions for their intended destination.
- Preserve the correct aspect ratio.
- Avoid unintended cropping.
- Avoid distortion.
- Have clean edges and legible text.
- Preserve the established brand identity.
- Contain no accidental transparency, blank areas, or rendering artefacts.

Optimise file size where practical without visibly degrading the image.

Do not reduce image quality merely to achieve an arbitrary file-size target unless a specific requirement exists.

Keep filenames stable unless there is a clear reason to rename them.

If additional source files are created, store them in an appropriate location and document how the final PNGs can be regenerated.

## 10. Validation

Before considering an asset update complete, perform the following checks.

### Dimensions and file format

Use ImageMagick when available:

```bash
identify docs/store-assets/chrome/timesheet-for-jira-*.png
```

Verify that each asset has the correct dimensions.

For automated validation, use explicit checks rather than relying solely on visual inspection.

Example:

```bash
#!/usr/bin/env bash

set -euo pipefail

asset_dir="docs/store-assets/chrome"

check_dimensions() {
    local filename="$1"
    local expected="$2"
    local actual

    actual=$(identify -format '%wx%h' "${asset_dir}/${filename}")

    if [[ "${actual}" != "${expected}" ]]; then
        printf 'ERROR: %s has dimensions %s; expected %s\n' \
            "${filename}" "${actual}" "${expected}" >&2
        return 1
    fi

    printf 'OK: %s (%s)\n' "${filename}" "${actual}"
}

check_dimensions \
    "timesheet-for-jira-marquee-promo-tile.png" \
    "1400x560"

check_dimensions \
    "timesheet-for-jira-promo-tile.png" \
    "1571x1001"

check_dimensions \
    "timesheet-for-jira-promo-tile-small.png" \
    "440x280"
```

Adjust the expected dimensions only when the intended requirements have been verified and the asset inventory has been updated.

### Visual review

Inspect each updated asset at its actual display size.

Check:

- Product name and headline readability.
- Screenshot legibility.
- Text alignment and spacing.
- Consistency of colours, typography, and icons.
- Correct screenshot content.
- Absence of clipping and distortion.
- Consistency with the other promotional assets.

Do not rely exclusively on the image's appearance when enlarged.

### Final verification

Before finishing:

1. Confirm all intended assets were updated.
2. Confirm filenames and dimensions are correct.
3. Open the final files and inspect them visually.
4. Check for accidental changes to unrelated assets.
5. Summarise the changes made and identify any validation steps that could not be completed.

Never claim that an asset was visually verified or tested if that check was not performed.

## 11. Working Principles

When working on these assets, follow these principles:

1. **Accuracy over invention.** Represent the real extension and its current capabilities.
2. **Consistency over unnecessary redesign.** Preserve the established visual identity.
3. **Readability over density.** Prefer a clear message and legible screenshot over excessive information.
4. **Reproducibility over manual guesswork.** Use repeatable workflows and validation where practical.
5. **Minimal changes where possible.** Update only what needs to change.
6. **Explicit validation.** Verify dimensions and inspect the final output.
7. **No unsupported claims.** Do not add promotional statements about capabilities that have not been implemented.

The goal is to maintain a coherent, professional set of promotional assets that accurately represent Timesheet for Jira and remain easy to update as the product evolves.
