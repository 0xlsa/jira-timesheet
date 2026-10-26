# Support for Timesheet for Jira

**Support site / issue tracker:** [GitHub Issues](https://github.com/0xlsa/jira-timesheet/issues)

When you open an issue, include your browser and version, your Jira edition (Cloud or Data Center / Server), and the exact error message shown by the extension. Issues are public, so **never include your API token or personal access token.**

## Getting connected

1. Open the extension (toolbar icon) and go to **Connection Settings**.
2. Choose **Jira Cloud** or **Data Center / Server**.
3. Enter your Jira instance URL. It must start with `https://`. For Data Center / Server, include any context path, such as `https://jira.example.com/jira`.
4. Jira Cloud: enter your Atlassian account email and an API token created at https://id.atlassian.com/manage-profile/security/api-tokens.
   Data Center / Server: enter a personal access token from your Jira profile (Jira 8.14 or later).
5. Click **Test Connection**. When your account is shown, click **Save Settings**.

## Common problems

**"Authentication failed (401 Unauthorized)" or "Jira rejected your credentials"**
The token is wrong, expired, or revoked, or (Jira Cloud) the email doesn't match the token's account. Create a new token and enter it again.

**"You don't have permission to …" (403)**
Your Jira account isn't allowed to do this on that issue, for example log work, edit worklogs, or delete worklogs in that project. Ask your Jira administrator.

**"Jira's cross-site request (XSRF) protection rejected the request"**
A proxy or security setting in front of Jira refused the request. Include the full message, with Jira's reason, when you contact support.

**"Endpoint not found" (404) when testing the connection**
Check the instance URL, especially the context path on Data Center / Server.

**A non-JSON response or login page**
Your Jira site may require single sign-on for its REST API. API tokens or personal access tokens must be allowed to reach `/rest/api/*` directly; ask your Jira administrator.

**A worklog is missing from the week**
The timesheet shows only worklogs you authored, on issues you can see. Times are shown in your browser's time zone, so a worklog near midnight may appear on a different day than in Jira. Click **Sync** to reload from Jira.

**Can't log work on an issue that isn't shown**
New work is logged with **+** on an existing worklog in the displayed week. Logging work on other issues isn't supported yet.

**Jira Server or Data Center older than 8.14**
Not supported: those versions don't offer personal access tokens.

**Firefox: settings missing after reinstalling**
Firefox keeps extension data per installation. After removing and reinstalling the extension, enter your connection settings again.
