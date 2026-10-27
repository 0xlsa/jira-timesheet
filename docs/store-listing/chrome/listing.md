# Chrome Web Store listing: Timesheet for Jira 1.0.0

Field-by-field content for the Chrome Web Store Developer Dashboard. Shared source text: `../common/description.md`. Values marked `[TO BE DECIDED]` must be settled before submission.

## Store listing tab

### Title

`Timesheet for Jira`

Comes from `name` in `manifest.json` (unchanged).

### Summary (short description)

The store shows the manifest's `description` field, plain text, at most 132 characters.

- Current `manifest.json` value (54 characters): `Your Jira worklogs as a weekly timesheet, at a glance.`
- **Proposed** (127 characters; using it requires changing `manifest.json`):
  `See your Jira worklogs as a weekly timesheet, and log, edit, or delete work right from it. For Jira Cloud and Jira Data Center.`

### Description

```text
Timesheet for Jira shows the time you've logged in Jira as a weekly timesheet, so you can check your week at a glance and fix it without opening each issue.

Pick a week and see each day's total, the week's total, and every worklog you logged: the issue key, the issue's current status, its summary, your work description, the start time, and the duration. From the same view you can log more work on an issue, edit a worklog's date, start time, duration, or description, or delete a worklog. Changes are saved to Jira, and the day and week totals update as soon as Jira confirms them.

FEATURES
• Weekly timesheet, Monday through Sunday, with daily and weekly totals and a card for each day.
• Every worklog you logged that week, grouped by day in your local time zone, with the issue's status.
• Log work on an issue from any of its worklogs, with 15-minute, 30-minute, and 1-hour shortcuts.
• Edit a worklog's date, start time, duration, and work description. Only the fields you change are sent to Jira.
• Delete a worklog after a confirmation that shows exactly what will be removed.
• Clear messages when Jira refuses a change, for example because of missing permissions or an expired token.
• Jira Cloud (account email and API token) and Jira Data Center or Server 8.14 or later (personal access token).
• Light and dark themes.

PRIVACY
Your Jira address and token are stored only in your browser. The extension talks only to the Jira site you configure, over HTTPS. It has no analytics, ads, or other servers.

GOOD TO KNOW
• You see only worklogs you authored, and only what your Jira permissions allow.
• New work is logged from an existing worklog in the displayed week. There's no issue search yet.
• Jira Server and Data Center versions earlier than 8.14 aren't supported.

Timesheet for Jira is an independent project. It isn't affiliated with, endorsed by, or sponsored by Atlassian. Jira is a trademark of Atlassian.
```

### Category

**Workflow & Planning** (Productivity group). Alternative: **Tools**.
`[TO BE CONFIRMED in the dashboard]`: Google's documentation doesn't list the current category names, so pick from the dashboard's list.

### Language

English (United States)

### Graphic assets

| Asset | Requirement | File | Status |
| --- | --- | --- | --- |
| Store icon | 128×128 PNG | `icons/icon128.png` | Exists (also inside the extension package) |
| Screenshots | At least 1, at most 5; 1280×800 or 640×400 | See below | Exist, 1280×800 RGB PNG |
| Small promo tile | 440×280 PNG or JPEG; optional, but listings without one are shown after those with one | None | `[TO BE DECIDED: create one?]` |
| Marquee promo tile | 1400×560; optional, needed only to be featured | None | Optional |

**Proposed screenshots** (Chrome set, in this order; 5 is the maximum):

1. `docs/screenshots/chrome/weekly-overview-light.png`: the weekly timesheet
2. `docs/screenshots/chrome/worklog-details-dark.png`: a day's worklogs, in the dark theme
3. `docs/screenshots/chrome/worklog-log-work-light.png`: logging work
4. `docs/screenshots/chrome/worklog-edit-dark.png`: editing a worklog
5. `docs/screenshots/chrome/worklog-delete-confirm-light.png`: delete confirmation

All 14 Chrome screenshots exist (7 screens × dark and light); swap themes or screens as preferred. The connection settings screenshots (`connection-settings-cloud-*.png` and `connection-settings-data-center-*.png`) are not in the proposed set and have blank fields. The others show the account name "Luciano de Sa" and the site `0xlsa.atlassian.net`; decide whether that's acceptable in public screenshots.

### Additional fields

| Field | Value |
| --- | --- |
| Official URL | `[TO BE DECIDED]`: optional; must be a site verified in Google Search Console |
| Homepage URL | `https://github.com/0xlsa/jira-timesheet` |
| Support URL | `https://github.com/0xlsa/jira-timesheet/issues` |
| Mature content | Off |

## Privacy practices tab

### Single purpose

`Shows the user's Jira worklogs as a weekly timesheet and lets them log, edit, and delete their own worklogs in their Jira instance.`

### Permission justifications

| Permission | Justification |
| --- | --- |
| `storage` | Saves the user's Jira connection settings in chrome.storage.local so they don't have to be re-entered: the selected Jira edition, the Jira instance URL for Jira Cloud and for Jira Data Center / Server, the Atlassian account email (Jira Cloud), the API token (Jira Cloud) or personal access token (Data Center / Server), the result of the last successful connection test (Jira display name, username, account ID or user key, email address, and, on Data Center / Server, the Jira version, deployment type, and server title), and the time the settings were last saved. No worklog or issue data is stored. Storage is local to the browser profile and isn't synced or sent anywhere. |
| Optional host permission `https://*/*` | The extension has no host access at install time. It reads and writes the user's worklogs through the Jira REST API of the instance the user enters, which can be any HTTPS address: a Jira Cloud site on *.atlassian.net or a self-hosted Jira Data Center / Server on the organization's own domain, so it can't be listed in advance. `https://*/*` is declared only in optional_host_permissions. When the user clicks Test Connection, Save Settings, or Allow Access, the extension calls chrome.permissions.request for that one site (for example `https://jira.example.com/*`). The extension sends requests only to that site's origin, has no content scripts, and doesn't read or modify web pages. When the user saves a different instance URL, it removes access to sites that are no longer configured. |

### Remote code

**No, I am not using remote code.** Every script is in the package: `background.js`, `options.js`, and the ES modules under `src/`, loaded with relative imports. The only script tag is `<script type="module" src="options.js">`. The code has no `eval`, `new Function`, dynamic `import()`, `importScripts`, or WebAssembly, and it has no third-party libraries or build step that downloads code. The content security policy is `script-src 'self'; object-src 'self';`. Network requests go only to the user's Jira REST API and return JSON data, which is never executed.

### Data usage

Proposed disclosures. The Chrome Web Store counts data even when it's only stored locally or sent to a service the user chooses.

| Data type | Disclose? | What it is |
| --- | --- | --- |
| Authentication information | **Yes** | Jira API token or personal access token, stored locally and sent to the user's Jira instance |
| Personally identifiable information | **Yes** | Atlassian account email; Jira display name and email from the connection test, stored locally |
| Website content | `[TO BE DECIDED]` | Issue summaries, statuses, and worklog descriptions read from the user's Jira instance and shown, not stored. Disclosing is the conservative choice. |
| Health, financial and payment, personal communications, location, web history, user activity | No | Not handled |

Certifications to tick (all true for this implementation):
- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

### Privacy policy URL

`https://github.com/0xlsa/jira-timesheet/blob/main/docs/store-listing/common/privacy-policy.md`

The policy file in the public repository (`../common/privacy-policy.md`). Check that the page loads, signed out, before submitting.

## Distribution

Visibility, regions, and pricing: `[TO BE DECIDED]` (the extension is free and has no paid features).
