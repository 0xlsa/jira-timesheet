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
import {
  createSettingsStore, normalizeSettings, isConfigured, assignmentFieldsForSite, customViewsForSite, customViewOrderForSite,
  workingIssuesGroupOrderForSite, WORKING_ISSUES_GROUP_IDS
} from './src/settings/settingsStore.js';
import { createSettingsDraft, switchDraftEdition } from './src/settings/settingsDraft.js';
import { createPlatform, ext, isExtensionContext } from './src/compat/browser-api.js';
import { SHOW_TIMESHEET, SETTINGS_HASH } from './src/background/launch.js';
import { h, svg } from './src/ui/dom.js';
import { renderConnectionStatus, STATUS_CLASSES } from './src/ui/connectionStatus.js';
import { renderWeek, renderWorkingIssues, updateWorkingIssuesTimer, updateHolidays, orderWorkingIssuesGroups, VIEW_TAB_SHORTCUTS, GROUP_SHORTCUTS } from './src/ui/weekView.js';
import { openWorklogEditor, WORKLOG_FORM_SHORTCUTS } from './src/ui/worklogEditor.js';
import { ISSUE_PICKER_SHORTCUTS } from './src/ui/issuePicker.js';
import { createShortcutRegistry } from './src/ui/shortcuts.js';
import { openShortcutsDrawer } from './src/ui/shortcutsDrawer.js';
import { showPanel, hidePanel } from './src/ui/panel.js';
import { openDeleteWorklogDialog, describeWorklogForDeletion } from './src/ui/deleteWorklogDialog.js';
import { DISCARD_PENDING_WORDING, formatPendingDuration, siteBaseUrl } from './src/ui/pendingWorklogs.js';
import { createTokenVisibilityToggle } from './src/ui/tokenVisibility.js';
import { toNewWorklogForm } from './src/worklog/worklogEdit.js';
import { createWorkingIssuesLoader } from './src/worklog/workingIssuesLoader.js';
import { createTimeTrackingStore, createTimeTrackingLock, siteId, isSameIssue, submissionStatus, classificationOf } from './src/timer/timeTrackingStore.js';
import { createPendingSelection, classifyPendingWorklogs, rowActions, settleBulkSelection } from './src/worklog/pendingClassification.js';
import { createPendingActionsMenu } from './src/ui/pendingActionsMenu.js';
import { submitPendingWorklog } from './src/worklog/pendingSubmission.js';
import { createTimerController } from './src/timer/timerController.js';
import { loadAboutInfo, renderAboutSection, renderSettingsVersion } from './src/ui/aboutSection.js';
import { createNagerDateClient } from './src/holidays/nagerDateClient.js';
import { createHolidayCache } from './src/holidays/holidayCache.js';
import { createPublicHolidays } from './src/holidays/publicHolidays.js';
import { createPublicHolidaysSettings } from './src/ui/publicHolidaysSettings.js';
import { createAssignmentFieldsSettings } from './src/ui/assignmentFieldsSettings.js';
import { createConnectionSection, shouldCollapseConnection } from './src/ui/connectionSection.js';
import { createWeekPicker } from './src/ui/weekPicker.js';
import { dateFromKey, renderNextHolidayBanner } from './src/ui/nextHolidayBanner.js';
import {
  loadChangelog,
  createChangelogStateStore,
  announcementFor,
  hasUnreadRelease,
  releaseHighlights,
  LAST_ANNOUNCED_KEY,
  LAST_READ_KEY
} from './src/changelog/changelogState.js';
import { openChangelogDrawer } from './src/ui/changelogDrawer.js';
import { showUpdateAnnouncement, hideUpdateAnnouncement } from './src/ui/updateAnnouncement.js';
import {
  ALL_VIEW_ID,
  MAX_CUSTOM_VIEWS,
  ME_VALUE,
  SYSTEM_FIELDS,
  buildCustomViewJql,
  describeView,
  orderViews,
  reorderViewIds,
  isViewAvailable,
  usesCustomField,
  viewUserFieldIds,
  validateViewDraft,
  conditionKind
} from './src/jira/customViews.js';
import { createCustomViewSearch } from './src/jira/customViewSearch.js';
import { openCustomViewEditor } from './src/ui/customViewEditor.js';

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
const weekPickerBtn = document.getElementById('weekPickerBtn');
const nextHolidayBanner = document.getElementById('nextHolidayBanner');
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
const changelogBtn = document.getElementById('changelogBtn');
const changelogNewBadge = document.getElementById('changelogNewBadge');
const changelogDrawerRoot = document.getElementById('changelogDrawer');
const customViewEditorRoot = document.getElementById('customViewEditor');
const updateAnnouncementRoot = document.getElementById('updateAnnouncement');
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
const connectionSectionEl = document.getElementById('connectionSection');
const connectionToggle = document.getElementById('connectionToggle');
const connectionBody = document.getElementById('connectionBody');
const connectionTitle = document.getElementById('connectionTitle');
const connectionSetupHint = document.getElementById('connectionSetupHint');

// Public Holidays section of the Connection Settings form
const publicHolidaysToggle = document.getElementById('publicHolidaysEnabled');
const publicHolidaysCountry = document.getElementById('publicHolidaysCountry');
const publicHolidaysStatus = document.getElementById('publicHolidaysStatus');
const publicHolidaysError = document.getElementById('publicHolidaysError');
const publicHolidaysShowNext = document.getElementById('publicHolidaysShowNext');

// Additional Assignment Fields section of the Settings form
const assignmentFieldsList = document.getElementById('assignmentFieldsList');
const assignmentFieldsAddBtn = document.getElementById('assignmentFieldsAddBtn');
const assignmentFieldsMenu = document.getElementById('assignmentFieldsMenu');
const assignmentFieldsStatus = document.getElementById('assignmentFieldsStatus');

// ============================================================================
// State
// ============================================================================

let currentMonday = getMondayOfWeek(new Date());
let selectedDateKey = getLocalDateKey(new Date());
// Whether the selected day's panel shows its worklogs: one state for every day, remembered across
// sessions as My Work's is; collapsed until the user expands it or selects a day.
let isDayPanelExpanded = localStorage.getItem('jts-day-panel-expanded') === 'true';

/** Selecting a day, here or in another week, shows its worklogs; its header still collapses them. */
function expandDayPanel() {
  isDayPanelExpanded = true;
  localStorage.setItem('jts-day-panel-expanded', 'true');
}

// The date range opens a calendar; the chosen day's week is shown with that day selected, through
// the same state as the buttons around it.
const weekPicker = createWeekPicker({
  trigger: weekPickerBtn,
  container: document.body,
  getSelection: () => ({ monday: currentMonday, selectedDateKey }),
  onSelect: (date) => {
    currentMonday = getMondayOfWeek(date);
    selectedDateKey = getLocalDateKey(date);
    expandDayPanel();
    loadAndRenderWorklogs();
  }
});

// A pending worklog's ⋯ menu (Mark as Pending or Put On Hold): one for every row, which stays
// open while My Work is drawn again, on the row's new ⋯ button.
const pendingActionsMenu = createPendingActionsMenu({
  container: document.body,
  findButton: (id) => daysContainer.querySelector(`.pending-menu-btn[data-pending-id="${CSS.escape(id)}"]`)
});

let currentAggregatedData = null;
let isBusyFetching = false;

// Jira client and instance URL of the displayed week; set when worklogs load.
let currentClient = null;
let currentBaseUrl = '';

// My Work section (see src/ui/weekView.js): what it shows (null hides it, when there is no
// Jira to ask) and whether it's expanded: collapsed until the user expands it, then as they last
// left it. The loader (src/worklog/workingIssuesLoader.js) is created with the section's renderer below.
let workingIssuesState = null;
let isWorkingIssuesExpanded = localStorage.getItem('jts-working-issues-expanded') === 'true';
// Its Issues and Pending Worklogs groups, each expanded until the user collapses it, then as
// they last left it, independently of each other.
const workingIssuesGroupsExpanded = {
  active: localStorage.getItem('jts-working-issues-active-expanded') !== 'false',
  pending: localStorage.getItem('jts-working-issues-pending-expanded') !== 'false'
};
// The Worklogs group's classification tab (Pending or On Hold; remembered in this browser),
// selection mode, and the selected worklogs, which always belong to the selected tab (see
// src/worklog/pendingClassification.js). The selection itself is never saved.
const pendingSelection = createPendingSelection(localStorage.getItem('jts-pending-classification'));
// True while a classification change is being saved: another one waits until it's done.
let isClassifyingPending = false;
// After a bulk change that didn't move every selected worklog: the ones left, each with why (their
// rows are flagged), and what happened (in the selection bar). Null otherwise; cleared by the next
// change of selection mode, tab, or selection.
let pendingNotMoved = null;

// Open Edit Worklog panel (see src/ui/worklogEditor.js), or null.
let worklogEditor = null;
// True while the delete worklog confirmation is open.
let isDeleteDialogOpen = false;
// Open keyboard shortcuts drawer (see src/ui/shortcutsDrawer.js), or null.
let shortcutsDrawer = null;
// Open What's New drawer (see src/ui/changelogDrawer.js), or null.
let changelogDrawer = null;
// Open custom view editor (see src/ui/customViewEditor.js), or null.
let customViewEditor = null;
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

// The Jira Connection section of the form (URL, email, token): collapsible, collapsed when it
// opens with everything saved, and headed by a setup prompt until then.
const connectionSection = createConnectionSection({
  section: connectionSectionEl,
  toggle: connectionToggle,
  body: connectionBody,
  title: connectionTitle,
  setupHint: connectionSetupHint
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

// Public holidays (src/holidays/): Nager.Date data cached in storage, the indicators shown on the
// weekday cards, and the settings section. Display only: nothing here touches worklogs.
const holidayCache = createHolidayCache(platform.storage, { api: createNagerDateClient() });
const publicHolidays = createPublicHolidays({
  cache: holidayCache,
  // Data that arrives after the week was rendered is added to its weekday cards in place, and the
  // Next Public Holiday banner follows it (and any change of settings).
  onChange: () => {
    if (currentAggregatedData) updateHolidays(daysContainer, currentAggregatedData, holidaysForWeek(currentAggregatedData));
    showNextHoliday();
  }
});
const publicHolidaysSettings = createPublicHolidaysSettings({
  toggle: publicHolidaysToggle,
  select: publicHolidaysCountry,
  status: publicHolidaysStatus,
  error: publicHolidaysError,
  showNext: publicHolidaysShowNext
}, holidayCache, {
  // The section applies at once, without Save Settings: saved on its own, then the weekday cards'
  // holidays and the banner follow (configure() loads what's needed and calls their onChange).
  async onChange(values) {
    try {
      await settingsStore.savePublicHolidays(values);
      savedSettings = await settingsStore.load();
    } catch (err) {
      console.warn('Could not save the Public Holidays settings:', err);
      return;
    }
    publicHolidays.configure(savedSettings.publicHolidays);
  },
  async onShowNextChange(showNext) {
    try {
      await settingsStore.saveShowNextHoliday(showNext);
      savedSettings = await settingsStore.load();
    } catch (err) {
      console.warn('Could not save the Show Next Public Holiday setting:', err);
      return;
    }
    showNextHoliday();
  }
});

/**
 * Shows the next public holiday from today in the banner under the week navigation, when the
 * feature is on with its banner switch; otherwise hides it. Doesn't depend on the week displayed.
 */
function showNextHoliday() {
  const todayKey = getLocalDateKey(new Date());
  const holiday = savedSettings?.publicHolidays.showNext ? publicHolidays.nextHoliday(todayKey) : null;
  renderNextHolidayBanner(nextHolidayBanner, holiday, todayKey);
}

// Additional Assignment Fields (src/jira/assignmentFields.js): Jira user fields that also count as
// assigning an issue to the user in My Work, per Jira site. Saved as they change.
const assignmentFieldsSettings = createAssignmentFieldsSettings({
  list: assignmentFieldsList,
  addButton: assignmentFieldsAddBtn,
  menu: assignmentFieldsMenu,
  status: assignmentFieldsStatus
}, {
  async onChange(site, fields) {
    await settingsStore.saveAssignmentFields(site, fields);
    savedSettings = await settingsStore.load();
    refreshActiveIssues();
  }
});

// Flips of Show Recently Logged Issues so far: an older flip's save doesn't load the issues again.
let recentlyLoggedFlips = 0;

/**
 * Show Recently Logged Issues (the switch below Active's tab, in Issues): saved as it changes, then
 * Active loads again with or without the issues only logged recently, keeping the issues shown
 * until the new ones are in. Flipped again before that, only the last flip loads (and the loader
 * cancels a load a newer one replaces).
 * @param {boolean} show
 */
async function setShowRecentlyLoggedIssues(show) {
  const flip = ++recentlyLoggedFlips;
  try {
    await settingsStore.saveShowRecentlyLoggedIssues(show);
    savedSettings = await settingsStore.load();
  } catch (err) {
    console.warn('Could not save the Show Recently Logged Issues setting:', err);
    return;
  }
  if (flip !== recentlyLoggedFlips) return;
  refreshActiveIssues({ keepShown: true });
}

/** The Additional Assignment Fields of a client's Jira site, from the saved settings. */
function assignmentFieldsFor(client, settings = savedSettings) {
  return client ? assignmentFieldsForSite(settings, siteId(client.deploymentType, client.baseUrl)) : [];
}

/**
 * Shows the saved connection's Additional Assignment Fields in Settings, with its Jira site's
 * fields to choose from (loaded when the menu first opens). Without a saved connection, none.
 */
function showAssignmentFieldsSettings() {
  const { client } = isConfigured(savedSettings ?? {}) ? createJiraClient({
    baseUrl: savedSettings.jiraBaseUrl,
    deploymentType: savedSettings.deploymentType,
    email: savedSettings.email,
    token: savedSettings.token
  }) : { client: null };
  assignmentFieldsSettings.show(client && {
    site: siteId(client.deploymentType, client.baseUrl),
    fields: assignmentFieldsFor(client),
    loadFields: () => client.getUserPickerFields()
  });
}

/**
 * The public holidays to show on a week's cards; loads the week's years when needed.
 * @param {{ weekDays?: Array<{ dateKey: string }> }} week
 */
function holidaysForWeek(week) {
  return publicHolidays.indicatorsFor((week.weekDays || []).map((day) => day.dateKey));
}

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
 * shortcuts, What's New, or Connection Settings drawer, else the worklog panel (which asks first when
 * there are unsaved changes).
 * @returns {boolean} False when nothing is open, so Escape keeps its default
 */
function closeOpenPanel() {
  if (shortcutsDrawer) shortcutsDrawer.close();
  else if (changelogDrawer) changelogDrawer.close();
  else if (customViewEditor) customViewEditor.close();
  else if (settingsDrawerState) closeSettings();
  else if (worklogEditor) worklogEditor.requestClose();
  else return false;
  return true;
}

/**
 * Closes the drawers (keyboard shortcuts, What's New, and Connection Settings) before a worklog
 * panel or dialog opens.
 */
function closeDrawers() {
  shortcutsDrawer?.close();
  changelogDrawer?.close();
  customViewEditor?.close();
  closeSettings();
}

/**
 * Opens the Connection Settings drawer, with the form showing the saved settings (anything
 * changed but not saved on an earlier visit is discarded). The keyboard shortcuts and What's New
 * drawers close, since only one drawer is open at a time.
 */
function openSettings() {
  if (settingsDrawerState) return;
  // Unsaved changes from an earlier visit are discarded: the form shows the saved settings.
  if (savedSettings) fillSettingsForm(savedSettings);
  showAssignmentFieldsSettings();
  // Connection details already saved: collapsed, out of the way. Missing: expanded, to fill in,
  // under the setup prompt.
  const isConnectionCollapsed = shouldCollapseConnection(savedSettings);
  connectionSection.setConfigured(isConnectionCollapsed);
  connectionSection.setExpanded(!isConnectionCollapsed);
  shortcutsDrawer?.close();
  changelogDrawer?.close();
  customViewEditor?.close();
  settingsDrawerState = { returnFocus: document.activeElement, coversEditor: coverWorklogEditor() };
  showPanel(settingsDrawerRoot);
  settingsBtn.setAttribute('aria-expanded', 'true');
  (isConnectionCollapsed ? connectionToggle : jiraBaseUrlInput).focus();
}

/** Closes the Connection Settings drawer. Unsaved changes are discarded when it next opens. */
function closeSettings() {
  if (!settingsDrawerState) return;
  const { returnFocus, coversEditor } = settingsDrawerState;
  settingsDrawerState = null;
  // A revealed token never outlives a visit to Settings, and neither does a test result.
  tokenVisibility.mask();
  hideConnectionStatus();
  assignmentFieldsSettings.close();
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
      expandDayPanel();
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
    workingIssues: workingIssuesOptions(),
    holidays: holidaysForWeek(aggregatedData),
    dayExpanded: isDayPanelExpanded,
    onToggleDay: (expanded) => {
      isDayPanelExpanded = expanded;
      localStorage.setItem('jts-day-panel-expanded', String(expanded));
    }
  });
  pendingActionsMenu.sync();
}

// ============================================================================
// My Work
// ============================================================================

/**
 * Options for the My Work section, or undefined to leave it out.
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
      // The selected custom view is searched once it shows.
      if (expanded && workingIssuesGroupsExpanded.active) setWorkingIssuesState(workingIssuesState);
    },
    onRetry: () => refreshActiveIssues(),
    // Like the worklog cards' + buttons: once the week has loaded.
    onLogWork: currentAggregatedData?.sourceWorklogs ? startLogWorkOnIssue : undefined,
    timer: timerOptions(),
    pending: pendingOptions(),
    groupsExpanded: workingIssuesGroupsExpanded,
    onGroupToggle: (group, expanded) => {
      workingIssuesGroupsExpanded[group] = expanded;
      localStorage.setItem(`jts-working-issues-${group}-expanded`, String(expanded));
      if (group === 'active' && expanded) setWorkingIssuesState(workingIssuesState);
    },
    // Their order, per Jira site (apart from whether each is expanded); movable once a site is connected.
    groupOrder: workingIssuesGroupOrder(),
    onGroupMove: currentClient ? (order) => moveWorkingIssuesGroups(currentClient, order) : undefined,
    recentlyLogged: { checked: savedSettings?.showRecentlyLoggedIssues === true, onChange: setShowRecentlyLoggedIssues },
    views: customViewsOptions()
  };
}

/**
 * The connected Jira site's My Work group order (Issues, then Pending Worklogs, unless moved).
 * @returns {string[]}
 */
function workingIssuesGroupOrder() {
  if (!currentClient) return [...WORKING_ISSUES_GROUP_IDS];
  return workingIssuesGroupOrderForSite(savedSettings, siteId(currentClient.deploymentType, currentClient.baseUrl));
}

/**
 * Saves the My Work groups' new order for a client's Jira site, which other tabs follow. The section
 * has already moved them in place, so nothing is drawn again, and nothing is loaded. If it can't be
 * saved, the order goes back to what's stored, and a toast says why.
 * @param {object} client
 * @param {string[]} order - Every group ID, in their new order
 */
function moveWorkingIssuesGroups(client, order) {
  const site = siteId(client.deploymentType, client.baseUrl);
  savedSettings = { ...savedSettings, workingIssuesGroupOrderBySite: { ...savedSettings?.workingIssuesGroupOrderBySite, [site]: order } };
  settingsStore.saveWorkingIssuesGroupOrder(site, order).catch(async (err) => {
    console.warn('Could not save the order of the My Work groups:', err);
    showToast(err.message || "Couldn't save the order of the groups.", { durationMs: 8000 });
    try {
      savedSettings = await settingsStore.load();
    } catch {
      // Keep what's shown.
    }
    showWorkingIssuesGroupOrder();
  });
}

/** Puts the My Work groups on the page in the saved order, in place (nothing is drawn again). */
function showWorkingIssuesGroupOrder() {
  const section = daysContainer.querySelector('#workingIssues');
  if (section) orderWorkingIssuesGroups(section, workingIssuesGroupOrder());
}

// The My Work groups moved in another tab or window: put them in the same order here.
platform.watchStorage((changes) => {
  if (!('workingIssuesGroupOrderBySite' in changes)) return;
  settingsStore.load().then((settings) => {
    savedSettings = settings;
    showWorkingIssuesGroupOrder();
  }, (err) => console.warn('Could not read the order of the My Work groups:', err));
});

/**
 * Shows a new My Work state, updating the section in place when it's on the page.
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
  // The ⋯ menu follows its row's new button, or closes once the row is gone.
  pendingActionsMenu.sync();
}

// ============================================================================
// Timer
// ============================================================================

// The timer's state comes from storage (src/timer/timeTrackingStore.js), shared by every open
// Timesheet for Jira tab; this page only shows it and asks the store for changes.
const timer = createTimerController({
  createStore: () => createTimeTrackingStore(platform.storage, { lock: createTimeTrackingLock() }),
  watchStorage: (listener) => platform.watchStorage(listener),
  // Start, Stop, the header indicator, and the Log work panel's timer button follow the new state;
  // another tab's change arrives here too.
  onChange: () => {
    setWorkingIssuesState(workingIssuesState);
    worklogEditor?.refreshTimer();
  },
  // Only the elapsed times change each second, in place.
  onTick: () => {
    const section = daysContainer.querySelector('#workingIssues');
    if (section) updateWorkingIssuesTimer(section, Date.now());
  },
  onError: (message) => showToast(message, { durationMs: 8000 })
});

/**
 * Timer options for My Work, or undefined (no timer controls) before the timer has loaded
 * or while no Jira site is connected.
 * @returns {object | undefined}
 */
function timerOptions() {
  const state = timer.getState();
  if (state.status === 'loading' || !currentClient) return undefined;

  const site = siteId(currentClient.deploymentType, currentClient.baseUrl);
  return {
    site,
    running: state.tracking?.running ?? null,
    now: Date.now(),
    busy: state.busy,
    unavailable: state.status === 'unavailable' ? state.message : '',
    onStart: (issue) => timer.start(timedIssue(issue)),
    onStop: () => timer.stop(),
    onPause: () => timer.pause(),
    onResume: () => timer.resume()
  };
}

/**
 * The timer's issue for a Jira issue on the connected site: the same site ID and identifiers
 * wherever a timer starts (an Issues row or the Log work panel).
 * @param {{ issueId?: string, issueKey: string, issueSummary?: string }} issue
 */
function timedIssue(issue) {
  return {
    site: siteId(currentClient.deploymentType, currentClient.baseUrl),
    issueId: issue.issueId,
    issueKey: issue.issueKey,
    issueSummary: issue.issueSummary
  };
}

/**
 * Pending worklog options for My Work (which then shows its Issues and Pending Worklogs groups),
 * or undefined while the timer's state isn't known.
 * @returns {object | undefined}
 */
function pendingOptions() {
  const state = timer.getState();
  if (!state.tracking || !currentClient) return undefined;
  const entries = state.tracking.pending;
  // Worklogs that left the selected tab (moved, submitted, or discarded, here or in another tab)
  // leave the selection too.
  pendingSelection.reconcile(entries);
  return {
    entries,
    site: siteId(currentClient.deploymentType, currentClient.baseUrl),
    now: Date.now(),
    onEdit: startEditPending,
    onDiscard: confirmDiscardPending,
    onSubmit: submitPending,
    tab: pendingSelection.tab,
    onSelectTab: selectPendingTab,
    onMenu: togglePendingActions,
    selection: {
      active: pendingSelection.selecting,
      ids: pendingSelection.selectedIds(),
      busy: isClassifyingPending,
      notMoved: pendingNotMoved?.items,
      notice: pendingNotMoved?.notice,
      onToggleMode: () => {
        pendingNotMoved = null;
        pendingSelection.setSelecting(!pendingSelection.selecting);
        showPendingWorklogs();
      },
      onToggle: (id) => {
        if (!pendingSelection.toggle(id, pendingEntries())) return;
        pendingNotMoved = null;
        showPendingWorklogs();
      },
      onSelectAll: () => {
        pendingNotMoved = null;
        // Every worklog in the tab, as stored: not only the rows on screen.
        pendingSelection.selectAll(pendingEntries());
        showPendingWorklogs();
      },
      onDeselectAll: () => {
        pendingNotMoved = null;
        pendingSelection.deselectAll();
        showPendingWorklogs();
      },
      onClassify: (classification) => classifyPending(pendingSelection.selectedIds(), classification, { bulk: true })
    }
  };
}

/** Every pending worklog, as last read from storage. */
function pendingEntries() {
  return timer.getState().tracking?.pending ?? [];
}

/** Draws My Work again, for a change of tab or selection (nothing is read or written). */
function showPendingWorklogs() {
  setWorkingIssuesState(workingIssuesState);
}

/**
 * Shows another classification tab in Pending Worklogs, remembered in this browser. The selection
 * doesn't carry over; selection mode stays as it was.
 * @param {string} tab
 */
function selectPendingTab(tab) {
  if (!pendingSelection.selectTab(tab)) return;
  pendingNotMoved = null;
  localStorage.setItem('jts-pending-classification', tab);
  pendingActionsMenu.close();
  showPendingWorklogs();
}

/**
 * Opens a pending worklog's ⋯ menu, offering the classifications it isn't under, or closes it when
 * it's open already. Not while it's being submitted.
 * @param {string} id
 */
function togglePendingActions(id) {
  if (pendingActionsMenu.openFor() === id) {
    pendingActionsMenu.close({ restoreFocus: true });
    return;
  }
  const entry = findPendingWorklog(id);
  if (!entry) return;
  if (submissionStatus(entry) === 'submitting') {
    showToast(`${entry.issueKey}'s worklog is being submitted, so it can't be moved now.`, { durationMs: 8000 });
    return;
  }
  pendingActionsMenu.open({
    id,
    label: `Move the pending worklog for ${entry.issueKey}`,
    actions: rowActions(classificationOf(entry)),
    onChoose: (classification) => classifyPending([id], classification)
  });
}

/**
 * Files pending worklogs under Pending or On Hold: from a row's menu, or the selected ones
 * from the bulk bar. Only this browser's metadata changes, in one write; nothing is sent to Jira.
 * Each tab's count and total follow from the stored state, here and in other tabs.
 *
 * The tab shown stays the same: moved worklogs leave it, and it may show its empty state.
 *
 * After a bulk change that moved every worklog, selection mode closes, clearing the selection: no
 * Done needed. Otherwise selection mode stays, the ones that didn't move (being submitted, or
 * nothing saved at all) stay selected, each flagged on its row, and the selection bar and a toast
 * name them: never success for a change that wasn't made.
 * @param {string[]} ids
 * @param {'ready' | 'on-hold'} classification
 * @param {{ bulk?: boolean }} [options]
 */
async function classifyPending(ids, classification, { bulk = false } = {}) {
  if (isClassifyingPending || ids.length === 0) return;
  isClassifyingPending = true;
  if (bulk) pendingNotMoved = null;
  // The bulk actions wait while it's saved.
  if (bulk) showPendingWorklogs();
  let outcome;
  try {
    outcome = await classifyPendingWorklogs({ classify: timer.classifyPending, entries: pendingEntries(), ids, to: classification });
  } finally {
    isClassifyingPending = false;
  }
  if (bulk) pendingNotMoved = settleBulkSelection(pendingSelection, outcome);
  showPendingWorklogs();
  if (outcome.status === 'done') {
    showToast(outcome.message, { success: true, subtitle: 'Only in this browser: nothing was sent to Jira' });
  } else {
    showToast(`${outcome.message}. ${outcome.detail}`, { durationMs: 10000 });
  }
}

/**
 * Submits a pending worklog to Jira (its row's Submit button), through the connected site's client.
 * It leaves Pending only once Jira has the worklog, which then joins the displayed week like work
 * logged by hand. A refusal keeps it as not submitted; no answer keeps it as possibly in Jira, and
 * submitting it again checks Jira before sending anything (src/worklog/pendingSubmission.js).
 * @param {string} id
 */
async function submitPending(id) {
  const entry = findPendingWorklog(id);
  const client = currentClient;
  if (!entry || !client) return;

  let result;
  try {
    result = await submitPendingWorklog({
      timer,
      client,
      id,
      site: siteId(client.deploymentType, client.baseUrl),
      // What the user saw when choosing to submit: a change made meanwhile in another tab is refused.
      expected: { startedAt: entry.startedAt, timeSpentSeconds: entry.timeSpentSeconds, comment: entry.comment },
      author: currentAggregatedData?.user
    });
  } catch (err) {
    // Refused before anything was sent: says why (too short, another site, already being submitted).
    showToast(err.message, { durationMs: 8000 });
    return;
  }

  if (result.status === 'failed' || result.status === 'uncertain') {
    showToast(result.message, { durationMs: 10000 });
    return;
  }

  // In Jira: show it in the displayed week (no reload), as after logging work by hand.
  const startedOn = new Date(result.worklog.started);
  if (currentAggregatedData?.sourceWorklogs && currentAggregatedData.weekDays.some((d) => d.dateKey === getLocalDateKey(startedOn))) {
    showWeek(replaceWorklogInWeek(currentAggregatedData, result.worklog), currentBaseUrl);
  }
  refreshActiveIssues();
  showToast(result.status === 'already-in-jira' ? `${entry.issueKey} was already in Jira` : `Submitted ${entry.issueKey}`, {
    success: true,
    subtitle: result.message || formatWorklogDate(startedOn),
    durationMs: result.message ? 10000 : 5000
  });
}

/**
 * The Log work panel's timer button (beside the issue's key): its state for an issue, and Start and
 * Stop through the timer, as an Issues row's buttons. Neither logs work in Jira.
 * @returns {object}
 */
function logWorkTimerOptions() {
  return {
    stateOf(issue) {
      const state = timer.getState();
      if (!state.tracking || state.status === 'unavailable' || !currentClient) return null;
      return { running: Boolean(state.tracking.running) && isSameIssue(state.tracking.running, timedIssue(issue)) };
    },
    async onStart(issue) {
      if (!currentClient) return false;
      const started = await timer.start(timedIssue(issue));
      if (started) showToast(`Timer started on ${issue.issueKey}`, { success: true, subtitle: 'Stop it in My Work' });
      return started;
    },
    async onStop() {
      const stopped = await timer.stop();
      if (stopped) showToast('Timer stopped', { success: true, subtitle: 'Its time is waiting in Worklog Queue' });
      return stopped;
    }
  };
}

/**
 * The pending worklog with this ID, as last read from storage.
 * @param {string} id
 * @returns {object | undefined}
 */
function findPendingWorklog(id) {
  return timer.getState().tracking?.pending.find((entry) => entry.id === id);
}

/** Focuses a pending worklog's button, or the Pending Worklogs header once the worklog is gone. */
function focusPendingWorklog(id, buttonClass) {
  (daysContainer.querySelector(`.${buttonClass}[data-pending-id="${CSS.escape(id)}"]`) ||
    daysContainer.querySelector('#workingIssuesGroupToggle-pending') || selectedDayFocusTarget())?.focus();
}

/**
 * Opens a pending worklog in the worklog panel, to change its date, start time, duration, or
 * comment in this browser. Nothing is sent to Jira: saving changes only the pending worklog, and
 * only if no other tab changed it meanwhile.
 * @param {string} id
 */
function startEditPending(id) {
  closeDrawers();
  if (worklogEditor && !worklogEditor.requestClose()) return;

  const entry = findPendingWorklog(id);
  if (!entry) return;
  // Not while it's being submitted, nor once Jira may have it: an edit could then add it twice.
  const status = submissionStatus(entry);
  if (status === 'submitting' || status === 'uncertain') {
    showToast(status === 'submitting'
      ? `${entry.issueKey}'s worklog is being submitted, so it can't be edited now.`
      : `Jira may already have ${entry.issueKey}'s worklog, so it can't be edited. Submit it again to check Jira, or discard it.`,
    { durationMs: 8000 });
    return;
  }
  // What the edit starts from: saving is refused if another tab changed these meanwhile.
  const expected = { startedAt: entry.startedAt, timeSpentSeconds: entry.timeSpentSeconds, comment: entry.comment };

  worklogEditor = openWorklogEditor(worklogEditorRoot, {
    mode: 'pending',
    worklog: {
      id: entry.id,
      issueId: entry.issueId,
      issueKey: entry.issueKey,
      issueSummary: entry.issueSummary,
      started: new Date(entry.startedAt).toISOString(),
      timeSpentSeconds: entry.timeSpentSeconds,
      comment: entry.comment
    },
    baseUrl: siteBaseUrl(entry.site),
    onSave: async (changes) => {
      await timer.updatePending(id, {
        startedAt: changes.started?.getTime(),
        timeSpentSeconds: changes.timeSpentSeconds,
        comment: changes.comment
      }, expected);
      showToast(`Saved pending worklog for ${entry.issueKey}`, { success: true, subtitle: 'Kept in this browser until you submit it' });
    },
    onClose: () => {
      worklogEditor = null;
      if (currentAggregatedData) renderDays(currentAggregatedData, currentBaseUrl);
      focusPendingWorklog(id, 'pending-edit-btn');
    }
  });

  if (currentAggregatedData) renderDays(currentAggregatedData, currentBaseUrl);
}

/**
 * Asks to confirm discarding a pending worklog (its trash button), naming its issue and duration.
 * Discarding removes only that pending worklog, from this browser; nothing is deleted in Jira.
 * @param {string} id
 */
function confirmDiscardPending(id) {
  closeDrawers();
  if (isDeleteDialogOpen) return;
  if (worklogEditor && !worklogEditor.requestClose()) return;

  const entry = findPendingWorklog(id);
  if (!entry) return;

  isDeleteDialogOpen = true;
  openDeleteWorklogDialog(deleteWorklogDialog, {
    details: {
      ...describeWorklogForDeletion({ ...entry, started: new Date(entry.startedAt) }),
      duration: formatPendingDuration(entry.timeSpentSeconds)
    },
    wording: DISCARD_PENDING_WORDING,
    onDelete: async () => {
      await timer.discardPending(id);
      showToast('Pending worklog discarded.');
    },
    onClose: () => {
      isDeleteDialogOpen = false;
      focusPendingWorklog(id, 'pending-discard-btn');
    }
  });
}

// Loads the My Work section's contents on its own: the worklogs load and show whatever
// happens there. Asked with every week load, but it doesn't depend on the week, so it only loads
// again on Sync, a change of settings, or a worklog change; a newer load cancels an older one.
// A load that kept the issues shown and failed leaves them, and says why in a toast.
const workingIssues = createWorkingIssuesLoader((state) => {
  if (state?.refreshError) {
    showToast(`Couldn't update your issues, so the ones shown are from before. ${state.refreshError}`, { durationMs: 8000 });
    const { refreshError, ...shown } = state;
    state = shown;
  }
  setWorkingIssuesState(state);
});

/**
 * Reloads the Active view's issues: Retry, a change of Issue Selection settings, and after a worklog
 * is logged, edited, or deleted, which can add a recently logged issue or remove one. With
 * `keepShown` (Show Recently Logged Issues), the issues shown stay until Jira's new ones replace them.
 * @param {{ keepShown?: boolean }} [options]
 */
function refreshActiveIssues({ keepShown = false } = {}) {
  if (!currentClient) return;
  workingIssues.refresh(currentClient, {
    force: true,
    assignmentFields: assignmentFieldsFor(currentClient),
    includeRecentlyLogged: savedSettings?.showRecentlyLoggedIssues === true,
    keepShown
  });
}

// ============================================================================
// Custom Views of My Work
// ============================================================================

// Custom views (src/jira/customViews.js) are tabs beside Active in Issues, and Jira searches of
// their own: each runs its JQL (buildCustomViewJql()) through JiraClient.searchCustomViewIssues(),
// apart from Active's search (workingIssues, above), which they never change. Their results are kept
// for this page only (src/jira/customViewSearch.js) and searched when a view shows: My Work and My
// Issues expanded, with the view selected. Sync searches again, as does Retry after a failure.

// The view shown in Issues: Active, or a custom view's ID, remembered across sessions. One that
// no longer exists shows Active.
let selectedViewId = localStorage.getItem('jts-working-issues-view') || ALL_VIEW_ID;
// The site's custom fields views can use (GET /field): its single-select fields and its single-user
// fields, loaded once per page and Jira site when a view filters on a custom field, or the editor
// opens: { site, optionIds, userIds, request }, the IDs null until loaded.
let customFieldCatalog = null;

// The views' results; each answer draws My Work again.
const viewSearch = createCustomViewSearch(() => {
  if (workingIssuesState) setWorkingIssuesState(workingIssuesState);
});
// Each custom view's results key when last drawn, by view ID: after an edit changes its JQL (its
// conditions or order), its new search starts from the results it showed, which stay until Jira answers.
const viewSearchKeys = new Map();

// What was last said about the view tabs to assistive technology ("Moved Reported to position 2 of 4.").
let viewTabsAnnouncement = '';

/**
 * A Jira site's custom views, from the saved settings.
 * @returns {{ views: Array<object>, unsupported?: true }}
 */
function customViewsFor(client, settings = savedSettings) {
  return client ? customViewsForSite(settings, siteId(client.deploymentType, client.baseUrl)) : { views: [] };
}

/**
 * The site's custom fields for the editor, asked for once per page and site: its single-user fields
 * (compared with Me; the Additional Assignment Fields are offered already) and its single-select
 * fields. A failure is asked again the next time they're needed.
 * @returns {Promise<Array<{ id: string, name: string, kind: 'user' | 'option', group: string }>>}
 */
function loadCustomFields(client) {
  const site = siteId(client.deploymentType, client.baseUrl);
  if (customFieldCatalog?.site !== site) {
    const catalog = { site, optionIds: null, userIds: null, request: null };
    catalog.request = client.getCustomViewFields().then(({ singleSelect, userPickers }) => {
      catalog.optionIds = new Set(singleSelect.map((field) => field.id));
      catalog.userIds = new Set(userPickers.map((field) => field.id));
      // A view whose field is gone says so now.
      if (customFieldCatalog === catalog && workingIssuesState) setWorkingIssuesState(workingIssuesState);
      // Jira allows two fields with one name (two "QA Lead" fields): their ID tells them apart.
      const named = (fields) => fields.map((field) => (fields.filter((other) => other.name === field.name).length > 1
        ? { ...field, name: `${field.name} (${field.id})` } : field));
      return [
        ...named(userPickers).map((field) => ({ id: field.id, name: field.name, kind: 'user', group: 'User fields' })),
        ...named(singleSelect).map((field) => ({ ...field, group: 'Custom fields' }))
      ];
    }, (err) => {
      if (customFieldCatalog === catalog) customFieldCatalog = null;
      throw err;
    });
    customFieldCatalog = catalog;
  }
  return customFieldCatalog.request;
}

/** Learns whether the custom fields the site's views filter on are still in Jira. */
function checkViewFields(client, settings = savedSettings) {
  if (!client) return;
  const assignmentFieldIds = assignmentFieldsFor(client, settings).map((field) => field.id);
  if (!usesCustomField(customViewsFor(client, settings).views, assignmentFieldIds)) return;
  loadCustomFields(client).catch((err) => console.warn('Could not load the Jira custom fields for custom views:', err));
}

/** Draws the views again, after they're saved or deleted, here or in another tab. */
function updateCustomViews() {
  if (!currentClient) return;
  checkViewFields(currentClient);
  if (workingIssuesState) setWorkingIssuesState(workingIssuesState);
}

/**
 * A view's search: its results' key (the Jira site and the view's JQL) and how to run it; null when
 * its field is unavailable, so it can't be searched.
 * @returns {{ key: string, run: (signal: AbortSignal) => Promise<object> } | null}
 */
function viewSearchFor(client, view, context) {
  if (!isViewAvailable(view, context)) return null;
  let jql;
  try {
    jql = buildCustomViewJql(view, { userFieldIds: viewUserFieldIds(view, context) });
  } catch {
    return null;
  }
  return {
    key: `${siteId(client.deploymentType, client.baseUrl)}\n${jql}`,
    run: (signal) => client.searchCustomViewIssues(jql, { signal })
  };
}

/**
 * The custom views options for My Work (the tabs), or undefined without a Jira site. Searches the
 * selected custom view when it shows, and drops the results no view has any more.
 * @returns {object | undefined}
 */
function customViewsOptions() {
  if (!currentClient) return undefined;
  const client = currentClient;
  const site = siteId(client.deploymentType, client.baseUrl);
  const { views: saved, unsupported } = customViewsFor(client);
  // In their tabs' order (reordering never changes a view, its search, or its results).
  const views = orderViews(saved, customViewOrderForSite(savedSettings, site));
  const context = {
    assignmentFieldIds: assignmentFieldsFor(client).map((field) => field.id),
    singleSelectFieldIds: customFieldCatalog?.site === site ? customFieldCatalog.optionIds : null,
    userPickerFieldIds: customFieldCatalog?.site === site ? customFieldCatalog.userIds : null
  };
  const searches = new Map(views.map((view) => [view.id, viewSearchFor(client, view, context)]));

  const selectedId = views.some((view) => view.id === selectedViewId) ? selectedViewId : ALL_VIEW_ID;
  const selectedSearch = searches.get(selectedId);
  if (selectedSearch && isWorkingIssuesExpanded && workingIssuesGroupsExpanded.active) {
    viewSearch.load(selectedSearch.key, selectedSearch.run, { from: viewSearchKeys.get(selectedId) });
  }
  // A deleted view's results, or an edited one's old results, go (their searches are cancelled).
  viewSearch.retain([...searches.values()].filter(Boolean).map((search) => search.key));
  viewSearchKeys.clear();
  for (const [id, search] of searches) if (search) viewSearchKeys.set(id, search.key);

  return {
    items: views.map((view) => {
      const search = searches.get(view.id);
      return { id: view.id, name: view.name, description: describeView(view), unavailable: !search, result: search ? viewSearch.get(search.key) : null };
    }),
    selectedId,
    // Views saved by another version of the extension are left alone: none can be added.
    canCreate: !unsupported && views.length < MAX_CUSTOM_VIEWS,
    // As views can only be added then: views saved by another version keep their order.
    canReorder: !unsupported && views.length > 1,
    onMove: (id, toIndex) => moveView(client, views.map((view) => view.id), id, toIndex),
    announcement: viewTabsAnnouncement,
    onSelect: selectView,
    onCreate: () => openViewEditor(null),
    onEdit: (id) => openViewEditor(id),
    onRefresh: (id) => {
      const search = searches.get(id);
      if (!search) return;
      viewSearch.refresh(search.key, search.run);
      setWorkingIssuesState(workingIssuesState);
    }
  };
}

/**
 * Moves a custom view's tab (`ids`: the site's custom views in their tabs' order): shown at once,
 * then saved (settingsStore.saveCustomViewOrder()), which other tabs follow. The views themselves,
 * their searches, and their results are untouched, and the selected view stays selected. If it
 * can't be saved, the order goes back to what's stored, and a toast says why.
 */
function moveView(client, ids, id, toIndex) {
  const site = siteId(client.deploymentType, client.baseUrl);
  const order = reorderViewIds(ids, id, toIndex);
  if (order.join() === ids.join()) return;
  const name = customViewsFor(client).views.find((view) => view.id === id)?.name ?? 'The view';
  // Active is always first: a custom view's place among the tabs is one more than among the views.
  viewTabsAnnouncement = `Moved ${name} to position ${order.indexOf(id) + 2} of ${order.length + 1}.`;
  savedSettings = { ...savedSettings, customViewOrderBySite: { ...savedSettings?.customViewOrderBySite, [site]: order } };
  if (workingIssuesState) setWorkingIssuesState(workingIssuesState);
  settingsStore.saveCustomViewOrder(site, order).catch(async (err) => {
    console.warn('Could not save the order of the custom views:', err);
    showToast(err.message || "Couldn't save the order of the views.", { durationMs: 8000 });
    try {
      savedSettings = await settingsStore.load();
    } catch {
      // Keep what's shown.
    }
    if (workingIssuesState) setWorkingIssuesState(workingIssuesState);
  });
}

/** Shows a view's tab (Active or a custom view, searched when it hasn't been), and remembers it. */
function selectView(id) {
  selectedViewId = id;
  localStorage.setItem('jts-working-issues-view', id);
  if (workingIssuesState) setWorkingIssuesState(workingIssuesState);
}

// Jira's lists of statuses and priorities (GET /status, GET /priority), asked for once per page and
// Jira site, the first time the editor needs one: { site, status, priority } (promises).
let jiraValueLists = null;

/**
 * Jira's own list of values for Status or Priority; null when it can't be read (asked again the
 * next time).
 * @returns {Promise<Array<{ id: string, label: string }> | null>}
 */
function jiraFieldValues(client, field) {
  const site = siteId(client.deploymentType, client.baseUrl);
  if (jiraValueLists?.site !== site) jiraValueLists = { site };
  jiraValueLists[field.id] ??= (field.id === 'status' ? client.getStatuses() : client.getPriorities()).catch((err) => {
    console.warn(`Could not load Jira's list of ${field.id} values:`, err);
    if (jiraValueLists?.site === site) delete jiraValueLists[field.id];
    return null;
  });
  return jiraValueLists[field.id];
}

/**
 * The values to choose for a field in the editor: Me for a user field; every status or priority
 * Jira lists; for a custom field, Jira's suggestions for its options that start with `query`.
 * @param {{ id: string, kind: 'user' | 'option' }} field
 * @param {string} [query]
 * @returns {Promise<Array<object>>} Rejects when Jira can't be asked
 */
async function fieldValues(field, query = '') {
  if (field.kind === 'user') return [{ ...ME_VALUE }];
  if (!currentClient) throw new Error('No Jira site is connected.');
  if (field.id === 'status' || field.id === 'priority') {
    const values = await jiraFieldValues(currentClient, field);
    if (!values) throw new Error(`Couldn't load Jira's ${field.id} values.`);
    return values;
  }
  return currentClient.getFieldValueSuggestions(field.id, query);
}

/**
 * Opens the custom view editor: a new view (`viewId` null), or the saved view with that ID. Saving
 * or deleting writes the site's views (settingsStore.saveCustomViews()), checked again against
 * what's stored then, so a change made meanwhile in another tab isn't lost.
 * @param {string | null} viewId
 */
function openViewEditor(viewId) {
  const client = currentClient;
  if (!client) return;
  const view = viewId ? customViewsFor(client).views.find((item) => item.id === viewId) ?? null : null;
  if (viewId && !view) return;
  closeDrawers();
  const site = siteId(client.deploymentType, client.baseUrl);
  const returnFocus = document.activeElement;
  const coversEditor = coverWorklogEditor();

  /** The site's views as stored now (another tab may have changed them). */
  const storedViews = async () => {
    savedSettings = await settingsStore.load();
    const stored = customViewsFor(client);
    if (stored.unsupported) throw new Error('This Jira site\'s custom views were saved by another version of Timesheet for Jira. Update the extension to change them.');
    return stored.views;
  };

  /** Saves the site's views, then shows `showId` (or Active). */
  const store = async (views, showId) => {
    await settingsStore.saveCustomViews(site, views);
    savedSettings = await settingsStore.load();
    selectedViewId = showId;
    localStorage.setItem('jts-working-issues-view', showId);
    updateCustomViews();
  };

  customViewEditor = openCustomViewEditor(customViewEditorRoot, {
    view,
    fields: [
      ...SYSTEM_FIELDS.map((field) => ({ ...field, group: 'Fields' })),
      ...assignmentFieldsFor(client).map((field) => ({ id: field.id, name: field.name, kind: 'user', group: 'Additional Assignment Fields' }))
    ],
    loadCustomFields: () => loadCustomFields(client),
    loadValues: fieldValues,
    validate: (draft) => validateViewDraft(draft, { views: customViewsFor(client).views, editingId: view?.id }),
    async onSave(valid) {
      const views = await storedViews();
      const { errors } = validateViewDraft({
        name: valid.name,
        conditions: valid.conditions.map((condition) => ({
          field: { ...condition.field, kind: conditionKind(condition) },
          operator: condition.operator,
          values: condition.values
        })),
        orderBy: valid.orderBy
      }, { views, editingId: view?.id });
      const problem = errors.form ?? errors.name ?? errors.conditions ?? errors.orderBy ??
        errors.byCondition?.flatMap((found) => (found ? Object.values(found) : []))[0];
      if (problem) throw new Error(problem);
      const saved = { id: view?.id ?? crypto.randomUUID(), ...valid };
      await store(view ? views.map((item) => (item.id === view.id ? saved : item)) : [...views, saved], saved.id);
      showToast(view ? `Saved the ${saved.name} view` : `Created the ${saved.name} view`, { success: true });
    },
    onDelete: view && (async () => {
      const views = await storedViews();
      await store(views.filter((item) => item.id !== view.id), ALL_VIEW_ID);
      showToast(`Deleted the ${view.name} view`);
    }),
    onClose: () => {
      customViewEditor = null;
      uncoverWorklogEditor(coversEditor);
      // Back to where the user was, or to the view's tab once the section has been drawn again.
      const target = returnFocus?.isConnected && returnFocus !== document.body
        ? returnFocus
        : daysContainer.querySelector(`#workingIssuesViewTab-${CSS.escape(customViewsOptions()?.selectedId ?? ALL_VIEW_ID)}`);
      target?.focus();
    }
  });
}

// Custom views saved, deleted, or reordered in another tab: show them here too.
platform.watchStorage((changes) => {
  if (!('customViewsBySite' in changes) && !('customViewOrderBySite' in changes)) return;
  settingsStore.load().then((settings) => {
    savedSettings = settings;
    updateCustomViews();
  }, (err) => console.warn('Could not read the custom views:', err));
});

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
    // Shown beside the issue's key once there's an issue and the timer's state is known; choosing an
    // issue never starts a timer.
    timer: logWorkTimerOptions(),
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
  closeDrawers();
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
 * Opens the Log work panel for an issue in My Work (the row's + button). Like a worklog
 * card's + button, the date defaults to the selected day and the start time to now.
 * @param {{ issueId: string, issueKey: string, issueSummary: string, issueStatus: object | null }} issue
 */
function startLogWorkOnIssue(issue) {
  closeDrawers();
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
  closeDrawers();
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
  closeDrawers();
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
  closeDrawers();
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
 * @param {boolean} [options.force=false] - Also reload My Work when the week is already shown (Sync, Retry, new settings)
 */
async function loadAndRenderWorklogs(options = {}) {
  if (isBusyFetching) return;

  const { monday, sunday } = getWeekRange(currentMonday);

  // Update date range heading immediately
  weekDateRangeText.textContent = formatWeekRange(monday, sunday);

  let settings;
  try {
    settings = await settingsStore.load();
    // The page's saved settings follow what's stored, as this load reads it, so the later loads of My
    // Work (Retry, custom views) ask for the same issues as the list this one shows.
    savedSettings = settings;
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

    // Sync searches the custom views again too, as they're shown.
    if (options.force) viewSearch.clear();
    // Not awaited: the worklogs don't wait for the issues, nor fail with them.
    workingIssues.refresh(client, {
      force: Boolean(options.force),
      assignmentFields: assignmentFieldsFor(client, settings),
      includeRecentlyLogged: settings.showRecentlyLoggedIssues
    });
    checkViewFields(client, settings);

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
  weekPickerBtn.disabled = isBusy;
  nextHolidayBanner.disabled = isBusy;
  if (isBusy) weekPicker.close();
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
  // An edition without its URL or token yet shows the fields to fill in.
  if (!baseUrl || !token) connectionSection.setExpanded(true);
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
  hideConnectionStatus();
}

/** Hides and empties the connection status card. The saved test result is kept. */
function hideConnectionStatus() {
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
    // The errors are in the Jira Connection section: show them.
    connectionSection.setExpanded(true);
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
  // Public Holidays can't be turned on without a country; then nothing is saved.
  const holidaysValidation = publicHolidaysSettings.validate();
  if (!formValidation.isValid || !formValidation.values || !holidaysValidation.isValid) {
    return;
  }

  const { baseUrl, deploymentType, email, token } = formValidation.values;
  const publicHolidaysValues = holidaysValidation.value;

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

    await settingsStore.save({ deploymentType, email, baseUrlsByType, tokensByType, publicHolidays: publicHolidaysValues });

    // Don't show the previous "Connection Successful" on next load for settings
    // that were changed and saved without being tested.
    if (hasUntestedChanges) {
      await settingsStore.clearTestResult();
    }

    // The saved settings are now the active configuration, and what the form shows when it
    // next opens.
    savedSettings = await settingsStore.load();
    // Turning the feature on loads the current year's holidays now; turning it off hides them.
    publicHolidays.configure(savedSettings.publicHolidays);

    await removeUnusedSiteAccess([baseUrlsByType.cloud, baseUrlsByType.server]);

    // Saved: the drawer stays open with Jira Connection collapsed (the form keeps its values), and
    // a toast confirms it. Focus moves to the header, since Save Settings is now hidden. Without
    // site access, the timesheet offers Allow Access.
    connectionSection.setConfigured(shouldCollapseConnection(savedSettings));
    connectionSection.setExpanded(false);
    connectionToggle.focus();
    showToast('Settings saved', {
      success: true,
      subtitle: hasSiteAccess ? '' : `Allow access to ${getSiteHost(baseUrl)} to load your worklogs`,
      durationMs: 5000
    });

    // Refresh worklog view with updated settings
    loadAndRenderWorklogs({ force: true });
  } catch (err) {
    // The drawer stays open with everything as entered, and Jira Connection expanded to show the
    // error, so saving can be retried.
    connectionSection.setExpanded(true);
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
 * edition, each edition's instance URL and token, and the email. The connection status starts
 * hidden (the saved test result isn't shown), and a connection test still running is ignored when
 * it finishes.
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
  publicHolidaysSettings.fill(settings.publicHolidays);

  // The connection status starts hidden: a test result shows only during the visit that ran it.
  invalidateConnectionStatus();
  hasUntestedChanges = false;
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
    publicHolidays.configure(settings.publicHolidays);

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
  expandDayPanel();
  loadAndRenderWorklogs();
});

nextWeekBtn.addEventListener('click', () => {
  currentMonday.setDate(currentMonday.getDate() + 7);
  expandDayPanel();
  loadAndRenderWorklogs();
});

// The Next Public Holiday banner shows the holiday's week, with the holiday selected, like a day
// chosen in the week picker.
nextHolidayBanner.addEventListener('click', () => {
  const { date } = nextHolidayBanner.dataset;
  if (!date) return;
  weekPicker.close();
  currentMonday = getMondayOfWeek(dateFromKey(date));
  selectedDateKey = date;
  expandDayPanel();
  loadAndRenderWorklogs();
});

thisWeekBtn.addEventListener('click', () => {
  currentMonday = getMondayOfWeek(new Date());
  selectedDateKey = getLocalDateKey(new Date());
  expandDayPanel();
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
  // The timer keeps running from its stored start; only the on-screen clock pauses while hidden.
  timer.setActive(document.visibilityState === 'visible');
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
  changelogDrawer?.close();
  customViewEditor?.close();
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

// ============================================================================
// What's New (the release notes from CHANGELOG.md)
// ============================================================================

// What the user has seen of the release notes (src/changelog/changelogState.js), in storage.local,
// shared by every open tab.
const changelogStore = createChangelogStateStore(platform.storage);
// The released versions in the packaged release notes, once read (newest first); null until then,
// or while they can't be. Only these count for the NEW badge and the announcement, never the preview
// of unreleased changes that the development output also has.
let changelogReleases = null;
let changelogRequest = null;
// What the user has seen (changelogStore.resolve()); null until known, and outside the extension,
// where there's no installed version to go by.
let changelogState = null;

/**
 * The release notes, read once per page: the releases, and the unreleased changes (development
 * output only). A failed read is tried again the next time they're needed.
 * @returns {Promise<{ releases: Array<object>, unreleased: object | null } | null>}
 */
function getChangelog() {
  changelogRequest ??= loadChangelog().then((changelog) => {
    if (changelog) changelogReleases = changelog.releases;
    else changelogRequest = null;
    return changelog;
  });
  return changelogRequest;
}

/** Shows the NEW badge on the What's New button while the latest release notes haven't been seen. */
function updateChangelogBadge() {
  const unread = hasUnreadRelease(changelogReleases ?? [], changelogState);
  changelogNewBadge.classList.toggle('hidden', !unread);
  changelogBtn.setAttribute('aria-label', unread ? "What's New, new release notes" : "What's New");
  changelogBtn.setAttribute('data-tooltip', unread ? "What's New · New release notes" : "What's New");
}

/** Reads what the user has seen again (after a change here or in another tab), and updates the badge. */
async function refreshChangelogState() {
  try {
    changelogState = await changelogStore.resolve(platform.getManifest()?.version);
  } catch (err) {
    console.warn('Could not read what was seen of the Changelog:', err);
    return;
  }
  updateChangelogBadge();
}

/**
 * Opens the What's New drawer. Its latest release counts as read once the drawer has shown it (not
 * before, and not when the notes can't be loaded), which removes the NEW badge. An update
 * announcement still showing goes away. An open worklog panel slides out of the way without closing,
 * as for the other drawers.
 */
function openChangelog() {
  if (changelogDrawer) return;
  shortcutsDrawer?.close();
  customViewEditor?.close();
  closeSettings();
  hideUpdateAnnouncement(updateAnnouncementRoot);
  const returnFocus = document.activeElement;
  const coversEditor = coverWorklogEditor();

  changelogBtn.setAttribute('aria-expanded', 'true');
  changelogDrawer = openChangelogDrawer(changelogDrawerRoot, {
    loadChangelog: getChangelog,
    onRead: (version) => {
      changelogStore.markRead(version)
        .then(refreshChangelogState)
        .catch((err) => console.warn('Could not record that the release notes were read:', err));
    },
    onClose: () => {
      changelogDrawer = null;
      changelogBtn.setAttribute('aria-expanded', 'false');
      uncoverWorklogEditor(coversEditor);
      // Back to where the user was, if it's still there.
      if (returnFocus?.isConnected && returnFocus !== document.body) returnFocus.focus();
    }
  });
}

/** The header's What's New button: opens the drawer, or closes it when it's open. */
function toggleChangelog() {
  if (changelogDrawer) changelogDrawer.close();
  else openChangelog();
}

changelogBtn.addEventListener('click', toggleChangelog);

/**
 * Shows the update announcement for a release, on this tab once it's visible (a tab opened in the
 * background waits). It's recorded as shown once it's on screen, at the next frame, which a hidden
 * tab never draws. Not shown if, meanwhile, another tab showed it, its notes were read, or What's
 * New is open.
 * @param {object} release
 */
function announceWhenVisible(release) {
  if (document.visibilityState !== 'visible') {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      document.removeEventListener('visibilitychange', onVisible);
      announceWhenVisible(release);
    };
    document.addEventListener('visibilitychange', onVisible);
    return;
  }
  if (changelogDrawer || !announcementFor([release], changelogState, release.version)) return;

  showUpdateAnnouncement(updateAnnouncementRoot, {
    release,
    highlights: releaseHighlights(release),
    onExplore: openChangelog
  });
  requestAnimationFrame(() => {
    changelogStore.markAnnounced(release.version)
      .catch((err) => console.warn('Could not record that the update announcement was shown:', err));
  });
}

/**
 * Loads the release notes and what the user has seen of them when the page opens: the NEW badge,
 * and the update announcement after an update (never after a fresh install).
 */
async function initChangelog() {
  const version = platform.getManifest()?.version;
  let changelog;
  try {
    [changelog, changelogState] = await Promise.all([getChangelog(), changelogStore.resolve(version)]);
  } catch (err) {
    console.warn('Could not read what was seen of the Changelog:', err);
    return;
  }
  updateChangelogBadge();
  const release = changelog && announcementFor(changelog.releases, changelogState, version);
  if (release) announceWhenVisible(release);
}

// Another tab showed the announcement or the release notes: follow it.
platform.watchStorage((changes) => {
  if (LAST_ANNOUNCED_KEY in changes || LAST_READ_KEY in changes) refreshChangelogState();
});

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
  description: 'Open settings',
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
const weekNavigationAvailable = () => !isDeleteDialogOpen && !shortcutsDrawer && !changelogDrawer && !customViewEditor && !settingsDrawerState;

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
  when: () => !settingsDrawerState && !worklogEditor && !isDeleteDialogOpen && !shortcutsDrawer && !changelogDrawer && !customViewEditor &&
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
  when: () => !worklogEditor && !isDeleteDialogOpen && !shortcutsDrawer && !changelogDrawer && !customViewEditor && !settingsDrawerState,
  handler: () => refreshWorklogsBtn.click()
});

for (const shortcut of [...VIEW_TAB_SHORTCUTS, ...GROUP_SHORTCUTS]) shortcuts.register(shortcut);
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

// Initialize on page load. The timer loads on its own, from storage, whatever happens with Jira.
document.addEventListener('DOMContentLoaded', () => {
  timer.setActive(document.visibilityState === 'visible');
  timer.init();
  loadSavedSettings();
  initChangelog();
  renderSettingsVersion(document.getElementById('settingsVersion'), platform.getManifest());
  loadAboutInfo().then((info) => renderAboutSection(document.getElementById('aboutSection'), { manifest: platform.getManifest(), info }));
});
