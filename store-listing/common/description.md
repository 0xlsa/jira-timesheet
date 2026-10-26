# Timesheet for Jira: shared description

Source text for both store listings. The store-specific files in `../chrome/listing.md` and `../firefox/listing.md` adapt it to each store's fields. Every feature below is implemented in version 1.0.0 (see the repository README and tests).

## One-line summary

See your Jira worklogs as a weekly timesheet, and log, edit, or delete work right from it. Works with Jira Cloud and Jira Data Center.

## Description

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

**Privacy**

Your Jira address and token are stored only in your browser. The extension talks only to the Jira site you configure, over HTTPS. It has no analytics, ads, or other servers.

**Who it's for**

Anyone who logs time in Jira and wants to review and correct a week of worklogs quickly, for example before submitting a timesheet.

**Good to know**

- You see only worklogs you authored, and only what your Jira permissions allow.
- New work is logged from an existing worklog in the displayed week. There's no issue search yet.
- Jira Server and Data Center versions earlier than 8.14 aren't supported, because they don't offer personal access tokens.

Timesheet for Jira is an independent project. It isn't affiliated with, endorsed by, or sponsored by Atlassian. Jira is a trademark of Atlassian.
