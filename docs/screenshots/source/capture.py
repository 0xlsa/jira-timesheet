#!/usr/bin/env python3
"""Captures the screenshots in docs/screenshots/ and the store tiles' app-overview@2x.png.

Serves the repository on localhost and opens the real options page (options.html, options.css,
options.js, and src/) in headless Chrome, with harness.js loaded first to stand in for the
extension APIs, the Jira site (demo-data.json), Nager.Date (holidays.json), and the clock. Each
scenario below seeds the page's storage, runs a few steps (clicks, typing), and is captured at
its size. See README.md.

Usage:
    python3 docs/screenshots/source/capture.py                 # every scenario
    python3 docs/screenshots/source/capture.py weekly-overview-light worklog-log-work
    python3 docs/screenshots/source/capture.py --refresh-holidays   # download holidays.json again

Needs Google Chrome (or set CHROME) and ImageMagick (`magick`) for the store tile crop.
"""

import argparse
import functools
import json
import os
import subprocess
import sys
import tempfile
import threading
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SOURCE = Path(__file__).resolve().parent
REPO = SOURCE.parents[2]
SCREENSHOTS = REPO / 'docs' / 'screenshots'
TILE_SCREENSHOT = REPO / 'docs' / 'store-assets' / 'chrome' / 'source' / 'app-overview@2x.png'

# The demonstration week is Oct 19-25, 2026, in the Jira user's time zone. "Now" is Friday
# evening: every worklog that week has ended, and a timer started after the last one.
TIME_ZONE = 'Europe/Berlin'
NOW = '2026-10-23T18:05:00+02:00'

# Public Holidays: a country with an official holiday in the demonstration week (Nager.Date data).
HOLIDAY_COUNTRY = 'IT'
NAGER = 'https://nagerholidays.com/api/v4'

DATA = json.loads((SOURCE / 'demo-data.json').read_text())
SITE = DATA['site']
SITE_ID = f'cloud|{SITE}'

# Configured for Jira Cloud. The email and token are placeholders: the harness answers Jira itself.
CONFIGURED = {
    'jiraBaseUrl': SITE,
    'deploymentType': 'cloud',
    'email': DATA['user']['emailAddress'],
    'token': 'demo-api-token',
    'cloudBaseUrl': SITE,
    'cloudToken': 'demo-api-token',
    'serverBaseUrl': '',
    'serverToken': '',
    'publicHolidaysEnabled': True,
    'publicHolidaysCountry': HOLIDAY_COUNTRY,
    # A timer running on KAN-12 since the last worklog ended, and one stopped session from the
    # morning, between the day's worklogs, waiting to be submitted. Neither is in Jira yet.
    'timeTracking': {
        'version': 2,
        'running': {
            'id': 'timer-kan-12', 'site': SITE_ID, 'issueId': '10021', 'issueKey': 'KAN-12',
            'issueSummary': 'Test Chrome and Firefox compatibility',
            'startedAt': '2026-10-23T17:40:00+02:00', 'accumulatedMs': 0, 'resumedAt': '2026-10-23T17:40:00+02:00'
        },
        'pending': [{
            'id': 'pending-kan-13', 'site': SITE_ID, 'issueId': '10022', 'issueKey': 'KAN-13',
            'issueSummary': 'Write the README and privacy policy',
            'startedAt': '2026-10-23T11:15:00+02:00', 'stoppedAt': '2026-10-23T12:00:00+02:00',
            'timeSpentSeconds': 2700, 'comment': 'Documented the timer and pending worklogs in the README.'
        }]
    }
}

# The selected day's worklogs are shown (the day panel is collapsed by default).
LIGHT = {'jts-theme': 'light', 'jts-day-panel-expanded': 'true'}
DARK = {'jts-day-panel-expanded': 'true'}
EXPANDED = {'jts-working-issues-expanded': 'true'}
# My Active Issues stays collapsed (its default) in the overviews; its header still shows the
# running timer and the pending worklog. timer-and-pending-worklogs shows it expanded.
TUESDAY = [
    {'do': 'wait', 'selector': '.worklog-duration-badge'},
    {'do': 'wait', 'selector': '.working-issues-timer:not(.hidden)'},
    {'do': 'click', 'selector': '.day-card[data-date-key="2026-10-20"]'},
    {'do': 'blur'}
]


def screenshot(name, **scenario):
    return {'name': name, 'output': SCREENSHOTS / f'{name}.png', 'size': (1280, 800), 'scale': 1, **scenario}


SCENARIOS = [
    screenshot('weekly-overview-light', storage=CONFIGURED, localStorage=LIGHT, steps=TUESDAY),
    screenshot('weekly-overview-dark', storage=CONFIGURED, localStorage=DARK, steps=TUESDAY),
    screenshot('worklog-log-work', storage=CONFIGURED, localStorage=LIGHT, steps=TUESDAY + [
        {'do': 'click', 'selector': '.day-add-btn'},
        {'do': 'type', 'selector': '#worklogIssueSearch', 'text': 'KAN-1'},
        {'do': 'wait', 'selector': '.issue-picker-option-key'}]),
    screenshot('timer-and-pending-worklogs', storage=CONFIGURED,
               localStorage={**LIGHT, **EXPANDED, 'jts-working-issues-tab': 'pending'}, steps=[
        {'do': 'wait', 'selector': '.worklog-duration-badge'},
        {'do': 'wait', 'selector': '.working-issues-timer:not(.hidden)'}]),
    screenshot('public-holidays-settings', storage=CONFIGURED, localStorage=LIGHT, steps=[
        {'do': 'wait', 'selector': '.worklog-duration-badge'},
        {'do': 'wait', 'selector': '#nextHolidayBanner:not(.hidden)'},
        {'do': 'click', 'selector': '#settingsBtn'},
        {'do': 'wait', 'selector': '#publicHolidaysCountry option[value="%s"]' % HOLIDAY_COUNTRY},
        {'do': 'blur'}]),
    screenshot('keyboard-shortcuts', storage=CONFIGURED, localStorage=LIGHT, steps=TUESDAY + [
        {'do': 'click', 'selector': '#shortcutsHelpBtn'},
        {'do': 'wait', 'selector': '#shortcutsDrawer:not(.hidden)'},
        {'do': 'blur'}]),
    # Not configured: Settings opens by itself, with the connection fields to fill in.
    screenshot('connection-settings-cloud', storage={}, localStorage=LIGHT, steps=[
        {'do': 'wait', 'selector': '#settingsDrawer:not(.hidden)'},
        {'do': 'blur'}]),
    screenshot('connection-settings-data-center', storage={}, localStorage=LIGHT, steps=[
        {'do': 'wait', 'selector': '#settingsDrawer:not(.hidden)'},
        {'do': 'click', 'selector': '#typeServer'},
        {'do': 'blur'}]),
    # The store tiles' screenshot: 2x, the app column of a 1280 px wide window (see the tiles' README).
    {'name': 'app-overview', 'output': TILE_SCREENSHOT, 'size': (1280, 960), 'scale': 2, 'crop': (214, 0, 852, 960),
     'storage': CONFIGURED, 'localStorage': LIGHT, 'steps': TUESDAY},
]


def holidays():
    """Nager.Date data for the harness: the country list, and the holiday country's years."""
    return json.loads((SOURCE / 'holidays.json').read_text())


def refresh_holidays():
    def get(path):
        # Nager.Date refuses Python's default user agent.
        request = urllib.request.Request(f'{NAGER}{path}', headers={
            'Accept': 'application/json', 'User-Agent': 'timesheet-for-jira-screenshots'})
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    data = {
        'source': NAGER,
        'countries': get('/Countries/Available'),
        'years': {f'{HOLIDAY_COUNTRY}:{year}': get(f'/Holidays/{HOLIDAY_COUNTRY}/{year}') for year in (2026,)}
    }
    (SOURCE / 'holidays.json').write_text(json.dumps(data, indent=1, ensure_ascii=False) + '\n')
    print(f'Wrote holidays.json ({len(data["countries"])} countries, {HOLIDAY_COUNTRY} 2026)')


class Handler(SimpleHTTPRequestHandler):
    """Serves the repository; /capture.html is options.html with the harness loaded first."""

    def log_message(self, *args):
        pass

    def do_GET(self):
        path, _, query = self.path.partition('?')
        if path != '/capture.html':
            return super().do_GET()
        name = dict(p.split('=', 1) for p in query.split('&') if '=' in p).get('scenario')
        scenario = next(s for s in SCENARIOS if s['name'] == name)
        capture = {
            'scenario': {'now': NOW, 'timeZone': TIME_ZONE, 'storage': scenario.get('storage', {}),
                         'localStorage': scenario.get('localStorage', {}), 'steps': scenario.get('steps', [])},
            'data': DATA,
            'manifest': json.loads((REPO / 'manifest.json').read_text()),
            'holidays': holidays(),
        }
        page = (REPO / 'options.html').read_text()
        inject = ('<script>window.__CAPTURE__ = %s;</script>\n'
                  '  <script src="docs/screenshots/source/harness.js"></script>\n  ') % json.dumps(capture)
        marker = '<script type="module" src="options.js"></script>'
        assert marker in page, 'options.html no longer loads options.js as expected'
        body = page.replace(marker, inject + marker).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def capture(scenario, port, chrome):
    width, height = scenario['size']
    output = Path(scenario['output'])
    with tempfile.TemporaryDirectory() as profile:
        raw = Path(profile) / 'shot.png'
        subprocess.run([
            chrome, '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
            '--no-default-browser-check', f'--user-data-dir={profile}/user', '--lang=en-US',
            f'--force-device-scale-factor={scenario["scale"]}', f'--window-size={width},{height}',
            '--virtual-time-budget=20000', f'--screenshot={raw}',
            f'http://localhost:{port}/capture.html?scenario={scenario["name"]}',
        ], check=True, capture_output=True, env={**os.environ, 'TZ': TIME_ZONE})
        if 'crop' in scenario:
            x, y, w, h = (v * scenario['scale'] for v in scenario['crop'])
            subprocess.run(['magick', str(raw), '-crop', f'{w}x{h}+{x}+{y}', '+repage', str(output)], check=True)
        else:
            subprocess.run(['magick', str(raw), '-alpha', 'off', str(output)], check=True)
    print(f'Captured {output.relative_to(REPO)}')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('names', nargs='*', help='scenarios to capture (default: all)')
    parser.add_argument('--refresh-holidays', action='store_true', help='download holidays.json from Nager.Date')
    args = parser.parse_args()

    if args.refresh_holidays or not (SOURCE / 'holidays.json').exists():
        refresh_holidays()
    unknown = set(args.names) - {s['name'] for s in SCENARIOS}
    if unknown:
        sys.exit(f'Unknown scenario: {", ".join(sorted(unknown))}')

    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(REPO)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        chrome = os.environ.get('CHROME', 'google-chrome')
        for scenario in SCENARIOS:
            if not args.names or scenario['name'] in args.names:
                capture(scenario, server.server_address[1], chrome)
    finally:
        server.shutdown()


if __name__ == '__main__':
    main()
