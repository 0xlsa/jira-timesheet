# Timesheet for Jira: shared description

Source text for both store listings. The store-specific files in `../chrome/listing.md` and `../firefox/listing.md` adapt it to each store's fields. Every feature below is implemented in version 1.2.1 (see the repository README and tests).

## One-line summary

See your Jira worklogs as a weekly timesheet, and log, edit, or delete work right from it. Works with Jira Cloud and Jira Data Center.

## Description

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
