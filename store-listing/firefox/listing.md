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

Recommended 1280×800 (1.6:1); no count limit. Proposed Firefox set, in this order:

1. `docs/screenshots/firefox/weekly-overview-light.png`: the weekly timesheet
2. `docs/screenshots/firefox/worklog-details-dark.png`: a day's worklogs, in the dark theme
3. `docs/screenshots/firefox/worklog-log-work-light.png`: logging work
4. `docs/screenshots/firefox/worklog-edit-dark.png`: editing a worklog
5. `docs/screenshots/firefox/worklog-delete-confirm-light.png`: delete confirmation

All 10 Firefox screenshots exist (5 screens × dark and light), 1280×800 PNG. They show the account name "Luciano de Sa" and the site `0xlsa.atlassian.net`.

## Support information

| Field | Value |
| --- | --- |
| Support email | `[TO BE DECIDED: support email address]` (recommended as a minimum) |
| Support website | `[TO BE DECIDED: support URL]` |
| Homepage | `[TO BE DECIDED: homepage URL]` |

## Technical details

| Field | Value |
| --- | --- |
| License | MIT (`LICENSE` in the repository) |
| Privacy policy | Paste the full text of `../common/privacy-policy.md`. AMO expects the full text in the listing, even when it's also hosted elsewhere. |
| Source code | Not required: the package contains the original, unminified, unbundled source. |
| Experimental | No |
| Release notes | `../common/release-notes.md` |

## Data collection declaration (required)

Since 3 November 2025, new extensions must declare `browser_specific_settings.gecko.data_collection_permissions` in `manifest.json`. The current manifest doesn't (`web-ext lint` reports it as a notice), so **a manifest change is needed before submission** `[TO BE DECIDED]`.

Mozilla's policy defines data transmission as "any data that is collected, used, transferred, shared, or handled outside of the add-on or the local browser", and doesn't make an exception for a service the user configures. The extension sends credentials and worklog data to the user's Jira instance. Options:

- **Conservative (recommended):** declare what's sent to Jira as required data:
  ```json
  "data_collection_permissions": {
    "required": ["authenticationInfo", "personallyIdentifyingInfo", "websiteContent"]
  }
  ```
  Required data is shown to users at install time, and installing accepts it. Firefox's built-in consent applies to Firefox 140 and later; for earlier versions the add-on would need its own consent screen, so Mozilla recommends raising `strict_min_version` from `128.0` (the minimum for `optional_host_permissions`) to `140.0`.
- **Minimal:** `"required": ["none"]`, arguing the data only goes to the user's own Jira site and never to the developer. This depends on the reviewer agreeing.

Which categories to declare, and whether to raise the minimum Firefox version, are decisions to make before the submission build.
