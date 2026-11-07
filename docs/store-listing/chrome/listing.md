# Chrome Web Store listing: Timesheet for Jira 1.2.1

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
Timesheet for Jira — Your Weekly Timesheet, at a Glance

See all your Jira worklogs for the week at a glance. Review your daily and weekly totals, check which issues you've worked on, time your work as you go, and add, edit, or delete worklogs without opening each Jira issue.

Whether you're tracking your hours, reviewing your week before submitting a timesheet, or correcting a worklog, Timesheet for Jira makes it easier to keep your Jira time entries accurate.

FEATURES

• Weekly overview: View Monday through Sunday, with daily totals and a weekly total. Click the week's dates to open a calendar and jump to any week, or go back to today in one click.

• All your worklogs in one place: See each day's worklogs together, with the issue key, status, summary, start time, duration, and your full work description.

• Built-in timer: Start a timer on any issue, pause it for a break, and stop it when you're done. Each session becomes a pending worklog that you can review, edit, add a comment to, and submit to Jira when you're ready. The timer keeps running even if you close the tab or restart the browser.

• My Work: Your issues and your pending worklogs, in two groups you can expand, collapse, and put in the order you prefer. Issues lists the issues assigned to you that are in progress and, unless you turn it off, the ones you've logged work on in the last 14 days, so you can log time on any of them in one click. Optionally include issues assigned to you through other Jira user fields, such as a QA assignee. Pending Worklogs shows how much time is waiting to be submitted.

• Custom views: Create up to five views of your Jira issues, shown as tabs beside Active in Issues. Combine conditions on status, priority, assignee, reporter, or your Jira site's own fields, choose how the issues are sorted, and reorder the tabs by dragging. Each view shows the first 20 matching issues.

• Log work quickly: Add time to an issue on any day, by its key, from one of its worklogs, or from My Work, with 15-minute, 30-minute, and 1-hour shortcuts.

• Edit worklogs: Correct the date, start time, duration, or work description. Only the fields you change are sent to Jira.

• Delete worklogs safely: Review the details of a worklog before confirming its deletion.

• Public holidays (optional): Choose a country to see its official public holidays on your timesheet, plus the next upcoming one.

• What's New: See what each update brings, with a short summary of the highlights after the extension updates.

• Keyboard shortcuts: Move around and act without the mouse. Press ? to see them all.

• Clear feedback: See success and error messages when Jira processes your changes, including permission issues and expired tokens.

• Light and dark themes: Choose the appearance that suits you.

JIRA COMPATIBILITY

• Jira Cloud: Authenticate using your account email and API token.

• Jira Data Center and Jira Server 8.14 or later: Authenticate using a personal access token (PAT).

PRIVACY

Your Jira address, authentication token, settings, custom views, timer, and pending worklogs are stored locally in your browser. The extension communicates with the Jira instance you configure over HTTPS. If you turn on public holidays, it also requests holiday dates from the public Nager.Date service, sending only the country you chose and the year. It does not use analytics or display ads, and it never sends your Jira data or token anywhere other than your Jira instance.

PLEASE NOTE

• The extension displays worklogs you authored, subject to your Jira permissions.

• Custom views show only issues you have permission to see in Jira.

Timesheet for Jira is an independent project and is not affiliated with, endorsed by, or sponsored by Atlassian. Jira is a trademark of Atlassian.
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
| Small promo tile | 440×280 PNG or JPEG; optional, but listings without one are shown after those with one | `docs/store-assets/chrome/timesheet-for-jira-promo-tile-small.png` | Exists |
| Marquee promo tile | 1400×560; optional, needed only to be featured | `docs/store-assets/chrome/timesheet-for-jira-marquee-promo-tile.png` | Exists |

**Proposed screenshots** (in this order; 5 is the maximum):

1. `docs/screenshots/weekly-overview-light.png`: the weekly timesheet, with the next public holiday and a running timer
2. `docs/screenshots/timer-and-pending-worklogs.png`: the timer and a pending worklog
3. `docs/screenshots/worklog-log-work.png`: logging work
4. `docs/screenshots/weekly-overview-dark.png`: the weekly timesheet, in the dark theme
5. `docs/screenshots/connection-settings-cloud.png`: connection settings for Jira Cloud

Also available, for the README or to swap in: `connection-settings-data-center.png` (Jira Data Center / Server), `public-holidays-settings.png`, and `keyboard-shortcuts.png`.

The screenshots are 1280×800 PNG, captured in Chrome from the real options page with demonstration data by `docs/screenshots/source/capture.py` (the extension looks the same in Firefox). They show the KAN sample worklogs, the account name "Luciano de Sa", and the site `0xlsa.atlassian.net`; decide whether that's acceptable in public screenshots. The timer and pending worklog are seeded demonstration state, and Public Holidays is set to Italy, so the banner shows its next holiday, All Saints' Day on Nov 1. The connection settings screenshots have blank fields, and the Public Holidays one shows Jira Connection collapsed, so no email or token appears.

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
| `contextMenus` | Adds one item, "Settings", to the right-click menu of the extension's toolbar icon. It opens the timesheet with the Jira connection settings showing. The extension adds no items to web pages' context menus and reads nothing through this permission. |
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
