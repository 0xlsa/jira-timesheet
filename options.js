/**
 * Timesheet for Jira Options & Weekly Worklog Controller
 *
 * Page controller: owns DOM wiring and view state, and delegates to
 * - settings persistence (src/settings/settingsStore.js),
 * - Jira access (src/jira/createJiraClient.js) and week loading (src/worklog/),
 * - presentation of the weekly view (src/ui/weekView.js),
 * - browser platform services (src/compat/browser-api.js).
 *
 * Compatible with Chrome (MV3) and Firefox (MV3, 140+).
 */

import { JiraUrlValidator } from './src/validation/JiraUrlValidator.js';
import { EMAIL_REGEX } from './src/auth/JiraCloudTokenProvider.js';
import { createJiraClient } from './src/jira/createJiraClient.js';
import {
  getMondayOfWeek,
  getLocalDateKey,
  getWeekRange,
  formatWeekRange,
  formatWorklogDate,
  buildEmptyWeek
} from './src/worklog/worklogUtils.js';
import {
  loadWeek,
  logWork,
  saveWorklogChanges,
  deleteWorklog,
  replaceWorklogInWeek,
  removeWorklogFromWeek
} from './src/worklog/weeklyWorklogService.js';
import { createSettingsStore, normalizeSettings, isConfigured } from './src/settings/settingsStore.js';
import { createSettingsDraft, switchDraftEdition } from './src/settings/settingsDraft.js';
import { createPlatform, ext, isExtensionContext } from './src/compat/browser-api.js';
import { SHOW_TIMESHEET, SETTINGS_HASH } from './src/background/launch.js';
import { h, svg } from './src/ui/dom.js';
import { renderConnectionStatus, STATUS_CLASSES } from './src/ui/connectionStatus.js';
import { renderWeek, renderWorkingIssues } from './src/ui/weekView.js';
import { openWorklogEditor, WORKLOG_FORM_SHORTCUTS } from './src/ui/worklogEditor.js';
import { ISSUE_PICKER_SHORTCUTS } from './src/ui/issuePicker.js';
import { createShortcutRegistry } from './src/ui/shortcuts.js';
import { openShortcutsDrawer } from './src/ui/shortcutsDrawer.js';
import { showPanel, hidePanel } from './src/ui/panel.js';
import { openDeleteWorklogDialog } from './src/ui/deleteWorklogDialog.js';
import { createTokenVisibilityToggle } from './src/ui/tokenVisibility.js';
import { toNewWorklogForm } from './src/worklog/worklogEdit.js';
import { createWorkingIssuesLoader } from './src/worklog/workingIssuesLoader.js';

const platform = createPlatform();
const settingsStore = createSettingsStore(platform.storage);

// ============================================================================
// DOM Element References
// ============================================================================

// Connection Settings drawer, opened from the header's cog
const settingsBtn = document.getElementById('settingsBtn');
const settingsDrawerRoot = document.getElementById('settingsDrawer');
const closeSettingsBtn = document.getElementById('closeSettingsBtn');

// Weekly View Navigation Controls
const prevWeekBtn = document.getElementById('prevWeekBtn');
const thisWeekBtn = document.getElementById('thisWeekBtn');
const nextWeekBtn = document.getElementById('nextWeekBtn');
const weekDateRangeText = document.getElementById('weekDateRangeText');
const refreshWorklogsBtn = document.getElementById('refreshWorklogsBtn');

// Weekly Stats Elements
const weeklyTotalDuration = document.getElementById('weeklyTotalDuration');
const weeklyTotalCount = document.getElementById('weeklyTotalCount');
const selectedDayLabel = document.getElementById('selectedDayLabel');
const selectedDayIndicator = document.getElementById('selectedDayIndicator');
const selectedDayDuration = document.getElementById('selectedDayDuration');
const selectedDayCount = document.getElementById('selectedDayCount');
const deploymentBadge = document.getElementById('deploymentBadge');
const userAvatar = document.getElementById('userAvatar');
const userName = document.getElementById('userName');
const userInstanceHost = document.getElementById('userInstanceHost');

// Weekly Alerts & Containers
const unconfiguredAlert = document.getElementById('unconfiguredAlert');
const goToSettingsBtn = document.getElementById('goToSettingsBtn');
const worklogErrorAlert = document.getElementById('worklogErrorAlert');
const worklogErrorTitle = document.getElementById('worklogErrorTitle');
const worklogErrorMessage = document.getElementById('worklogErrorMessage');
const retryWorklogFetchBtn = document.getElementById('retryWorklogFetchBtn');
const siteAccessAlert = document.getElementById('siteAccessAlert');
const siteAccessMessage = document.getElementById('siteAccessMessage');
const grantSiteAccessBtn = document.getElementById('grantSiteAccessBtn');
const emptyWeekBanner = document.getElementById('emptyWeekBanner');
const daysContainer = document.getElementById('daysContainer');
const worklogEditorRoot = document.getElementById('worklogEditor');
const shortcutsDrawerRoot = document.getElementById('shortcutsDrawer');
const shortcutsHelpBtn = document.getElementById('shortcutsHelpBtn');
const deleteWorklogDialog = document.getElementById('deleteWorklogDialog');
const appToast = document.getElementById('appToast');

// Settings Form Elements
const form = document.getElementById('settingsForm');
const radioCloud = document.getElementById('typeCloud');
const radioServer = document.getElementById('typeServer');
const cloudEmailGroup = document.getElementById('cloudEmailGroup');
const jiraBaseUrlInput = document.getElementById('jiraBaseUrl');
const jiraEmailInput = document.getElementById('jiraEmail');
const jiraTokenInput = document.getElementById('jiraToken');
const tokenLabel = document.getElementById('tokenLabel');
const cloudTokenHelp = document.getElementById('cloudTokenHelp');
const serverTokenHelp = document.getElementById('serverTokenHelp');
const toggleTokenBtn = document.getElementById('toggleTokenVisibility');
const openInstanceBtn = document.getElementById('openInstanceBtn');
const eyeIcon = document.getElementById('eyeIcon');
const eyeOffIcon = document.getElementById('eyeOffIcon');
const urlError = document.getElementById('urlError');
const emailError = document.getElementById('emailError');
const tokenError = document.getElementById('tokenError');
const statusArea = document.getElementById('statusArea');
const testConnectionBtn = document.getElementById('testConnectionBtn');
const testSpinner = document.getElementById('testSpinner');
const saveSettingsBtn = document.getElementById('saveSettingsBtn');
const themeToggleBtn = document.getElementById('themeToggleBtn');

// ============================================================================
// State
// ============================================================================

let currentMonday = getMondayOfWeek(new Date());
let selectedDateKey = getLocalDateKey(new Date());
let currentAggregatedData = null;
let isBusyFetching = false;

// Jira client and instance URL of the displayed week; set when worklogs load.
let currentClient = null;
let currentBaseUrl = '';

// My Active Issues section (see src/ui/weekView.js): what it shows (null hides it, when there is no
// Jira to ask) and whether it's expanded: collapsed until the user expands it, then as they last
// left it. The loader (src/worklog/workingIssuesLoader.js) is created with the section's renderer below.
let workingIssuesState = null;
let isWorkingIssuesExpanded = localStorage.getItem('jts-working-issues-expanded') === 'true';

// Open Edit Worklog panel (see src/ui/worklogEditor.js), or null.
let worklogEditor = null;
// True while the delete worklog confirmation is open.
let isDeleteDialogOpen = false;
// Open keyboard shortcuts drawer (see src/ui/shortcutsDrawer.js), or null.
let shortcutsDrawer = null;
// While the Connection Settings drawer is open: where focus returns, and whether it covers the
// worklog panel. Null when it's closed.
let settingsDrawerState = null;
// Every keyboard shortcut, for running them and for the shortcuts drawer (registered below).
const shortcuts = createShortcutRegistry();
let toastTimer = null;

// Show / hide for the API token field; starts masked and is never persisted.
const tokenVisibility = createTokenVisibilityToggle({
  input: jiraTokenInput,
  button: toggleTokenBtn,
  showIcon: eyeIcon,
  hideIcon: eyeOffIcon
});

// The last saved settings (the active configuration), as loaded from the settings store; null
// until they have loaded. The Connection Settings form is refilled from them each time it opens.
let savedSettings = null;
// The form's unsaved values (src/settings/settingsDraft.js), including the instance URL and token
// of each Jira edition, so Cloud and Data Center / Server values never overwrite each other when
// switching editions. Only a successful save writes them to the store.
let settingsDraft = createSettingsDraft(normalizeSettings({}));

// Connection test bookkeeping. Bumping the id invalidates any in-flight test, so a
// late result cannot mark changed settings as connected. `hasUntestedChanges`
// records edits made since the last successful test.
let connectionTestId = 0;
let hasUntestedChanges = false;

// ============================================================================
// Theme Toggle
// ============================================================================

/**
 * Applies the given theme to <html> and persists it to localStorage.
 * @param {'dark' | 'light'} theme
 */
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('jts-theme', theme);
  themeToggleBtn.setAttribute(
    'aria-label',
    theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'
  );
}

/** Initialise theme from localStorage (default: dark). */
function initTheme() {
  const saved = localStorage.getItem('jts-theme');
  applyTheme(saved === 'light' ? 'light' : 'dark');
}

themeToggleBtn.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  applyTheme(current === 'light' ? 'dark' : 'light');
});

initTheme();

// ============================================================================
// Side Drawers (Connection Settings and keyboard shortcuts)
// ============================================================================

/**
 * Slides an open worklog panel out of the way, without closing it, so nothing typed in it is
 * lost while a drawer is open in its place.
 * @returns {boolean} True when there was a panel to cover; pass it to uncoverWorklogEditor()
 */
function coverWorklogEditor() {
  if (!worklogEditor) return false;
  worklogEditorRoot.classList.add('is-closed');
  worklogEditorRoot.setAttribute('inert', '');
  return true;
}

/**
 * Brings back a worklog panel that coverWorklogEditor() covered, if it's still open.
 * @param {boolean} covered
 */
function uncoverWorklogEditor(covered) {
  if (!covered || !worklogEditor) return;
  worklogEditorRoot.classList.remove('is-closed');
  worklogEditorRoot.removeAttribute('inert');
}

/**
 * Closes the panel on the right through its usual close action, the one on top first: the keyboard
 * shortcuts or Connection Settings drawer, else the worklog panel (which asks first when there are
 * unsaved changes).
 * @returns {boolean} False when nothing is open, so Escape keeps its default
 */
function closeOpenPanel() {
  if (shortcutsDrawer) shortcutsDrawer.close();
  else if (settingsDrawerState) closeSettings();
  else if (worklogEditor) worklogEditor.requestClose();
  else return false;
  return true;
}

/**
 * Opens the Connection Settings drawer, with the form showing the saved settings (anything
 * changed but not saved on an earlier visit is discarded). The keyboard shortcuts drawer closes,
 * since only one drawer is open at a time.
 */
function openSettings() {
  if (settingsDrawerState) return;
  // Unsaved changes from an earlier visit are discarded: the form shows the saved settings.
  if (savedSettings) fillSettingsForm(savedSettings);
  shortcutsDrawer?.close();
  settingsDrawerState = { returnFocus: document.activeElement, coversEditor: coverWorklogEditor() };
  showPanel(settingsDrawerRoot);
  settingsBtn.setAttribute('aria-expanded', 'true');
  jiraBaseUrlInput.focus();
}

/** Closes the Connection Settings drawer. Unsaved changes are discarded when it next opens. */
function closeSettings() {
  if (!settingsDrawerState) return;
  const { returnFocus, coversEditor } = settingsDrawerState;
  settingsDrawerState = null;
  // A revealed token never outlives a visit to Settings.
  tokenVisibility.mask();
  hidePanel(settingsDrawerRoot, { keepContents: true });
  settingsBtn.setAttribute('aria-expanded', 'false');
  uncoverWorklogEditor(coversEditor);
  // Back to where the user was, if it's still there.
  if (returnFocus?.isConnected && returnFocus !== document.body) returnFocus.focus();
}

// ============================================================================
// Worklog UI Rendering
// ============================================================================

/**
 * Updates the "Selected Day" metric card in the top summary bar.
 * @param {string} targetDateKey
 */
function updateSelectedDayMetric(targetDateKey) {
  if (!currentAggregatedData || !currentAggregatedData.weekDays) {
    return;
  }

  // Find day descriptor in current week
  let day = currentAggregatedData.weekDays.find((d) => d.dateKey === targetDateKey);

  // If selected day is not in current week, default to Monday
  if (!day) {
    day = currentAggregatedData.weekDays[0];
    if (day) {
      selectedDateKey = day.dateKey;
    }
  }

  if (!day) return;

  const isToday = day.isToday;
  selectedDayLabel.textContent = isToday ? "Today's Total" : `${day.dayName}'s Total`;
  selectedDayIndicator.textContent = isToday ? 'Today' : day.formattedDate;
  selectedDayDuration.textContent = day.formattedTotal;
  selectedDayCount.textContent = `${day.worklogCount} worklog${day.worklogCount === 1 ? '' : 's'}`;
}

/**
 * Renders the weekday cards and selected-day panel for a week. Clicking a card
 * selects that day and re-renders with the same data.
 *
 * @param {object} aggregatedData
 * @param {string} baseUrl
 */
function renderDays(aggregatedData, baseUrl = '') {
  renderWeek(daysContainer, aggregatedData, {
    selectedDateKey,
    baseUrl,
    onSelectDay: (dateKey) => {
      selectedDateKey = dateKey;
      updateSelectedDayMetric(dateKey);
      renderDays(aggregatedData, baseUrl);
      daysContainer.querySelector(`.day-card[data-date-key="${dateKey}"]`)?.focus();
      // While logging new work, the selected day is the day being logged.
      if (worklogEditor?.mode === 'create') worklogEditor.setDefaultDate(dateKey);
    },
    onAddWorklog: aggregatedData.sourceWorklogs ? startLogWorkOnDay : undefined,
    onEditWorklog: aggregatedData.sourceWorklogs ? openEditor : undefined,
    onLogWork: aggregatedData.sourceWorklogs ? startLogWork : undefined,
    onDeleteWorklog: aggregatedData.sourceWorklogs ? confirmDeleteWorklog : undefined,
    editingWorklogId: worklogEditor?.worklogId,
    workingIssues: workingIssuesOptions()
  });
}

// ============================================================================
// My Active Issues
// ============================================================================

/**
 * Options for the My Active Issues section, or undefined to leave it out.
 * @returns {object | undefined}
 */
function workingIssuesOptions() {
  if (!workingIssuesState) return undefined;
  return {
    state: workingIssuesState,
    expanded: isWorkingIssuesExpanded,
    onToggle: (expanded) => {
      isWorkingIssuesExpanded = expanded;
      localStorage.setItem('jts-working-issues-expanded', String(expanded));
    },
    onRetry: refreshActiveIssues,
    // Like the worklog cards' + buttons: once the week has loaded.
    onLogWork: currentAggregatedData?.sourceWorklogs ? startLogWorkOnIssue : undefined
  };
}

/**
 * Shows a new My Active Issues state, updating the section in place when it's on the page.
 * @param {object | null} state
 */
function setWorkingIssuesState(state) {
  workingIssuesState = state;
  const section = daysContainer.querySelector('#workingIssues');
  if (state && section) {
    renderWorkingIssues(section, { ...workingIssuesOptions(), baseUrl: currentBaseUrl });
  } else if (!state) {
    section?.remove();
  }
}

// Loads the My Active Issues section's contents on its own: the worklogs load and show whatever
// happens there. Refreshed with every week load (changing weeks, Sync); a newer load cancels an
// older one.
const workingIssues = createWorkingIssuesLoader(setWorkingIssuesState);

/**
 * Reloads My Active Issues for the displayed week: Retry, and after a worklog is logged, edited,
 * or deleted, which can add an issue (its first worklog this week) or remove one (its last).
 */
function refreshActiveIssues() {
  if (!currentClient) return;
  const { monday, sunday } = getWeekRange(currentMonday);
  workingIssues.refresh(currentClient, { monday, sunday, force: true });
}

/**
 * Shows a loaded week: totals, the selected-day card, the empty-week banner, and the days.
 *
 * @param {object} aggregated - From loadWeek() or a week updated after an edit
 * @param {string} baseUrl
 */
function showWeek(aggregated, baseUrl) {
  currentAggregatedData = aggregated;

  weeklyTotalDuration.textContent = aggregated.formattedWeekTotal;
  weeklyTotalCount.textContent = `${aggregated.totalWorklogsCount} worklog${aggregated.totalWorklogsCount === 1 ? '' : 's'}`;

  updateSelectedDayMetric(selectedDateKey);
  emptyWeekBanner.classList.toggle('hidden', aggregated.hasAnyWorklogs);
  renderDays(aggregated, baseUrl);
}

// ============================================================================
// Worklog Editing
// ============================================================================

/**
 * Shows a short confirmation message at the bottom of the page.
 * @param {string} message
 * @param {object} [options]
 * @param {boolean} [options.success=false] - Success style: a check icon and a close button
 * @param {string} [options.subtitle] - Success style: a second, muted line under the message
 * @param {number} [options.durationMs=4000] - Time before it's dismissed automatically
 */
function showToast(message, { success = false, subtitle = '', durationMs = 4000 } = {}) {
  clearTimeout(toastTimer);
  appToast.classList.toggle('app-toast--success', success);
  appToast.replaceChildren(...(success
    ? [
      svg('svg', { class: 'app-toast-icon', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
        svg('circle', { cx: '12', cy: '12', r: '10' }),
        svg('polyline', { points: '7.5 12.5 10.5 15.5 16.5 9' })),
      h('span', { class: 'app-toast-text' },
        h('span', { class: 'app-toast-message' }, message),
        // Keeps the two lines apart when read aloud ("Saved ABC-1, 28 Oct…", not "ABC-128 Oct…").
        subtitle && h('span', { class: 'sr-only' }, ', '),
        subtitle && h('span', { class: 'app-toast-subtitle' }, subtitle)),
      h('button', { type: 'button', class: 'app-toast-close', 'aria-label': 'Dismiss notification', title: 'Dismiss' },
        svg('svg', { class: 'icon', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'aria-hidden': 'true' },
          svg('line', { x1: '18', y1: '6', x2: '6', y2: '18' }),
          svg('line', { x1: '6', y1: '6', x2: '18', y2: '18' })))
    ]
    : [message]));
  toastTimer = setTimeout(hideToast, durationMs);
}

/** Removes the toast, after its time or from its close button. */
function hideToast() {
  clearTimeout(toastTimer);
  appToast.replaceChildren();
  appToast.classList.remove('app-toast--success');
}

/**
 * Returns the selected day's card, the place to return focus to.
 * @returns {HTMLElement | null}
 */
function selectedDayFocusTarget() {
  return daysContainer.querySelector('.day-card.is-selected');
}

/**
 * Opens the Log work panel on the given day, for an issue or, with `issue` null, for an
 * issue the user finds in the panel by its key.
 *
 * @param {object} options
 * @param {object | null} options.issue - `issueId`, `issueKey`, `issueSummary`, `issueStatus`
 * @param {string} options.dateKey - Day the date field starts on
 * @param {() => HTMLElement | null} options.returnFocusTo - Element to focus once the panel closes
 */
function openLogWork({ issue, dateKey, returnFocusTo }) {
  const client = currentClient;
  if (!client) return;

  worklogEditor = openWorklogEditor(worklogEditorRoot, {
    mode: 'create',
    worklog: issue,
    baseUrl: client.baseUrl,
    initialForm: toNewWorklogForm({ dateKey }),
    searchIssues: (query, options) => client.suggestIssuesByKey(query, options),
    onDateChange: (enteredDateKey) => {
      // Select the entered day in the calendar when it's in the displayed week.
      if (enteredDateKey === selectedDateKey || !currentAggregatedData?.weekDays.some((d) => d.dateKey === enteredDateKey)) return;
      selectedDateKey = enteredDateKey;
      updateSelectedDayMetric(enteredDateKey);
      renderDays(currentAggregatedData, currentBaseUrl);
    },
    onSave: async (newWorklog, loggedIssue) => {
      const created = await logWork(client, loggedIssue, newWorklog, currentAggregatedData?.user);
      const startedOn = new Date(created.started);
      const createdDateKey = getLocalDateKey(startedOn);

      // Add it to the displayed week (no reload) and show its day; another week loads it from Jira.
      if (currentAggregatedData?.sourceWorklogs && currentAggregatedData.weekDays.some((d) => d.dateKey === createdDateKey)) {
        selectedDateKey = createdDateKey;
        showWeek(replaceWorklogInWeek(currentAggregatedData, created), currentBaseUrl);
      }
      refreshActiveIssues();
      // The issue key and the worklog's own (logged) date, as Jira stored them.
      showToast(`Saved ${loggedIssue.issueKey}`, { success: true, subtitle: formatWorklogDate(startedOn), durationMs: 5000 });
    },
    onClose: () => {
      worklogEditor = null;
      if (currentAggregatedData) renderDays(currentAggregatedData, currentBaseUrl);
      (returnFocusTo() || selectedDayFocusTarget())?.focus();
    }
  });

  renderDays(currentAggregatedData, currentBaseUrl);
}

/**
 * Opens the Log work panel for the issue of a worklog in the displayed week (the card's
 * + button). The issue comes from the week already loaded, so opening makes no Jira requests.
 * The date defaults to the selected day and the start time to now.
 * @param {string} worklogId - A worklog on the issue to log work against
 */
function startLogWork(worklogId) {
  shortcutsDrawer?.close();
  closeSettings();
  if (worklogEditor && !worklogEditor.requestClose()) return;

  const source = currentAggregatedData?.sourceWorklogs?.find((wl) => String(wl.id) === worklogId);
  if (!source) return;

  openLogWork({
    issue: {
      issueId: source.issueId,
      issueKey: source.issueKey,
      issueSummary: source.issueSummary,
      issueStatus: source.issueStatus
    },
    dateKey: selectedDateKey,
    // Back to the + button it was opened from
    returnFocusTo: () => daysContainer.querySelector(`.worklog-log-btn[data-worklog-id="${CSS.escape(worklogId)}"]`)
  });
}

/**
 * Opens the Log work panel for an issue in My Active Issues (the row's + button). Like a worklog
 * card's + button, the date defaults to the selected day and the start time to now.
 * @param {{ issueId: string, issueKey: string, issueSummary: string, issueStatus: object | null }} issue
 */
function startLogWorkOnIssue(issue) {
  shortcutsDrawer?.close();
  closeSettings();
  if (worklogEditor && !worklogEditor.requestClose()) return;

  openLogWork({
    issue: {
      issueId: issue.issueId,
      issueKey: issue.issueKey,
      issueSummary: issue.issueSummary,
      issueStatus: issue.issueStatus
    },
    dateKey: selectedDateKey,
    // Back to the + button it was opened from
    returnFocusTo: () => daysContainer.querySelector(`.working-issue-log-btn[data-issue-key="${CSS.escape(issue.issueKey)}"]`)
  });
}

/**
 * Opens the Log work panel on a day (the + button in the selected day's panel). The date
 * starts on that day, and the user finds the issue in the panel by its key.
 * @param {string} dateKey - YYYY-MM-DD
 */
function startLogWorkOnDay(dateKey) {
  shortcutsDrawer?.close();
  closeSettings();
  if (worklogEditor && !worklogEditor.requestClose()) return;
  if (!currentAggregatedData?.weekDays.some((d) => d.dateKey === dateKey)) return;

  selectedDateKey = dateKey;
  updateSelectedDayMetric(dateKey);
  openLogWork({
    issue: null,
    dateKey,
    returnFocusTo: () => daysContainer.querySelector(`.day-add-btn[data-date-key="${dateKey}"]`)
  });
}

/**
 * Deletes a worklog in Jira, then removes it from the displayed week and recalculates the
 * totals. The week changes only after Jira confirms; a failed request rejects with a
 * user-facing Error and leaves the week as it was.
 * @param {object} client
 * @param {object} worklog - Source worklog
 */
async function deleteWorklogAndRefresh(client, worklog) {
  await deleteWorklog(client, worklog);
  if (currentAggregatedData?.sourceWorklogs) {
    showWeek(removeWorklogFromWeek(currentAggregatedData, String(worklog.id)), currentBaseUrl);
  }
  refreshActiveIssues();
  showToast('Worklog deleted.');
}

/**
 * Asks to confirm deleting a worklog in the displayed week (the card's trash button).
 * An open editor is closed first, asking about unsaved changes as usual.
 * @param {string} worklogId
 */
function confirmDeleteWorklog(worklogId) {
  shortcutsDrawer?.close();
  closeSettings();
  if (isDeleteDialogOpen) return;
  if (worklogEditor && !worklogEditor.requestClose()) return;

  const worklog = currentAggregatedData?.sourceWorklogs?.find((wl) => String(wl.id) === worklogId);
  const client = currentClient;
  if (!worklog || !client) return;

  isDeleteDialogOpen = true;
  openDeleteWorklogDialog(deleteWorklogDialog, {
    worklog,
    onDelete: () => deleteWorklogAndRefresh(client, worklog),
    onClose: (reason) => {
      isDeleteDialogOpen = false;
      // Back to the trash button, or the selected day once the worklog is gone.
      ((reason === 'cancelled' && daysContainer.querySelector(`.worklog-delete-btn[data-worklog-id="${CSS.escape(worklogId)}"]`)) ||
        selectedDayFocusTarget())?.focus();
    }
  });
}

/**
 * Opens the Edit Worklog panel for a worklog in the displayed week. If another worklog
 * is open with unsaved changes, the user is asked to discard them first.
 * @param {string} worklogId
 */
function openEditor(worklogId) {
  shortcutsDrawer?.close();
  closeSettings();
  if (worklogEditor) {
    if (worklogEditor.worklogId === worklogId) {
      worklogEditor.focus();
      return;
    }
    if (!worklogEditor.requestClose()) return;
  }

  const worklog = currentAggregatedData?.sourceWorklogs?.find((wl) => String(wl.id) === worklogId);
  const client = currentClient;
  if (!worklog || !client) return;

  worklogEditor = openWorklogEditor(worklogEditorRoot, {
    worklog,
    baseUrl: client.baseUrl,
    onSave: async (changes) => {
      const updated = await saveWorklogChanges(client, worklog, changes);
      // The user may have moved to another week meanwhile; that week reloads from Jira anyway.
      if (currentAggregatedData?.sourceWorklogs?.some((wl) => String(wl.id) === worklogId)) {
        showWeek(replaceWorklogInWeek(currentAggregatedData, updated), currentBaseUrl);
      }
      refreshActiveIssues();
      const movedTo = new Date(updated.started);
      const stillInWeek = currentAggregatedData.weekDays.some((d) => d.dateKey === getLocalDateKey(movedTo));
      showToast(stillInWeek ? 'Worklog updated.' : `Worklog updated and moved to ${movedTo.toLocaleDateString()}.`);
    },
    onDelete: () => deleteWorklogAndRefresh(client, worklog),
    onClose: () => {
      worklogEditor = null;
      if (currentAggregatedData) renderDays(currentAggregatedData, currentBaseUrl);
      // Return focus to the edited worklog's button, or the selected day if it moved or was deleted.
      (daysContainer.querySelector(`.worklog-edit-btn[data-worklog-id="${CSS.escape(worklogId)}"]`) ||
        selectedDayFocusTarget())?.focus();
    }
  });

  renderDays(currentAggregatedData, currentBaseUrl);
}

// ============================================================================
// Jira Site Access
// ============================================================================

/**
 * Returns the host of a Jira instance URL, for messages.
 * @param {string} baseUrl
 * @returns {string}
 */
function getSiteHost(baseUrl) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/**
 * Asks the browser for access to the Jira site of an instance URL (just that site, not
 * every HTTPS site; see `optional_host_permissions` in manifest.json). Call it synchronously
 * from a click or submit handler, before any `await`, or the browser won't show its prompt.
 * Resolves to true when access is granted; when it already was, the browser doesn't ask again.
 *
 * @param {string} baseUrl - Validated Jira instance URL
 * @returns {Promise<boolean>}
 */
function requestSiteAccess(baseUrl) {
  return platform.hostAccess.request(JiraUrlValidator.validate(baseUrl).originPattern);
}

/**
 * Message shown when the user hasn't allowed access to the Jira site.
 * @param {string} baseUrl
 * @returns {string}
 */
function siteAccessDeniedMessage(baseUrl) {
  return `Timesheet for Jira needs your permission to connect to ${getSiteHost(baseUrl)}. ` +
    'Try again and choose Allow when your browser asks.';
}

/**
 * Revokes access to Jira sites that are no longer in the saved settings, keeping the
 * Cloud and Data Center / Server sites, so switching edition doesn't ask again.
 * @param {string[]} baseUrls
 */
async function removeUnusedSiteAccess(baseUrls) {
  const keep = baseUrls
    .map((url) => JiraUrlValidator.validate(url))
    .filter((check) => check.isValid)
    .map((check) => check.originPattern);
  try {
    await platform.hostAccess.removeExcept(keep);
  } catch (err) {
    console.warn('Could not remove access to unused Jira sites:', err);
  }
}

/**
 * Shows the weekly view's prompt to allow access to the configured Jira site.
 * @param {string} baseUrl
 */
function showSiteAccessNeeded(baseUrl) {
  siteAccessMessage.textContent = `Timesheet for Jira needs your permission to connect to ${getSiteHost(baseUrl)}. ` +
    'It reads and changes only your worklogs on that site, and gets no access to other sites.';
  siteAccessAlert.classList.remove('hidden');
  worklogErrorAlert.classList.add('hidden');
  emptyWeekBanner.classList.add('hidden');

  const emptyAggregated = buildEmptyWeek(currentMonday);
  currentAggregatedData = emptyAggregated;
  renderDays(emptyAggregated);
}

/**
 * Fetches worklogs from Jira for the current week and updates all views.
 *
 * @param {object} [options]
 * @param {boolean} [options.force=false] - Also reload My Active Issues when the week is already shown (Sync, Retry, new settings)
 */
async function loadAndRenderWorklogs(options = {}) {
  if (isBusyFetching) return;

  const { monday, sunday } = getWeekRange(currentMonday);

  // Update date range heading immediately
  weekDateRangeText.textContent = formatWeekRange(monday, sunday);

  let settings;
  try {
    settings = await settingsStore.load();
  } catch (err) {
    console.error('Storage access error:', err);
    settings = normalizeSettings({});
  }

  siteAccessAlert.classList.add('hidden');

  if (!isConfigured(settings)) {
    workingIssues.clear();
    unconfiguredAlert.classList.remove('hidden');
    worklogErrorAlert.classList.add('hidden');
    emptyWeekBanner.classList.add('hidden');

    // Render empty week with 0h 00m totals
    const emptyAggregated = buildEmptyWeek(monday);
    currentAggregatedData = emptyAggregated;

    weeklyTotalDuration.textContent = '0h 00m';
    weeklyTotalCount.textContent = '0 worklogs';
    updateSelectedDayMetric(selectedDateKey);
    renderDays(emptyAggregated);

    // Update instance card
    userName.textContent = 'Not configured';
    userInstanceHost.textContent = 'Please configure Jira in Settings';
    userAvatar.textContent = '?';
    deploymentBadge.textContent = 'Unset';
    deploymentBadge.className = 'stat-badge';
    return;
  }

  // Hide unconfigured alert
  unconfiguredAlert.classList.add('hidden');

  const { client, error } = createJiraClient({
    baseUrl: settings.jiraBaseUrl,
    deploymentType: settings.deploymentType,
    email: settings.email,
    token: settings.token
  });
  if (!client) {
    workingIssues.clear();
    showWorklogError('Invalid Jira Configuration', error);
    return;
  }

  currentClient = client;
  currentBaseUrl = client.baseUrl;

  // Update instance card header immediately with domain
  userInstanceHost.textContent = getSiteHost(client.baseUrl);

  deploymentBadge.textContent = settings.deploymentType === 'cloud' ? 'Cloud' : 'Data Center';
  deploymentBadge.className = `stat-badge ${settings.deploymentType === 'cloud' ? 'badge-cloud' : 'badge-server'}`;

  setWorklogBusy(true);
  worklogErrorAlert.classList.add('hidden');
  emptyWeekBanner.classList.add('hidden');

  try {
    // Without access to the Jira site every request fails, so ask for it instead. Access is
    // missing if it was never granted for this site, or the user removed it in the browser.
    if (!(await platform.hostAccess.has(JiraUrlValidator.validate(client.baseUrl).originPattern))) {
      workingIssues.clear();
      showSiteAccessNeeded(client.baseUrl);
      return;
    }

    // Not awaited: the worklogs don't wait for the issues, nor fail with them.
    workingIssues.refresh(client, { monday, sunday, force: Boolean(options.force) });

    const aggregated = await loadWeek(client, { monday, sunday });

    // Populate user metadata from response
    if (aggregated.user) {
      userName.textContent = aggregated.user.displayName || 'Authenticated User';
      const initial = (aggregated.user.displayName || 'U').charAt(0).toUpperCase();
      userAvatar.textContent = initial;
    }

    showWeek(aggregated, client.baseUrl);
  } catch (err) {
    console.error('Failed to load Jira worklogs:', err);
    showWorklogError('Error Fetching Worklogs', err.message || 'Unable to connect to Jira REST API.');
  } finally {
    setWorklogBusy(false);
  }
}

/**
 * Shows an error banner on the weekly view.
 * @param {string} title
 * @param {string} message
 */
function showWorklogError(title, message) {
  siteAccessAlert.classList.add('hidden');
  worklogErrorTitle.textContent = title;
  worklogErrorMessage.textContent = message;
  worklogErrorAlert.classList.remove('hidden');
  emptyWeekBanner.classList.add('hidden');

  // Render empty 7 days so layout stays consistent
  const emptyAggregated = buildEmptyWeek(currentMonday);
  currentAggregatedData = emptyAggregated;
  renderDays(emptyAggregated);
}

/**
 * Sets loading spinners and disabled state on navigation controls.
 * @param {boolean} isBusy
 */
function setWorklogBusy(isBusy) {
  isBusyFetching = isBusy;
  prevWeekBtn.disabled = isBusy;
  thisWeekBtn.disabled = isBusy;
  nextWeekBtn.disabled = isBusy;
  refreshWorklogsBtn.disabled = isBusy;

  if (isBusy) {
    refreshWorklogsBtn.classList.add('spinning');
  } else {
    refreshWorklogsBtn.classList.remove('spinning');
  }
}

// ============================================================================
// Settings Page Controller (Preserved and Enhanced)
// ============================================================================

/**
 * Clears all inline validation errors.
 */
function clearErrors() {
  [urlError, emailError, tokenError].forEach((el) => {
    el.textContent = '';
    el.classList.remove('visible');
  });
  [jiraBaseUrlInput, jiraEmailInput, jiraTokenInput].forEach((el) => {
    el.classList.remove('is-invalid');
  });
}

/**
 * Shows an inline field error.
 * @param {HTMLInputElement} inputEl
 * @param {HTMLElement} errorEl
 * @param {string} message
 */
function showFieldError(inputEl, errorEl, message) {
  inputEl.classList.add('is-invalid');
  errorEl.textContent = message;
  errorEl.classList.add('visible');
}

/**
 * Updates UI layout when deployment type changes (Cloud vs Data Center / Server).
 * @param {'cloud' | 'server'} type
 */
function setDeploymentType(type) {
  clearErrors();
  jiraBaseUrlInput.placeholder = JiraUrlValidator.EXAMPLE_URLS[type];
  if (type === 'cloud') {
    radioCloud.checked = true;
    cloudEmailGroup.classList.remove('hidden');
    tokenLabel.replaceChildren('Atlassian API Token ', h('span', { class: 'required' }, '*'));
    jiraTokenInput.placeholder = 'Enter your Atlassian API token';
    cloudTokenHelp.classList.remove('hidden');
    serverTokenHelp.classList.add('hidden');
  } else {
    radioServer.checked = true;
    cloudEmailGroup.classList.add('hidden');
    tokenLabel.replaceChildren('Personal Access Token (PAT) ', h('span', { class: 'required' }, '*'));
    jiraTokenInput.placeholder = 'Enter your Personal Access Token (PAT)';
    cloudTokenHelp.classList.add('hidden');
    serverTokenHelp.classList.remove('hidden');
  }
}

/**
 * Switches deployment type from the radio controls, swapping the instance URL
 * and token fields to the values remembered for the newly selected edition.
 * @param {'cloud' | 'server'} type
 */
function switchDeploymentType(type) {
  const { baseUrl, token } = switchDraftEdition(settingsDraft, type, {
    baseUrl: jiraBaseUrlInput.value.trim(),
    token: jiraTokenInput.value.trim()
  });
  setDeploymentType(type);
  jiraBaseUrlInput.value = baseUrl;
  jiraTokenInput.value = token;
  updateOpenInstanceBtn();
  invalidateConnectionStatus();
}

/**
 * Returns the entered Jira instance URL if it is valid and uses HTTPS, otherwise null.
 * @returns {string | null}
 */
function getOpenableInstanceUrl() {
  const check = JiraUrlValidator.validate(jiraBaseUrlInput.value);
  if (!check.isValid) return null;

  try {
    const parsed = new URL(check.sanitizedUrl);
    return parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

/**
 * Enables the "open instance" action only while the URL field holds a valid HTTPS URL.
 */
function updateOpenInstanceBtn() {
  openInstanceBtn.disabled = getOpenableInstanceUrl() === null;
}

/**
 * Discards the previous connection test result after a connection-relevant setting
 * changes, returning the status area to its neutral (hidden) state.
 */
function invalidateConnectionStatus() {
  connectionTestId++;
  hasUntestedChanges = true;
  statusArea.className = 'status-container hidden';
  statusArea.replaceChildren();
}

/**
 * Validates current form fields.
 * @returns {{
 *   isValid: boolean,
 *   values: {
 *     baseUrl: string,
 *     deploymentType: 'cloud' | 'server',
 *     email: string,
 *     token: string
 *   } | null
 * }}
 */
function validateForm() {
  clearErrors();
  let isValid = true;

  const deploymentType = radioCloud.checked ? 'cloud' : 'server';
  const rawUrl = jiraBaseUrlInput.value.trim();
  const email = jiraEmailInput.value.trim();
  const token = jiraTokenInput.value.trim();

  // 1. URL Validation
  const urlCheck = JiraUrlValidator.validate(rawUrl, { deploymentType });
  if (!urlCheck.isValid) {
    showFieldError(jiraBaseUrlInput, urlError, urlCheck.error || 'Invalid URL.');
    isValid = false;
  }

  // 2. Cloud Email Validation
  if (deploymentType === 'cloud') {
    if (!email) {
      showFieldError(jiraEmailInput, emailError, 'Account email is required for Jira Cloud.');
      isValid = false;
    } else if (!EMAIL_REGEX.test(email)) {
      showFieldError(jiraEmailInput, emailError, 'Please enter a valid email address.');
      isValid = false;
    }
  }

  // 3. Token Validation
  if (!token) {
    const errorMsg = deploymentType === 'cloud'
      ? 'Atlassian API Token is required.'
      : 'Personal Access Token (PAT) is required.';
    showFieldError(jiraTokenInput, tokenError, errorMsg);
    isValid = false;
  }

  if (!isValid) {
    return { isValid: false, values: null };
  }

  return {
    isValid: true,
    values: {
      baseUrl: urlCheck.sanitizedUrl,
      deploymentType,
      // Kept for both editions so saving Data Center / Server doesn't erase the Cloud email.
      email,
      token
    }
  };
}

/**
 * Displays status feedback in the settings status area.
 * @param {'loading' | 'success' | 'error' | 'info'} type
 * @param {object} payload
 */
function renderStatus(type, payload = {}) {
  statusArea.className = `status-container ${STATUS_CLASSES[type] || 'status-info'}`;
  statusArea.replaceChildren(...renderConnectionStatus(type, payload));
}

/**
 * Handles "Test Connection" button click.
 */
async function onTestConnection() {
  const formValidation = validateForm();
  if (!formValidation.isValid || !formValidation.values) {
    return;
  }

  // Before any await, so the browser still treats it as part of the click.
  const siteAccess = requestSiteAccess(formValidation.values.baseUrl);
  const testId = ++connectionTestId;

  renderStatus('loading');
  setBusy(true);

  try {
    if (!(await siteAccess)) {
      if (testId !== connectionTestId) return;
      renderStatus('error', { error: siteAccessDeniedMessage(formValidation.values.baseUrl) });
      return;
    }

    const { client } = createJiraClient(formValidation.values);
    const result = await client.testConnection();
    // Settings changed while the test was running: the result no longer applies.
    if (testId !== connectionTestId) return;

    if (result.success) {
      hasUntestedChanges = false;
      renderStatus('success', result);

      settingsStore.saveTestResult(result);
    } else {
      renderStatus('error', result);
    }
  } catch (err) {
    if (testId !== connectionTestId) return;
    renderStatus('error', {
      error: `Unexpected error: ${err.message || 'Unknown failure'}`
    });
  } finally {
    setBusy(false);
  }
}

/**
 * Handles "Save Settings" form submission.
 * @param {Event} event
 */
async function onSaveSettings(event) {
  event.preventDefault();
  // Not while a save or connection test is running (Enter in a field submits too).
  if (saveSettingsBtn.disabled) return;

  const formValidation = validateForm();
  if (!formValidation.isValid || !formValidation.values) {
    return;
  }

  const { baseUrl, deploymentType, email, token } = formValidation.values;

  // Before any await, so the browser still treats it as part of the submit. Settings are
  // saved even if access is refused; the weekly view then offers to allow it.
  const siteAccess = requestSiteAccess(baseUrl).catch((err) => {
    console.warn('Jira site access request failed:', err);
    return false;
  });

  jiraBaseUrlInput.value = baseUrl;
  setBusy(true);

  try {
    const hasSiteAccess = await siteAccess;

    const { baseUrlsByType, tokensByType } = settingsDraft;
    baseUrlsByType[deploymentType] = baseUrl;
    tokensByType[deploymentType] = token;

    await settingsStore.save({ deploymentType, email, baseUrlsByType, tokensByType });

    // Don't show the previous "Connection Successful" on next load for settings
    // that were changed and saved without being tested.
    if (hasUntestedChanges) {
      await settingsStore.clearTestResult();
    }

    // The saved settings are now the active configuration, and what the form shows when it
    // next opens.
    savedSettings = await settingsStore.load();

    await removeUnusedSiteAccess([baseUrlsByType.cloud, baseUrlsByType.server]);

    // Saved: close the drawer and confirm with a toast, which stays after the drawer has gone.
    // Without site access, the timesheet offers Allow Access.
    closeSettings();
    showToast('Settings saved', {
      success: true,
      subtitle: hasSiteAccess ? '' : `Allow access to ${getSiteHost(baseUrl)} to load your worklogs`,
      durationMs: 5000
    });

    // Refresh worklog view with updated settings
    loadAndRenderWorklogs({ force: true });
  } catch (err) {
    // The drawer stays open with everything as entered, so saving can be retried.
    renderStatus('error', {
      title: 'Settings Not Saved',
      error: `Your settings could not be saved: ${err.message || 'Storage error'}. Your entries are kept; try again.`
    });
  } finally {
    setBusy(false);
  }
}

/**
 * Toggles disabled states and spinners during settings async actions.
 * @param {boolean} isBusy
 */
function setBusy(isBusy) {
  testConnectionBtn.disabled = isBusy;
  saveSettingsBtn.disabled = isBusy;
  if (isBusy) {
    testSpinner.classList.remove('hidden');
  } else {
    testSpinner.classList.add('hidden');
  }
}

/**
 * Fills the Connection Settings form from saved settings, discarding any unsaved changes: the
 * edition, each edition's instance URL and token, the email, and the saved connection test
 * result. A connection test still running is ignored when it finishes.
 * @param {ReturnType<typeof normalizeSettings>} settings
 */
function fillSettingsForm(settings) {
  settingsDraft = createSettingsDraft(settings);
  const { deploymentType } = settingsDraft;

  setDeploymentType(deploymentType);
  jiraBaseUrlInput.value = settingsDraft.baseUrlsByType[deploymentType];
  updateOpenInstanceBtn();
  jiraEmailInput.value = settingsDraft.email;
  jiraTokenInput.value = settingsDraft.tokensByType[deploymentType];

  invalidateConnectionStatus();
  hasUntestedChanges = false;
  if (settings.lastTestResult && settings.lastTestResult.success) {
    renderStatus('success', settings.lastTestResult);
  }
}

/**
 * Loads saved settings from the browser extension storage when the page opens.
 * Works with both chrome.storage.local (Chrome MV3) and browser.storage.local (Firefox MV3).
 */
async function loadSavedSettings() {
  try {
    const settings = await settingsStore.load();
    savedSettings = settings;
    fillSettingsForm(settings);

    // Open Connection Settings when the page was opened for them (the toolbar icon's Settings menu
    // item) or nothing is configured yet. The hash is dropped at once, so a reload or a later
    // visit shows just the timesheet.
    const hasConfig = Boolean(settings.jiraBaseUrl && settings.token);
    const openedForSettings = window.location.hash === SETTINGS_HASH;
    if (openedForSettings) history.replaceState(null, '', window.location.pathname + window.location.search);
    if (openedForSettings || (!hasConfig && window.location.hash !== '#weekly')) {
      openSettings();
    }

    // Load worklogs for initial view
    loadAndRenderWorklogs({ initial: true });
  } catch (err) {
    console.error('Failed to load Timesheet for Jira settings:', err);
    loadAndRenderWorklogs({ initial: true });
  }
}

// ============================================================================
// Event Listeners
// ============================================================================

// View Switching
// The cog opens or closes the Connection Settings drawer; Escape and its close button close it.
settingsBtn.addEventListener('click', () => (settingsDrawerState ? closeSettings() : openSettings()));
closeSettingsBtn.addEventListener('click', closeSettings);
settingsDrawerRoot.addEventListener('keydown', (event) => {
  if (!settingsDrawerState || event.key !== 'Escape') return;
  event.preventDefault();
  event.stopPropagation();
  closeSettings();
});
goToSettingsBtn.addEventListener('click', openSettings);

// Week Navigation
prevWeekBtn.addEventListener('click', () => {
  currentMonday.setDate(currentMonday.getDate() - 7);
  loadAndRenderWorklogs();
});

nextWeekBtn.addEventListener('click', () => {
  currentMonday.setDate(currentMonday.getDate() + 7);
  loadAndRenderWorklogs();
});

thisWeekBtn.addEventListener('click', () => {
  currentMonday = getMondayOfWeek(new Date());
  selectedDateKey = getLocalDateKey(new Date());
  loadAndRenderWorklogs();
});

refreshWorklogsBtn.addEventListener('click', () => {
  loadAndRenderWorklogs({ force: true });
});

retryWorklogFetchBtn.addEventListener('click', () => {
  loadAndRenderWorklogs({ force: true });
});

grantSiteAccessBtn.addEventListener('click', async () => {
  if (!currentBaseUrl) return;

  let granted;
  try {
    // First statement of the click handler, so the browser shows its prompt.
    granted = await requestSiteAccess(currentBaseUrl);
  } catch (err) {
    showWorklogError('Unable to Request Access', err.message || 'The browser refused the access request.');
    return;
  }

  if (granted) {
    loadAndRenderWorklogs({ force: true });
  } else {
    siteAccessMessage.textContent = siteAccessDeniedMessage(currentBaseUrl);
  }
});

// Settings Form Actions
radioCloud.addEventListener('change', () => switchDeploymentType('cloud'));
radioServer.addEventListener('change', () => switchDeploymentType('server'));

// Mask the token when the browser tab is hidden or the page is left (including bfcache).
// Window blur is not used: it also fires for devtools and browser menus, so it would hide
// the token while the user is still working with it.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') tokenVisibility.mask();
});
window.addEventListener('pagehide', () => tokenVisibility.mask());

jiraBaseUrlInput.addEventListener('blur', () => {
  const val = jiraBaseUrlInput.value.trim();
  if (val) {
    const check = JiraUrlValidator.validate(val, { deploymentType: radioCloud.checked ? 'cloud' : 'server' });
    if (!check.isValid) {
      showFieldError(jiraBaseUrlInput, urlError, check.error || 'Invalid URL');
    } else {
      jiraBaseUrlInput.value = check.sanitizedUrl;
      jiraBaseUrlInput.classList.remove('is-invalid');
      urlError.classList.remove('visible');
    }
  }
});

jiraBaseUrlInput.addEventListener('input', () => {
  jiraBaseUrlInput.classList.remove('is-invalid');
  urlError.classList.remove('visible');
  invalidateConnectionStatus();
  updateOpenInstanceBtn();
});

openInstanceBtn.addEventListener('click', () => {
  const url = getOpenableInstanceUrl();
  if (!url) return;

  platform.openTab(url);
});

jiraEmailInput.addEventListener('input', () => {
  jiraEmailInput.classList.remove('is-invalid');
  emailError.classList.remove('visible');
  invalidateConnectionStatus();
});

jiraTokenInput.addEventListener('input', () => {
  jiraTokenInput.classList.remove('is-invalid');
  tokenError.classList.remove('visible');
  invalidateConnectionStatus();
});

testConnectionBtn.addEventListener('click', onTestConnection);
form.addEventListener('submit', onSaveSettings);

// The toast's close button (rebuilt with each toast, so the listener is on the toast itself)
appToast.addEventListener('click', (event) => {
  if (event.target.closest('.app-toast-close')) hideToast();
});

// ============================================================================
// Keyboard Shortcuts
// ============================================================================

/**
 * Opens the keyboard shortcuts drawer, listing the shortcuts available where the user is.
 * An open worklog panel slides out of the way without closing, so nothing typed in it is
 * lost, and comes back when the drawer closes.
 */
function openShortcuts() {
  closeSettings();
  const returnFocus = document.activeElement;
  const available = shortcuts.list();
  const coversEditor = coverWorklogEditor();

  shortcutsHelpBtn.setAttribute('aria-expanded', 'true');
  shortcutsDrawer = openShortcutsDrawer(shortcutsDrawerRoot, {
    shortcuts: available,
    onClose: () => {
      shortcutsDrawer = null;
      shortcutsHelpBtn.setAttribute('aria-expanded', 'false');
      uncoverWorklogEditor(coversEditor);
      // Back to where the user was, if it's still there.
      if (returnFocus?.isConnected && returnFocus !== document.body) returnFocus.focus();
    }
  });
}

/** Opens the shortcuts drawer, or closes it when it's open: the ? key and the header's help button. */
function toggleShortcuts() {
  if (shortcutsDrawer) shortcutsDrawer.close();
  else openShortcuts();
}

shortcuts.register({
  id: 'shortcuts.toggle',
  key: '?',
  keys: [['?']],
  description: 'Show keyboard shortcuts',
  category: 'General',
  when: () => !isDeleteDialogOpen,
  handler: toggleShortcuts
});

shortcutsHelpBtn.addEventListener('click', toggleShortcuts);

// Esc closes the open panel wherever focus is: after clicking a worklog, focus is on the page, so
// the panels' own Escape listeners (which handle Esc while typing in their fields) never see it.
shortcuts.register({
  id: 'shortcuts.close',
  key: 'Escape',
  keys: [['Esc']],
  description: 'Close panel',
  category: 'General',
  when: () => !isDeleteDialogOpen,
  handler: closeOpenPanel
});

// ⌘ , on macOS, Ctrl , elsewhere: opens the Connection Settings drawer, like the cog. Already open,
// it stays as it is (nothing typed is lost); the cog's second click is what closes it.
shortcuts.register({
  id: 'settings.open',
  key: ',',
  mod: true,
  description: 'Open connection settings',
  category: 'General',
  when: () => !isDeleteDialogOpen,
  handler: openSettings
});

// Days, weeks, and sync: Ctrl + ← / → (previous or next day), Ctrl + Shift + ← / → (previous or next
// week), Ctrl + Shift + ↑ (today), and Ctrl + Shift + ↓ (sync) on Windows and Linux; ⌘ instead
// of Ctrl on macOS. Each does what its control does, through the control itself (disabled while
// worklogs load, so repeated presses don't stack requests). Not while a drawer or dialog covers the
// page, and not while typing in a field (where these keys move the caret or select text). On Windows
// and Linux no browser binds them (Back and Forward are Alt + ← / →). On macOS, ⌘ + ← / → are Back
// and Forward in Chrome, Edge, and Firefox: on this page the day shortcuts take those over.
const weekNavigationAvailable = () => !isDeleteDialogOpen && !shortcutsDrawer && !settingsDrawerState;

// Previous or next day selects that weekday card by clicking it (so the selection, the day's
// worklogs, and the totals update as on a click). Past Monday or Sunday, the previous or next week
// loads with its Sunday or Monday selected, through the week arrow buttons. Nothing happens while a
// week is loading.
/**
 * Selects the day before (-1) or after (+1) the selected one, crossing into the adjacent week.
 * @param {-1 | 1} step
 */
function selectAdjacentDay(step) {
  const days = currentAggregatedData?.weekDays;
  if (!days?.length || isBusyFetching) return;
  const index = Math.max(0, days.findIndex((day) => day.dateKey === selectedDateKey));
  const target = days[index + step];
  if (target) {
    daysContainer.querySelector(`.day-card[data-date-key="${target.dateKey}"]`)?.click();
    return;
  }
  const edge = new Date((step < 0 ? days[0] : days[days.length - 1]).date);
  edge.setDate(edge.getDate() + step);
  selectedDateKey = getLocalDateKey(edge);
  (step < 0 ? prevWeekBtn : nextWeekBtn).click();
}
shortcuts.register({
  id: 'day.previous',
  key: 'ArrowLeft',
  mod: true,
  description: 'Previous Day',
  category: 'Day Navigation',
  when: weekNavigationAvailable,
  handler: () => selectAdjacentDay(-1)
});
shortcuts.register({
  id: 'day.next',
  key: 'ArrowRight',
  mod: true,
  description: 'Next Day',
  category: 'Day Navigation',
  when: weekNavigationAvailable,
  handler: () => selectAdjacentDay(1)
});
shortcuts.register({
  id: 'week.previous',
  key: 'ArrowLeft',
  mod: true,
  shift: true,
  description: 'Previous Week',
  category: 'Week Navigation',
  when: weekNavigationAvailable,
  handler: () => prevWeekBtn.click()
});
shortcuts.register({
  id: 'week.next',
  key: 'ArrowRight',
  mod: true,
  shift: true,
  description: 'Next Week',
  category: 'Week Navigation',
  when: weekNavigationAvailable,
  handler: () => nextWeekBtn.click()
});
shortcuts.register({
  id: 'week.this-week',
  key: 'ArrowUp',
  mod: true,
  shift: true,
  description: 'Go to Today',
  category: 'Week Navigation',
  when: weekNavigationAvailable,
  handler: () => thisWeekBtn.click()
});
// `+` does what the + beside the selected day's total does. Only with no panel, drawer, or
// dialog open; the button is missing until the week has loaded.
shortcuts.register({
  id: 'worklogs.log-work',
  key: '+',
  keys: [['+']],
  description: 'Log work',
  category: 'Worklogs',
  when: () => !settingsDrawerState && !worklogEditor && !isDeleteDialogOpen && !shortcutsDrawer &&
    Boolean(daysContainer.querySelector('.day-add-btn')),
  handler: () => daysContainer.querySelector('.day-add-btn').click()
});

// Sync Worklogs: not while a worklog is being edited or logged.
shortcuts.register({
  id: 'worklogs.sync',
  key: 'ArrowDown',
  mod: true,
  shift: true,
  description: 'Sync Worklogs',
  category: 'Worklogs',
  when: () => !worklogEditor && !isDeleteDialogOpen && !shortcutsDrawer && !settingsDrawerState,
  handler: () => refreshWorklogsBtn.click()
});

for (const shortcut of WORKLOG_FORM_SHORTCUTS) {
  shortcuts.register({ ...shortcut, when: () => Boolean(worklogEditor) });
}
for (const shortcut of ISSUE_PICKER_SHORTCUTS) {
  shortcuts.register({ ...shortcut, when: () => Boolean(worklogEditorRoot.querySelector('#worklogIssueSearch')) });
}

shortcuts.listen(document);

// The toolbar icon and its Settings menu item bring this page forward instead of opening another
// one (src/background/launch.js): answer with this tab, opening Connection Settings when asked.
if (isExtensionContext() && ext.runtime?.onMessage) {
  ext.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.action !== SHOW_TIMESHEET) return false;
    if (message.settings && !isDeleteDialogOpen) openSettings();
    Promise.resolve(ext.tabs?.getCurrent?.()).then(
      (tab) => sendResponse(tab ? { tabId: tab.id, windowId: tab.windowId } : {}),
      () => sendResponse({})
    );
    return true;
  });
}

// Warn before leaving the page with unsaved worklog edits
window.addEventListener('beforeunload', (event) => {
  if (worklogEditor?.isDirty) {
    event.preventDefault();
    event.returnValue = '';
  }
});

// Initialize on page load
document.addEventListener('DOMContentLoaded', loadSavedSettings);
