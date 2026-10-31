# Screenshot sources

The screenshots in `docs/screenshots/` and the store tiles' `docs/store-assets/chrome/source/app-overview@2x.png` are captured from the real options page with one command:

```bash
python3 docs/screenshots/source/capture.py
```

Pass scenario names to capture only some of them, for example `python3 docs/screenshots/source/capture.py weekly-overview-light app-overview`. After `app-overview`, run `bash docs/store-assets/chrome/source/render.sh` to render the promo tiles again.

The script needs Python 3, Google Chrome (or set `CHROME` to another Chromium-based browser), ImageMagick (`magick`), and the Roboto font, which the extension's system font stack uses on Linux. It works offline: everything it needs is in this folder.

## How it works

| File | What it is |
| --- | --- |
| `capture.py` | Serves the repository on localhost, opens `options.html` in headless Chrome with `harness.js` loaded before `options.js`, and saves each scenario's screenshot. The scenarios (what's stored, what's clicked or typed, and the window size) are listed in `SCENARIOS`. |
| `harness.js` | Stands in for what a capture can't have: the browser extension APIs (`chrome.storage.local`, the manifest), the Jira site, Nager.Date, and the clock. The page, styles, and modules are the extension's own and run unchanged. |
| `demo-data.json` | The Jira data the harness answers with: the KAN sample issues and their worklogs for Oct 19–25, 2026, on `0xlsa.atlassian.net`, as they are in that Jira site. The account email is a placeholder. |
| `holidays.json` | Nager.Date's country list and Italy's 2026 holidays, as `capture.py --refresh-holidays` downloaded them from the API the extension uses. |

The harness answers only the requests the extension makes: `/myself`, `/serverInfo`, the JQL searches for worklogs, active issues, and issue keys, `/issue/{key}`, and `/issue/{key}/worklog`. Anything else gets a 404 that names the request, so a screenshot shows the error rather than made-up data.

## The demonstration state

- **Week:** Oct 19–25, 2026, in the `Europe/Berlin` time zone, which is the Jira user's. The clock is fixed at Friday, Oct 23, 18:05, after the week's last worklog has ended. Friday is today.
- **Worklogs:** the 15 worklogs from `demo-data.json`, 28h 30m in all. They are real KAN worklogs; nothing is added.
- **Timer and pending worklog:** these live only in the extension's local storage, not in Jira, so they are seeded in `capture.py`. A timer has been running on KAN-12 since 17:40, after the last worklog. A 45-minute pending worklog on KAN-13, from 11:15 to 12:00 on Friday, fits between that day's worklogs.
- **Public Holidays:** turned on for Italy. No Italian holiday falls in the demonstration week, so no weekday card is marked; the banner above the week shows the next one, All Saints' Day (Sun, Nov 1).
- **Panels:** the selected day's panel is expanded, so its worklogs show (it starts collapsed). My Active Issues stays collapsed, its default, except in `timer-and-pending-worklogs`, which shows its Pending tab.
- **Settings screenshots:** `connection-settings-cloud` and `connection-settings-data-center` show Settings before anything is configured, with blank fields. `public-holidays-settings` shows them once configured, with Jira Connection collapsed, so no email or token appears.

No real tokens, passwords, or customer data are used. The screenshots show the account name "Luciano de Sa" and the site `0xlsa.atlassian.net`, as earlier screenshots did.

## Updating the screenshots

When the UI changes, run `capture.py` again and check every image. When a scenario's steps no longer match the page, for example because a selector was renamed, the capture shows the error in red at the top of the page.

The harness turns off CSS transitions and animations: Chrome runs them in real time rather than the capture's virtual time, so drawers would otherwise be caught mid-slide. A panel's default state can change too: the overviews set `jts-day-panel-expanded` in `localStorage` so the selected day's worklogs show.

The Jira data is a copy. To refresh it from the KAN project, update `demo-data.json` by hand and keep the weekly totals consistent.
