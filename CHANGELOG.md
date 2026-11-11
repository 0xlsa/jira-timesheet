# Changelog

All notable changes to Timesheet for Jira are documented in this file. The extension's Changelog shows the released versions.

Versions before 1.2.0 were development milestones. Their history is in Git (tags v1.0.0 and v1.1.0); they aren't listed here as product releases.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!--
How to maintain this file (see "Changelog" under "Development and tests" in README.md):
- Add each user-facing change under [Unreleased], in Added, Changed, Deprecated, Removed, Fixed, or Security.
- Items are plain text: no code spans, bold, links, or HTML.
- An item may have sub-items, one level: "  - " (two spaces, then "- ") under it, plain text too.
- End an item with the highlight marker (an HTML comment, see README.md) to show it in the update announcement.
- To release, move the Unreleased items into a new "## [X.Y.Z] - YYYY-MM-DD" section with 1 to 3 highlights,
  leave [Unreleased] empty, and set the same version in manifest.json and package.json. Packaging fails until
  all of that holds. Then tag the release commit: git tag -a vX.Y.Z -m "Timesheet for Jira X.Y.Z".
-->

## [Unreleased]

## [1.2.2] - 2026-11-11

### Added

- Worklogs has Pending and On Hold tabs, each with its count and its own color: blue and amber. Your pending worklogs, and every new one, start in Pending. <!-- highlight -->
- Each pending worklog's ⋯ menu moves it to Pending or On Hold. This only files it in this browser: nothing is sent to Jira, and the worklog itself doesn't change. <!-- highlight -->
- Select worklogs, beside the tabs, picks several pending worklogs to move at once, one by one or with Select all. A bar shows how many are selected and their total time, with the tabs they can move to. Once they've moved, selection mode closes by itself; any that couldn't move stay selected, marked Not moved, with the reason.

### Changed

- Pending Worklogs in My Work is now called Worklogs.
- The Worklogs header names the selected tab and its count in the tab's color, such as Worklogs · Pending (2), and totals that tab.
- The Issues header names the selected view and its count in blue, such as Issues · Reported (12).

## [1.2.1] - 2026-11-07

### Added

- In My Work, drag Issues or Pending Worklogs by the handle at the start of its header to put it above or below the other, or press Alt+Shift+Up or Down Arrow on its header. The order is saved for each Jira site. <!-- highlight -->
- The Pending Worklogs header shows the total time of all pending worklogs on its right. <!-- highlight -->

### Changed

- In My Work, My Issues is now called Issues.
- The My Work heading is a single line. Issues and Pending Worklogs each sit in their own bordered container, with a roomier header showing an icon and the count, and more compact rows.
- The selected day's worklogs sit together in one bordered container, divided by subtle lines like Pending Worklogs, instead of each in its own card. Each shows its start time and author below the summary, then its comment. <!-- highlight -->
- The calendar icon is now before the week's date range.

## [1.2.0] - 2026-11-04

### Added

- What's New, in the header, shows what the latest version brings, with a NEW badge until you've seen it. After an update, a short announcement lists the new version's highlights. <!-- highlight -->
- The bottom of Settings shows the extension's name and version.
- Custom views in My Work: create your own Jira issue views to organize and find the issues that matter to you. <!-- highlight -->
  - Create up to five custom views, displayed as tabs beside Active in My Issues.
  - Reorder tabs by dragging.
  - Define multiple conditions using status, priority, assignee, reporter, or custom fields from your Jira site.
  - See the first 20 matching issues you have permission to access, sorted in your chosen order (most recently updated first by default).

### Changed

- A pending worklog shows its comment after its date and start time.
- Selecting a day, or going to another week, shows that day's worklogs.
- My Active Issues is now called My Work, and its Active Issues list is now called My Issues, whose Active tab lists your issues as before.
- My Work is shown below the selected day's worklogs.
- In My Work, My Issues and Pending Worklogs are two groups that expand and collapse separately, instead of tabs. The Show recently logged switch is just below the Active tab.
- Turning Show recently logged on or off keeps the issues listed, with a small spinner beside the switch, until the new list is in. If it can't be loaded, the issues stay and a message says why.
