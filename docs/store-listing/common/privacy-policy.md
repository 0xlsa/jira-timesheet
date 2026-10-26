# Privacy Policy for Timesheet for Jira

**Effective date:** `[TO BE DECIDED: publication date]`
**Applies to:** Timesheet for Jira browser extension, version 1.0.0, for Chrome and Firefox
**Contact:** `[TO BE DECIDED: support email address]`

Timesheet for Jira shows your Jira worklogs as a weekly timesheet and lets you log, edit, and delete worklogs. This policy explains what data the extension handles, where it's kept, and where it's sent.

## Summary

- The extension stores your Jira connection settings in your browser and nowhere else.
- It sends requests only to the Jira site you configure, over HTTPS.
- It doesn't use analytics, advertising, tracking, or any server run by the developer. The developer doesn't receive any of your data.
- It doesn't sell or share data with anyone.

## Data the extension stores in your browser

The extension uses the browser's extension storage (`storage.local`) to keep:

| Data | Why |
| --- | --- |
| Jira instance URL, separately for Jira Cloud and for Data Center / Server | To know which Jira site to connect to |
| The selected Jira edition | To use the right authentication method |
| Atlassian account email (Jira Cloud) | Part of Jira Cloud authentication |
| API token (Jira Cloud) or personal access token (Data Center / Server) | To authenticate your requests to Jira |
| The result of your last successful **Test Connection**: your Jira display name, username or account ID, email address as Jira reports it, and, on Data Center / Server, the Jira version | To show which account is connected |

It also stores your light or dark theme choice in the page's local storage.

**This storage isn't encrypted.** Browser extension storage is kept in your browser profile, not in an encrypted vault such as your operating system's keychain. Anyone with access to your browser profile could read it. On a shared computer, use a separate browser profile or operating-system account. Give your token only the access you need, and revoke it in Atlassian or Jira when you stop using the extension.

## Data sent to Jira

To show and change your worklogs, the extension sends requests directly from your browser to the Jira site you entered:

- **With every request:** your token (and, for Jira Cloud, your account email) in the `Authorization` header, never in the URL. Requests don't include your browser's cookies for the Jira site.
- **To show your week:** a search for issues with worklogs you authored in the selected week, which returns those issues' keys, summaries, and statuses, and your worklogs on them.
- **When you log, edit, or delete work:** the worklog's date and start time, duration, and work description, or the request to delete it.

Jira data received this way is used only to display your timesheet and is kept in memory while the page is open. Apart from the connection-test result described above, it isn't saved.

Your Jira site processes these requests under the terms of whoever runs it: Atlassian for Jira Cloud, or your organization for Data Center / Server. This policy doesn't cover how that Jira site handles your data.

The extension only sends requests to the configured site's own address (same origin), only over HTTPS, and only when you use it.

## Data the extension doesn't handle

The extension doesn't read your browsing history or the content of web pages you visit, doesn't use analytics or crash reporting, and doesn't contact any server other than your Jira site. The settings page links to Atlassian's API token page; opening that link is up to you.

## Permissions

- **Storage:** to keep the settings described above in your browser.
- **Access to your Jira site:** the extension has no access to any website when you install it. When you test or save your settings, your browser asks you to allow access to the one Jira site you entered (for example `https://your-domain.atlassian.net/*`). Because that can be any HTTPS address (`*.atlassian.net` or your organization's own domain), the extension declares `https://*/*` as optional access it may ask for, but it only asks for, and only sends requests to, the site you configured. You can remove this access at any time in your browser's extension settings.

## Your choices

- Change or remove your Jira URL and token at any time in **Connection Settings**.
- Uninstalling the extension removes the data it stored in your browser.
- Revoke your token in your Atlassian account (Jira Cloud) or Jira profile (Data Center / Server) to stop it from working anywhere.

## Changes to this policy

If this policy changes, the new version will be published at `[TO BE DECIDED: privacy policy URL]` with a new effective date.

## Contact

Questions about this policy: `[TO BE DECIDED: support email address]`.
