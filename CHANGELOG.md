# Changelog

All notable changes to Timesheet for Jira are documented in this file. The extension's Changelog shows the released versions.

Versions before 1.2.0 were development milestones. Their history is in Git (tags v1.0.0 and v1.1.0); they aren't listed here as product releases.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!--
How to maintain this file (see "Changelog" under "Development and tests" in README.md):
- Add each user-facing change under [Unreleased], in Added, Changed, Deprecated, Removed, Fixed, or Security.
- Items are plain text: no code spans, bold, links, or HTML.
- End an item with the highlight marker (an HTML comment, see README.md) to show it in the update announcement.
- To release, move the Unreleased items into a new "## [X.Y.Z] - YYYY-MM-DD" section with 1 to 3 highlights,
  leave [Unreleased] empty, and set the same version in manifest.json and package.json. Packaging fails until
  all of that holds. Then tag the release commit: git tag -a vX.Y.Z -m "Timesheet for Jira X.Y.Z".
-->

## [Unreleased]

### Added

- What's New, in the header, shows what the latest version brings, with a NEW badge until you've seen it. After an update, a short announcement lists the new version's highlights. <!-- highlight -->
- The bottom of Settings shows the extension's name and version.

### Changed

- A pending worklog shows its comment after its date and start time.
- Selecting a day, or going to another week, shows that day's worklogs.
- My Active Issues is shown below the selected day's worklogs.
- In My Active Issues, Active Issues and Pending Worklogs are two groups that expand and collapse separately, instead of tabs. The Show recently logged switch is on the Active Issues header.
