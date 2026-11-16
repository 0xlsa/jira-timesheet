# Microsoft Edge Add-ons listing: Timesheet for Jira

Field-by-field content for Microsoft Edge Add-ons, in [Partner Center](https://partner.microsoft.com/dashboard/microsoftedge/overview). Most of it is the same as the Chrome Web Store's: this file says where to take each field from, and what Edge asks for differently. Shared source text: `../common/description.md`. Values marked `[TO BE DECIDED]` must be settled before the first submission.

Requirements checked against Microsoft's documentation: [Port a Chrome extension to Microsoft Edge](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/port-chrome-extension), [Publish a Microsoft Edge extension](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension), [Update a Microsoft Edge extension](https://learn.microsoft.com/en-us/microsoft-edge/extensions/update/update-extension), and [Supported APIs](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/api-support).

## Package

Upload `release/timesheet-for-jira-chrome.zip`, from `task package:chrome`, unchanged. There's no Edge build:

| Microsoft's requirement | This package |
| --- | --- |
| A `.zip` with the manifest and the files it needs | `manifest.json` at the root, and only the runtime files (checked when packaging) |
| Manifest V3 (Partner Center is phasing out Manifest V2 updates); no remotely hosted code, which Manifest V3 doesn't allow | Manifest V3; every script is in the package (see Remote code below) |
| Remove `update_url` | None (`task package:chrome` refuses one) |
| Rebrand if `Chrome` is in the name or description | Neither mentions Chrome (`task package:chrome` refuses it) |
| APIs Edge supports | `storage`, `contextMenus`, `permissions`, `runtime`, and `action`, all supported |

The manifest's `name` and `description` fill the listing's **Extension name** and **Short description**, which are read-only in Partner Center: changing them takes a new package.

## Properties

| Field | Value |
| --- | --- |
| Category | **Productivity** `[TO BE CONFIRMED in Partner Center]` |
| Website | `https://github.com/0xlsa/jira-timesheet` |
| Support contact detail | `https://github.com/0xlsa/jira-timesheet/issues` |
| Mature content | Off |

## Privacy

The same answers as the Chrome Web Store's **Privacy practices** tab, in `../chrome/listing.md`:

- **Single Purpose Description:** the Chrome listing's **Single purpose**.
- **Permission justification:** the Chrome listing's justifications for `storage`, `contextMenus`, and the optional host permission `https://*/*`. They name `chrome.storage.local` and `chrome.permissions.request`, which is also what those APIs are called in Edge.
- **Are you using remote code?** **No, I am not using remote code.**
- **Data usage:** the same disclosures and certifications as the Chrome listing's **Data usage**.
- **Privacy Policy URL:** `https://github.com/0xlsa/jira-timesheet/blob/main/docs/store-listing/common/privacy-policy.md`. `[TO BE DECIDED]`: its "Applies to" line names Chrome and Firefox only; consider adding Microsoft Edge before submitting.

## Store listing (English)

| Field | Requirement | Value or file |
| --- | --- | --- |
| Description | 250 to 10,000 characters; must describe the full functionality | The Chrome listing's **Description** (about 4,000 characters) |
| Extension logo | 1:1; 300×300 recommended, 128×128 minimum | `icons/icon128.png` meets the minimum. `[TO BE DECIDED]`: a 300×300 version, as recommended |
| Small promotional tile | Optional; 440×280 | `docs/store-assets/chrome/timesheet-for-jira-promo-tile-small.png` (440×280) |
| Large promotional tile | Optional; 1400×560 PNG | `docs/store-assets/chrome/timesheet-for-jira-marquee-promo-tile.png` (1400×560) |
| Screenshots | Optional; at most 6; 640×480 or 1280×800 | The Chrome listing's five, 1280×800 PNG, in its order; a sixth (such as `docs/screenshots/connection-settings-data-center.png`) can be added |
| Search terms | Optional; up to 7 terms, 21 words, 30 characters each | `Jira`, `timesheet`, `worklog`, `time tracking`, `Jira Cloud`, `Jira Data Center`, `timer` |

## Notes for certification

Certification can take up to seven business days. Reviewers need a Jira site to try the extension:

```text
Timesheet for Jira shows the signed-in user's Jira worklogs as a weekly timesheet, and logs, edits, and deletes
them through the Jira REST API of the site the user enters. It needs a Jira Cloud site (account email and API
token) or a Jira Data Center site (personal access token): [TO BE DECIDED: test site and credentials, or a note
that any Jira Cloud free site works]. Without a Jira site, the options page opens on the connection settings.
The extension has no host access at install time: it asks for access to the one Jira site entered, when the
user clicks Test Connection or Save Settings.
```

For an update, also say what changed in the new version (its `CHANGELOG.md` section).

## Updating

Upload the new `release/timesheet-for-jira-chrome.zip` on the extension's **Packages** page, check the listing, and **Publish**. The version must be higher than the published one, as `task package:chrome` packages it from `manifest.json`. Microsoft also offers an [Update REST API](https://learn.microsoft.com/en-us/microsoft-edge/extensions/update/api/using-addons-api) for updates after the first submission; the release process doesn't use it.
