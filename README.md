# Timesheet for Jira — Browser Extension

**Timesheet for Jira** is a Manifest V3 browser extension that shows your Jira worklogs in an interactive weekly timesheet. Creating and editing worklogs from the weekly view is planned for the next phase.

It runs in Chrome (Manifest V3) and Firefox (116+) and connects to Atlassian Jira Cloud, Jira Data Center, and compatible Jira Server instances (8.14+).

---

## Table of Contents

- [Features](#features)
- [Architecture & Design Decisions](#architecture--design-decisions)
- [Project Structure](#project-structure)
- [Supported Authentication & Jira Versions](#supported-authentication--jira-versions)
  - [Jira Cloud](#jira-cloud)
  - [Jira Data Center](#jira-data-center)
  - [Legacy Jira Server & Version Compatibility](#legacy-jira-server--version-compatibility)
- [Security Architecture](#security-architecture)
  - [Host Permissions](#host-permissions)
  - [Storage Security (storage.local)](#storage-security-storagelocal)
  - [Credential Redaction & Origin Isolation](#credential-redaction--origin-isolation)
- [Installation Guide (Load Unpacked)](#installation-guide-load-unpacked)
- [Configuration Instructions](#configuration-instructions)
  - [Configuring Jira Cloud](#configuring-jira-cloud)
  - [Configuring Jira Data Center / Server](#configuring-jira-data-center--server)
- [Automated Testing](#automated-testing)
- [Architectural Decisions & Known Limitations](#architectural-decisions--known-limitations)

---

## Features

- **Weekly Worklog View**: Visualizes Jira worklogs grouped by day for any selected week (Monday through Sunday) with daily totals and weekly total.
- **Week Navigation**: Effortlessly navigate between previous, next, and current weeks with dynamic date range display and quick actions.
- **Accurate Duration Aggregation**: Aggregates logged time strictly in seconds before formatting to hours and minutes, ensuring weekly totals strictly equal the sum of daily totals and daily totals equal the sum of their displayed worklogs.
- **Consistent Local Timezone Grouping**: Uses the user's browser local timezone to group worklog timestamps, ensuring midnight boundaries are faithfully represented.
- **Weekday Cards & Day Panel**: Seven cards (Monday through Sunday) show each day's total, worklog count, and a duration bar; selecting a card lists that day's worklogs in a detail panel below, without altering totals.
- **Comprehensive Worklog Details**: Displays Jira issue key (with direct clickable link), issue summary, formatted duration, start time, author, and formatted comments (supporting both string and Atlassian Document Format).
- **Jira Cloud and Data Center / Server**: Connects to Jira Cloud (`*.atlassian.net`) as well as self-hosted Jira Data Center and Server.
- **Per-Edition Settings**: The Jira Instance URL and token are saved separately for each Jira edition, so switching between Cloud and Data Center / Server never overwrites the other.
- **Connection Status**: Test Connection shows the connected account (and Jira version on Data Center / Server); the result is cleared as soon as a connection setting changes.
- **Open Jira Instance**: A button in the URL field opens the entered instance in a new tab (valid HTTPS URLs only).
- **Context Path Preservation**: Correctly handles and preserves reverse-proxy context paths such as `https://jira.company.com/jira`.
- **Strict URL Validation**: Rejects insecure HTTP, embedded credentials (`https://user:pass@...`), query parameters, and fragments.
- **Zero-Dependency Runtime**: Built on web standards and the WebExtensions API shared by Chrome and Firefox (ES modules, Fetch, `storage.local`, `tabs`).
- **Secure Token Protection**: Keeps credentials out of URLs, error messages, serialization, and logs.
- **Light and Dark Themes**: Compact typography, subtle borders, rounded cards, and prominent duration totals, with a theme toggle.

---

## Architecture & Design Decisions

The application is layered: the entry points (`options.js`, `background.js`) compose small modules and pass dependencies in explicitly, so the business logic runs in Node tests without a browser.

```mermaid
graph TD
  UI[options.html / options.js] --> WeekView[ui/weekView]
  UI --> Store[settings/settingsStore]
  UI --> Factory[jira/createJiraClient]
  UI --> Service[worklog/weeklyWorklogService]
  UI --> Platform[compat/browser-api: createPlatform]
  Background[background.js Service Worker] --> Store
  Background --> Factory
  Background --> Service

  Store --> Storage[(storage.local or in-memory)]
  Platform --> Storage
  Factory --> Validator[JiraUrlValidator]
  Factory --> Client[JiraClient]
  Factory --> CloudProvider[JiraCloudTokenProvider]
  Factory --> PatProvider[JiraPatProvider]
  Service --> Client
  Service --> Utils[worklog/worklogUtils: pure date & aggregation]
  Client --> JiraAPI["Jira REST API"]
```

1. **Modular Auth Providers (`src/auth/`)**:
   - `JiraAuthProvider.js`: Base abstraction defining the contract (`getAuthHeaders`, `getIdentityEndpoint`, `getDeploymentType`, `validate`).
   - `JiraCloudTokenProvider.js`: Implements HTTP Basic authentication using Atlassian Account Email and API Token.
   - `JiraPatProvider.js`: Implements Bearer authentication using Personal Access Tokens (PAT).
   - This design allows adding new authentication strategies in the future without altering the core client or UI.
2. **Centralized API Client (`src/jira/JiraClient.js`)**:
   - Encapsulates all Jira REST interactions.
   - Handles identity verification (`/rest/api/3/myself` with fallback to `/rest/api/2/myself`).
   - Searches issues with `/rest/api/3/search/jql` (token pagination) on Jira Cloud and `/rest/api/2/search` (`startAt` pagination) on Data Center / Server.
   - Fetches version metadata (`/rest/api/2/serverInfo`) for Data Center instances.
   - Translates HTTP status codes (401, 403, 404, 500) into actionable error explanations.
   - Enforces origin verification before dispatching credentials.
3. **URL Validation & Sanitization (`src/validation/JiraUrlValidator.js`)**:
   - Strict HTTPS enforcement.
   - Strips accidental endpoint suffixes if users paste full paths (e.g., `/rest/api/2/myself`).
   - Generates origin match patterns (e.g. `https://jira.example.com/*`) and checks same-origin requests.
   - Uses an edition-specific example URL in error messages.
4. **Client Factory (`src/jira/createJiraClient.js`)**:
   - The one place that validates the instance URL and maps the Jira edition to its auth provider.
5. **Settings Store (`src/settings/settingsStore.js`)**:
   - Owns the storage keys, the per-edition instance URLs and tokens (with fallback for settings saved before they existed), and the last connection test result.
   - Takes the storage area as a parameter: `storage.local` in the extension, an in-memory area in tests.
6. **Worklog Logic (`src/worklog/`)**:
   - `worklogUtils.js`: pure functions for week ranges, local-timezone grouping, duration formatting, and aggregation.
   - `weeklyWorklogService.js`: fetches one week through a client and aggregates it.
7. **Platform Adapter (`src/compat/browser-api.js`)**:
   - Chrome and Firefox share the WebExtensions API, so there is a single implementation. `createPlatform()` provides storage and tab opening, with an in-memory / `window.open` fallback when the page runs outside an extension.
8. **Presentation (`src/ui/`)**:
   - `weekView.js` renders the weekday cards and selected-day panel from explicit inputs; `options.js` keeps the view state and wiring.

---

## Project Structure

```text
timesheet-for-jira/
├── manifest.json                  # Extension Manifest V3 configuration
├── options.html                   # Weekly worklog & settings layout
├── options.css                    # Light & dark themes, compact typography & rounded cards
├── options.js                     # Weekly calendar & settings controller
├── background.js                  # Service worker for lifecycle & runtime messaging
├── src/
│   ├── auth/
│   │   ├── JiraAuthProvider.js         # Base auth provider interface
│   │   ├── JiraCloudTokenProvider.js    # HTTP Basic (email + API token)
│   │   └── JiraPatProvider.js          # Bearer (PAT)
│   ├── compat/
│   │   └── browser-api.js              # WebExtensions API access & platform adapter
│   ├── jira/
│   │   ├── JiraClient.js               # Centralized Jira REST API client
│   │   └── createJiraClient.js         # Builds a client from connection settings
│   ├── settings/
│   │   └── settingsStore.js            # Settings & credential persistence
│   ├── ui/
│   │   ├── html.js                     # HTML escaping
│   │   └── weekView.js                 # Weekday cards & selected-day panel
│   ├── validation/
│   │   └── JiraUrlValidator.js         # URL validation & origin matching
│   └── worklog/
│       ├── worklogUtils.js             # Week calculations, timezone grouping & aggregation
│       └── weeklyWorklogService.js     # Fetches and aggregates one week
├── icons/                         # Extension icons (16px, 32px, 48px, 128px)
├── tests/
│   ├── JiraUrlValidator.test.js        # Unit tests for URL validation
│   ├── JiraAuthProviders.test.js       # Unit tests for auth providers & headers
│   ├── JiraClient.test.js              # Unit tests for API client & mock HTTP states
│   ├── JiraClientWorklog.test.js       # Unit tests for worklog search & pagination
│   ├── WorklogUtils.test.js            # Unit tests for week math & duration formatting
│   ├── WeeklyWorklogIntegration.test.js# Integration & math invariant tests
│   ├── WeeklyWorklogService.test.js    # Week range (incl. DST) & week loading
│   ├── SettingsStore.test.js           # Settings normalization & persistence
│   ├── CompositionAndPlatform.test.js  # Client factory, author matching & platform adapter
│   └── BackgroundMessages.test.js      # End-to-end payload & messaging tests
├── package.json                   # Project metadata and test runner scripts
└── README.md                      # Documentation
```

---

## Supported Authentication & Jira Versions

### Jira Cloud
- **Authentication**: HTTP Basic Authentication with **Account Email** and **Atlassian API Token**.
- **Header**: `Authorization: Basic base64(email:apiToken)`
- **Identity Endpoint**: `/rest/api/3/myself` (with automatic fallback to `/rest/api/2/myself`).
- **How to create an API token**:
  1. Log in to [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens).
  2. Click **Create API token**.
  3. Give the token a label (e.g., `Timesheet for Jira`) and copy the generated token.

### Jira Data Center
- **Authentication**: Personal Access Token (PAT) with Bearer Authentication.
- **Header**: `Authorization: Bearer <PAT>`
- **Identity Endpoint**: `/rest/api/2/myself`
- **Supported Versions**: Jira Data Center 8.14 and higher.
- **How to create a PAT**:
  1. In Jira, click your user avatar in the top-right corner and select **Profile**.
  2. In the profile sidebar, select **Personal Access Tokens**.
  3. Click **Create token**, provide a name, and copy the token.

### Legacy Jira Server & Version Compatibility
- **Compatibility Limitation**: Personal Access Tokens (PATs) were introduced in **Jira Core / Software 8.14**.
- Jira Server versions **prior to 8.14 do not support PATs**. Because Timesheet for Jira intentionally omits basic username/passwords and legacy cookie/session-based logins for security reasons, instances older than 8.14 are **not compatible**.
- Atlassian officially ended support for Jira Server on February 15, 2024. For on-premise installations, Jira Data Center is recommended.

---

## Security Architecture

### Host Permissions
- `manifest.json` requests the `storage` permission and the host permission `https://*/*`. A broad HTTPS pattern is needed because the Jira instance URL is entered by the user (Cloud sites and self-hosted domains vary); it is granted at install time, so there is no runtime permission prompt.
- Plain HTTP origins are never allowed.
- Requests are only sent to the configured Jira instance: `JiraClient` checks that every outgoing request has the same origin as the validated instance URL before attaching credentials.

### Storage Security (`storage.local`)
- Settings and credentials are saved locally in the browser via the WebExtensions `storage.local` area (`chrome.storage.local` / `browser.storage.local`).
- **Important Security Notice**: `storage.local` provides local browser profile storage; it is **not an encrypted hardware vault** (such as TPM or OS keychain). While extensions cannot read storage from other extensions, users on shared operating system profiles should use dedicated browser profiles or disk-level encryption.

### Credential Redaction & Origin Isolation
- **No Credentials in URLs**: Tokens are strictly passed in HTTP headers, never as URL query parameters.
- **Origin Verification**: `JiraClient` verifies that any outgoing API request matches the exact origin of the validated base URL.
- **Zero Credential Logging**: `JiraCloudTokenProvider` and `JiraPatProvider` keep tokens in private fields and override `toJSON()` and `toString()` to omit them (the Cloud email is masked), preventing accidental leakage into `console.log`, exception handlers, or telemetry.
- **Content Security Policy (CSP)**: Enforces `script-src 'self'; object-src 'self';` with no `eval()` or remote executable scripts.

---

## Installation Guide (Load Unpacked)

### Chrome and Chromium-based browsers
1. Open Google Chrome (or any Chromium-based browser such as Brave, Edge, or Vivaldi).
2. Navigate to `chrome://extensions/`.
3. Enable **Developer mode** using the toggle switch in the top-right corner.
4. Click the **Load unpacked** button in the top-left toolbar.
5. In the file picker, select this directory:
   ```text
   /path/to/timesheet-for-jira
   ```
6. The **Timesheet for Jira** card will appear in your extension list. Click the extension icon in your toolbar or open the extension options to configure your connection.

### Firefox (116+)
1. Navigate to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and select `manifest.json` in this directory.
3. Click the extension icon in the toolbar to open the timesheet. Temporary add-ons are removed when Firefox restarts.

---

## Configuration Instructions

### Configuring Jira Cloud
1. Click the Timesheet for Jira toolbar icon and open the **Connection Settings** tab.
2. Select **Jira Cloud** under Jira Edition.
3. Enter your **Jira Instance URL** (e.g., `https://your-workspace.atlassian.net`).
4. Enter your **Atlassian Account Email** (e.g., `jane.doe@company.com`).
5. Enter your **Atlassian API Token**.
6. Click **Test Connection** and check that your account is shown.
7. Once verified, click **Save Settings**.

### Configuring Jira Data Center / Server
1. In **Connection Settings**, select **Data Center / Server** under Jira Edition.
2. Enter your **Jira Instance URL**. If hosted under a sub-path, include it (e.g., `https://jira.corp.internal/jira`).
3. Enter your **Personal Access Token (PAT)**.
4. Click **Test Connection** and check that your account and Jira version are shown.
5. Once verified, click **Save Settings**.

Each edition keeps its own instance URL and token, so you can configure both and switch between them; the selected edition is used when you save.

---

## Automated Testing

The project includes an automated test suite covering URL sanitization, credential headers, error responses, origin integrity, worklog search and pagination, date and duration logic, and settings persistence, without connecting to any real Jira server or browser.

### Running Tests

Run the test suite using Node.js:

```bash
npm test
```

Or run directly with the Node.js native test runner:

```bash
node --test tests/*.test.js
```

### Test Coverage Highlights

- **`tests/JiraUrlValidator.test.js`**:
  - Validates HTTPS enforcement and rejects plain HTTP.
  - Rejects embedded credentials (`https://user:pass@host`).
  - Rejects query strings and URL fragments.
  - Preserves custom context paths (`/jira`, `/apps/jira`).
  - Normalizes trailing slashes without removing context paths.
  - Strips accidental `/rest/api/...` endpoint suffixes.
  - Tests origin match pattern generation and `isSameOrigin` validation.
- **`tests/JiraAuthProviders.test.js`**:
  - Tests Base64 `Basic` header construction for Cloud accounts.
  - Tests `Bearer` token header construction for PAT accounts.
  - Validates required fields (email format, token presence).
  - Asserts that sensitive tokens are never revealed in serialization (`toJSON`, `toString`).
- **`tests/JiraClient.test.js`**:
  - Tests successful Cloud authentication against `/rest/api/3/myself`.
  - Tests Cloud endpoint fallback to `/rest/api/2/myself`.
  - Tests Data Center authentication against `/rest/api/2/myself` and `/rest/api/2/serverInfo`.
  - Tests meaningful error mapping for `401 Unauthorized`, `403 Forbidden`, `404 Not Found`, and `500 Internal Error`.
  - Tests network errors, timeout handling (`AbortSignal`), and invalid non-JSON payloads.
  - Asserts that credentials are never exposed in return values or error details.
- **`tests/JiraClientWorklog.test.js`**:
  - Tests JQL search on Jira Cloud (`/rest/api/3/search/jql` with `nextPageToken`) and Data Center / Server (`/rest/api/2/search` with `startAt`).
  - Tests worklog retrieval across multiple issues and date filtering.
  - Tests automated secondary pagination for issues with >20 worklogs (`/issue/{key}/worklog`).
  - Tests user identity matching (`accountId` on Cloud, `name`/`key` on Data Center).
  - Tests empty week result handling without errors.
- **`tests/WorklogUtils.test.js`**:
  - Tests Monday-based week calculation across arbitrary days, month boundaries, leap years, and Sunday boundaries.
  - Tests local timezone date key extraction (`YYYY-MM-DD`).
  - Tests week date range string formatting (`formatWeekRange`).
  - Tests duration formatting with second precision, zero minutes padding, and digital zero labels.
  - Tests comment parsing for both plain strings and Atlassian Document Format (ADF) block documents.
  - Tests mathematical invariant: daily totals equal the sum of displayed worklogs.
  - Tests mathematical invariant: weekly total equals the sum of all included daily totals.
- **`tests/WeeklyWorklogIntegration.test.js`**:
  - Validates multi-day, multi-issue worklog aggregations and chronological ordering within days.
  - Validates week navigation boundaries (previous and next weeks).
  - Asserts that expanding and collapsing days does not alter totals.
- **`tests/BackgroundMessages.test.js`**:
  - Verifies service worker messaging and end-to-end handler pipelines (`TEST_CONNECTION`, `FETCH_WORKLOGS`).
- **`tests/WeeklyWorklogService.test.js`**:
  - Tests the Monday-to-Sunday week range, including a week with a midnight daylight-saving change, and loading and aggregating a week through a client.
- **`tests/SettingsStore.test.js`**:
  - Tests per-edition instance URLs and tokens, fallback for older saved settings, the "configured" rule, and storing and clearing the connection test result.
- **`tests/CompositionAndPlatform.test.js`**:
  - Tests the Jira client factory, worklog author matching, and the platform adapter (extension APIs and the non-extension fallback).

---

## Architectural Decisions & Known Limitations

### Architectural Decisions
- **Native ES Modules**: Plain ES modules (`type: "module"`) are used without bundling or transpilation tools (e.g. Webpack/Vite). This minimizes build complexity, keeps code 1:1 readable in developer tools, and facilitates quick debugging.
- **Zero Third-Party Runtime Dependencies**: All runtime functionality relies directly on the WebExtensions API (shared by Chrome and Firefox) and modern DOM/Fetch specifications.
- **One Codebase for Chrome and Firefox**: A single `manifest.json` declares both `background.service_worker` (Chrome) and `background.scripts` (Firefox); no browser-specific builds are needed.
- **HTTPS-Only Host Access**: Host access is limited to `https://*/*` rather than `<all_urls>`, and credentials are only sent to the configured instance's origin.
- **Atlassian Token Compatibility**: All REST calls supply `X-Atlassian-Token: no-check` to bypass XSRF defenses on Data Center REST endpoints.

### Jira API Access to Worklogs — Limitations & Mitigation
1. **Search API 20-Item Worklog Limit**:
   - *Limitation*: Jira's search endpoint (`/rest/api/3/search/jql` on Cloud, `/rest/api/2/search` on Data Center / Server) returns at most 20 worklogs inside `issue.fields.worklog`, even when `total` is higher.
   - *Mitigation*: Timesheet for Jira detects when `issue.fields.worklog.total > worklog.length` and automatically queries `/rest/api/{2|3}/issue/{issueKey}/worklog` with full pagination to retrieve all worklogs for that issue.
2. **JQL `worklogDate` Server Timezone Offsets**:
   - *Limitation*: Jira evaluates `worklogDate >= ... AND worklogDate <= ...` using the Jira server's configured timezone or Jira user profile timezone, which can differ from the browser's local timezone (potentially missing worklogs logged near midnight).
   - *Mitigation*: Timesheet for Jira queries Jira with an intentional ±1 day buffer window in JQL, then applies strict local timezone boundaries client-side based on the user's browser clock.
3. **Issue Summaries on Worklogs**:
   - *Limitation*: Jira's standalone worklog endpoint (`/rest/api/3/worklog/updated` or `/issue/{id}/worklog`) does not include the parent issue summary or issue title.
   - *Mitigation*: Timesheet for Jira queries issues via JQL with `fields=summary,worklog`, ensuring issue summaries are always available for every worklog without requiring N+1 secondary issue lookups.
4. **Permissions Scoping**:
   - *Limitation*: Users can only view worklogs on issues for which their account has "Browse Projects" and "View Worklogs" permissions in Jira. If worklogs exist on restricted issues, Jira's REST API will omit those issues from search results.
5. **Legacy Jira Server (< 8.14)**:
   - Does not support PAT authentication. Legacy username/password and cookie logins are intentionally omitted for security reasons.
6. **SSO / SAML Redirects**:
   - Instances requiring an interactive browser SAML/Okta redirection prior to REST API access must ensure API tokens or PATs bypass web SSO filtering for `/rest/api/*`.
7. **Scope Limitation**:
   - This release implements the weekly worklog view with daily and weekly totals, week navigation, and weekday card selection. Interactive drag-and-drop calendar time blocks and bidirectional worklog creation/editing are reserved for the next phase.

