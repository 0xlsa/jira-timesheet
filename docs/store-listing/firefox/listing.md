# Firefox Add-ons (AMO) listing: Timesheet for Jira 1.0.0

Field-by-field content for addons.mozilla.org. Shared source text: `../common/description.md`. Values marked `[TO BE DECIDED]` must be settled before submission.

Add-on ID: `timesheet-for-jira@0xlsa` (from `manifest.json`).

## Basic information

### Name

`Timesheet for Jira`

### Summary

At most 250 characters (proposed: 157).

`See your Jira worklogs as a weekly timesheet, and log, edit, or delete work right from it. Works with Jira Cloud and Jira Data Center / Server 8.14 or later.`

### Description

AMO supports limited Markdown (bold, italics, links, lists).

```markdown
Timesheet for Jira shows the time you've logged in Jira as a weekly timesheet, so you can check your week at a glance and fix it without opening each issue.

Pick a week and see each day's total, the week's total, and every worklog you logged: the issue key, the issue's current status, its summary, your work description, the start time, and the duration. From the same view you can log more work on an issue, edit a worklog's date, start time, duration, or description, or delete a worklog. Changes are saved to Jira, and the day and week totals update as soon as Jira confirms them.

**Features**

- Weekly timesheet, Monday through Sunday, with daily and weekly totals and a card for each day.
- Every worklog you logged that week, grouped by day in your local time zone, with the issue's status.
- Log work on an issue from any of its worklogs, with 15-minute, 30-minute, and 1-hour shortcuts.
- Edit a worklog's date, start time, duration, and work description. Only the fields you change are sent to Jira.
- Delete a worklog after a confirmation that shows exactly what will be removed.
- Clear messages when Jira refuses a change, for example because of missing permissions or an expired token.
- Jira Cloud (account email and API token) and Jira Data Center or Server 8.14 or later (personal access token).
- Light and dark themes.

**What data it sends, and where**

Your Jira address and token are stored only in Firefox. The add-on sends requests only to the Jira site you configure, over HTTPS: your token for authentication, and the worklogs you view, log, edit, or delete. It has no analytics, ads, or other servers. See the privacy policy for details.

**Good to know**

- You see only worklogs you authored, and only what your Jira permissions allow.
- New work is logged from an existing worklog in the displayed week. There's no issue search yet.
- Jira Server and Data Center versions earlier than 8.14 aren't supported.

Timesheet for Jira is an independent project. It isn't affiliated with, endorsed by, or sponsored by Atlassian. Jira is a trademark of Atlassian.
```

### Categories

AMO allows up to two. Its extension categories are: Alerts & Updates, Appearance, Bookmarks, Download Management, Feeds, News & Blogging, Games & Entertainment, Language Support, Other, Photos, Music & Videos, Privacy & Security, Search Tools, Shopping, Social & Communication, Tabs, Web Development. None is about productivity or time tracking.

**Proposed: Other** (only). `[TO BE DECIDED: add a second category?]`

### Tags (keywords)

`jira`, `timesheet`, `worklog`, `time tracking`, `atlassian` `[TO BE CONFIRMED against AMO's tag list]`

### Supported platforms

Firefox for desktop (Windows, macOS, Linux). Not tested on Firefox for Android; don't select Android unless it's tested.

## Media

### Icon

`icons/icon128.png` (32×32 and 64×64 are generated from it). Exists.

### Screenshots

Recommended 1280×800 (1.6:1); no count limit. Proposed set, in this order:

1. `docs/screenshots/weekly-overview-light.png`: the weekly timesheet
2. `docs/screenshots/weekly-overview-dark.png`: the weekly timesheet, in the dark theme
3. `docs/screenshots/worklog-log-work.png`: logging work
4. `docs/screenshots/connection-settings-cloud.png`: connection settings for Jira Cloud
5. `docs/screenshots/connection-settings-data-center.png`: connection settings for Jira Data Center / Server

All 5 screenshots exist, 1280×800 PNG, taken in Chrome (the extension looks the same in Firefox). The weekly timesheet and logging work screenshots show the account name "Luciano de Sa" and the site `0xlsa.atlassian.net`; decide whether that's acceptable in public screenshots. The connection settings screenshots have blank fields.

## Support information

| Field | Value |
| --- | --- |
| Support email | Leave empty: support is through GitHub Issues, below. `[TO BE DECIDED: add a support email address?]` |
| Support website | `https://github.com/0xlsa/jira-timesheet/issues` |
| Homepage | `https://github.com/0xlsa/jira-timesheet` |

## Technical details

| Field | Value |
| --- | --- |
| License | MIT (`LICENSE` in the repository) |
| Privacy policy | Paste the full text of `../common/privacy-policy.md`. AMO expects the full text in the listing, even though it's also available at `https://github.com/0xlsa/jira-timesheet/blob/main/docs/store-listing/common/privacy-policy.md`. |
| Source code | Not required: the package contains the original, unminified, unbundled source. |
| Experimental | No |
| Release notes | `../common/release-notes.md` |

## Data collection declaration (required)

Since 3 November 2025, new extensions must declare `browser_specific_settings.gecko.data_collection_permissions` in `manifest.json`. The manifest declares:

```json
"data_collection_permissions": {
  "required": ["authenticationInfo", "personallyIdentifyingInfo", "websiteContent"]
}
```

Mozilla's policy defines data transmission as "any data that is collected, used, transferred, shared, or handled outside of the add-on", and makes no exception for a service the user configures. So the declaration covers what the extension sends to the user's Jira site, even though nothing is sent to the developer or any other service:

| Category | What the extension sends to Jira |
| --- | --- |
| `authenticationInfo` | The API token (Jira Cloud) or personal access token (Data Center / Server), and on Jira Cloud the account email as the username, in the `Authorization` header of every request |
| `personallyIdentifyingInfo` | The Atlassian account email (Jira Cloud only), which Mozilla lists as an example of personal data |
| `websiteContent` | The worklogs the user logs or edits: date, start time, duration, and work description, which become content on the Jira site |

Not declared, because the extension doesn't do it: reading browsing history, tabs, or page content (`browsingActivity`, `websiteActivity`), and analytics or telemetry (`technicalAndInteraction`). Data kept only in the browser (settings and the theme) isn't transmission. All three categories are required, because the extension can't work without them. None is eligible for Mozilla's implicit consent, so Firefox shows them at install, and installing accepts them.

Open points `[TO BE DECIDED]`:

- **Interpretation.** Whether data sent to a server the user chooses counts as collection isn't spelled out by Mozilla, and listed add-ons differ: some self-hosted tools declare `"none"`, others declare what they send to the user's server. The declaration above is the conservative reading. `"required": ["none"]` would avoid the install notice, but it depends on the reviewer agreeing.
- **Minimum Firefox version.** Firefox's built-in consent exists from Firefox 140 (142 on Android), so `strict_min_version` is `140.0`. Firefox 128 to 139 would have needed a custom consent screen, which the extension doesn't have.
- **Firefox for Android.** Not supported: the manifest has no `browser_specific_settings.gecko_android`, so the add-on is offered on desktop Firefox only. It hasn't been tested on Android, and its full-tab page is designed for desktop. To support Android later, test it there and add `"gecko_android": { "strict_min_version": "142.0" }`.
- **Expected linter warning.** `web-ext lint` (10.8.0) reports `KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION`: it takes `gecko.strict_min_version` (140) as the Android minimum even without `gecko_android`, while Android needs 142 for `data_collection_permissions`. Mozilla's manifest documentation says that without `gecko_android` the add-on is offered on desktop only, so the warning doesn't apply. The only manifest changes that clear it are declaring Android support (`gecko_android` with 142) or raising the desktop minimum to 142, which would drop Firefox 140 ESR. When submitting, select Firefox (desktop) only.
