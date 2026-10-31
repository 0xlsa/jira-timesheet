# Store Asset Guidelines

## Purpose

Maintain consistent, accurate, and professional promotional assets for Timesheet for Jira.

Browser-specific directories contain their own `CLAUDE.md` files defining platform-specific requirements, asset filenames, dimensions, and design constraints.

## Source of Truth

Use these sources in order of priority:

1. Current application implementation and actual functionality.
2. Screenshots captured from the running application.
3. Existing promotional assets and source design files.
4. Browser-specific asset guidelines.

Never invent application features or UI elements.

## Brand Consistency

Preserve the established Timesheet for Jira branding:

- Calendar-and-clock product logo.
- Blue accents and dark navy typography.
- Light backgrounds and white application surfaces.
- Rounded cards, subtle borders, and restrained shadows.
- Clear typographic hierarchy and consistent spacing.

Inspect existing assets and application CSS for exact values. Do not guess colours or fonts when the source is available.

## Screenshot Accuracy

Use actual application screenshots for product UI.

- Use synthetic demonstration data.
- Never expose credentials, access tokens, or private customer information.
- Ensure displayed dates, worklogs, and totals are internally consistent.
- Do not fabricate controls or functionality.
- Preserve screenshot proportions unless cropping is intentional and appropriate.

## Editing Rules

- Prefer updating an existing composition over redesigning it unnecessarily.
- Use reproducible editing workflows where practical.
- Keep source files and reference screenshots separate from final exported assets.
- Do not overwrite reference screenshots during asset generation.
- Do not modify unrelated application code.

## Validation

After updating assets:

1. Verify dimensions and file formats.
2. Inspect the final images at their intended display sizes.
3. Check readability, alignment, cropping, and consistency.
4. Confirm that the UI matches the current application.
5. Report any validation that could not be completed.

Never claim to have generated or visually inspected an asset unless that work was actually performed.
