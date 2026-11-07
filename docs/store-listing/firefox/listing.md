# Firefox Add-ons (AMO) listing: Timesheet for Jira 1.2.1

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
Timesheet for Jira — Your Weekly Timesheet, at a Glance

See all your Jira worklogs for the week at a glance. Review your daily and weekly totals, check which issues you've worked on, time your work as you go, and add, edit, or delete worklogs without opening each Jira issue.

Whether you're tracking your hours, reviewing your week before submitting a timesheet, or correcting a worklog, Timesheet for Jira makes it easier to keep your Jira time entries accurate.

**Features**

- **Weekly overview:** View Monday through Sunday, with daily totals and a weekly total. Click the week's dates to open a calendar and jump to any week, or go back to today in one click.
- **All your worklogs in one place:** See each day's worklogs together, with the issue key, status, summary, start time, duration, and your full work description.
- **Built-in timer:** Start a timer on any issue, pause it for a break, and stop it when you're done. Each session becomes a pending worklog that you can review, edit, add a comment to, and submit to Jira when you're ready. The timer keeps running even if you close the tab or restart the browser.
- **My Work:** Your issues and your pending worklogs, in two groups you can expand, collapse, and put in the order you prefer. Issues lists the issues assigned to you that are in progress and, unless you turn it off, the ones you've logged work on in the last 14 days, so you can log time on any of them in one click. Optionally include issues assigned to you through other Jira user fields, such as a QA assignee. Pending Worklogs shows how much time is waiting to be submitted.
- **Custom views:** Create up to five views of your Jira issues, shown as tabs beside Active in Issues. Combine conditions on status, priority, assignee, reporter, or your Jira site's own fields, choose how the issues are sorted, and reorder the tabs by dragging. Each view shows the first 20 matching issues.
- **Log work quickly:** Add time to an issue on any day, by its key, from one of its worklogs, or from My Work, with 15-minute, 30-minute, and 1-hour shortcuts.
- **Edit worklogs:** Correct the date, start time, duration, or work description. Only the fields you change are sent to Jira.
- **Delete worklogs safely:** Review the details of a worklog before confirming its deletion.
- **Public holidays (optional):** Choose a country to see its official public holidays on your timesheet, plus the next upcoming one.
- **What's New:** See what each update brings, with a short summary of the highlights after the extension updates.
- **Keyboard shortcuts:** Move around and act without the mouse. Press ? to see them all.
- **Clear feedback:** See success and error messages when Jira processes your changes, including permission issues and expired tokens.
- **Light and dark themes:** Choose the appearance that suits you.

**Jira compatibility**

- **Jira Cloud:** Authenticate using your account email and API token.
- **Jira Data Center and Jira Server 8.14 or later:** Authenticate using a personal access token (PAT).

**Privacy**

Your Jira address, authentication token, settings, custom views, timer, and pending worklogs are stored locally in your browser. The extension communicates with the Jira instance you configure over HTTPS. If you turn on public holidays, it also requests holiday dates from the public Nager.Date service, sending only the country you chose and the year. It does not use analytics or display ads, and it never sends your Jira data or token anywhere other than your Jira instance.

**Please note**

- The extension displays worklogs you authored, subject to your Jira permissions.
- Custom views show only issues you have permission to see in Jira.

Timesheet for Jira is an independent project and is not affiliated with, endorsed by, or sponsored by Atlassian. Jira is a trademark of Atlassian.
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

1. `docs/screenshots/weekly-overview-light.png`: the weekly timesheet, with the next public holiday and a running timer
2. `docs/screenshots/weekly-overview-dark.png`: the weekly timesheet, in the dark theme
3. `docs/screenshots/timer-and-pending-worklogs.png`: the timer and a pending worklog
4. `docs/screenshots/worklog-log-work.png`: logging work
5. `docs/screenshots/connection-settings-cloud.png`: connection settings for Jira Cloud
6. `docs/screenshots/connection-settings-data-center.png`: connection settings for Jira Data Center / Server
7. `docs/screenshots/public-holidays-settings.png`: Public Holidays settings
8. `docs/screenshots/keyboard-shortcuts.png`: the keyboard shortcuts

The screenshots are 1280×800 PNG, captured in Chrome from the real options page with demonstration data by `docs/screenshots/source/capture.py` (the extension looks the same in Firefox). They show the KAN sample worklogs, the account name "Luciano de Sa", and the site `0xlsa.atlassian.net`; decide whether that's acceptable in public screenshots. The timer and pending worklog are seeded demonstration state, and Public Holidays is set to Italy, so the banner shows its next holiday, All Saints' Day on Nov 1. The connection settings screenshots have blank fields, and the Public Holidays one shows Jira Connection collapsed, so no email or token appears.

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
