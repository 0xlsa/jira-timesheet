/**
 * Timesheet for Jira Options & Weekly Worklog Controller
 *
 * Page controller: owns DOM wiring and view state, and delegates to
 * - settings persistence (src/settings/settingsStore.js),
 * - Jira access (src/jira/createJiraClient.js) and week loading (src/worklog/),
 * - presentation of the weekly view (src/ui/weekView.js),
 * - browser platform services (src/compat/browser-api.js).
 *
 * Compatible with Chrome (MV3) and Firefox (MV3, 116+).
 */

import { JiraUrlValidator } from './src/validation/JiraUrlValidator.js';
import { EMAIL_REGEX } from './src/auth/JiraCloudTokenProvider.js';
import { createJiraClient } from './src/jira/createJiraClient.js';
import {
  getMondayOfWeek,
  getLocalDateKey,
  getWeekRange,
  formatWeekRange,
  buildEmptyWeek
} from './src/worklog/worklogUtils.js';
import {
  loadWeek,
  saveWorklogChanges,
  deleteWorklog,
  replaceWorklogInWeek,
  removeWorklogFromWeek
} from './src/worklog/weeklyWorklogService.js';
import { createSettingsStore, normalizeSettings, isConfigured } from './src/settings/settingsStore.js';
import { createPlatform } from './src/compat/browser-api.js';
import { escapeHtml } from './src/ui/html.js';
import { renderWeek } from './src/ui/weekView.js';
import { openWorklogEditor } from './src/ui/worklogEditor.js';

const platform = createPlatform();
const settingsStore = createSettingsStore(platform.storage);

// ============================================================================
// DOM Element References
// ============================================================================

// Navigation Tabs
const tabWeekly = document.getElementById('tabWeekly');
const tabSettings = document.getElementById('tabSettings');
const weeklySection = document.getElementById('weeklySection');
const settingsSection = document.getElementById('settingsSection');

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
const emptyWeekBanner = document.getElementById('emptyWeekBanner');
const daysContainer = document.getElementById('daysContainer');
const worklogEditorRoot = document.getElementById('worklogEditor');
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

// Open Edit Worklog panel (see src/ui/worklogEditor.js), or null.
let worklogEditor = null;
let toastTimer = null;

// Settings form values kept per Jira edition, so Cloud and Data Center / Server
// instance URLs and tokens never overwrite each other when switching editions.
const baseUrlsByType = { cloud: '', server: '' };
const tokensByType = { cloud: '', server: '' };

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
// Tab Navigation
// ============================================================================

/**
 * Switches the active tab view between Weekly Worklogs and Settings.
 * @param {'weekly' | 'settings'} tabId
 */
function switchTab(tabId) {
  // The editor belongs to the weekly view; leaving it asks about unsaved changes first.
  if (tabId !== 'weekly' && worklogEditor && !worklogEditor.requestClose()) return;

  if (tabId === 'weekly') {
    tabWeekly.classList.add('active');
    tabWeekly.setAttribute('aria-selected', 'true');
    tabSettings.classList.remove('active');
    tabSettings.setAttribute('aria-selected', 'false');

    weeklySection.classList.remove('hidden');
    settingsSection.classList.add('hidden');
  } else {
    tabSettings.classList.add('active');
    tabSettings.setAttribute('aria-selected', 'true');
    tabWeekly.classList.remove('active');
    tabWeekly.setAttribute('aria-selected', 'false');

    settingsSection.classList.remove('hidden');
    weeklySection.classList.add('hidden');
  }
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
    },
    onEditWorklog: aggregatedData.sourceWorklogs ? openEditor : undefined,
    onLogWork: aggregatedData.sourceWorklogs ? startLogWork : undefined,
    editingWorklogId: worklogEditor?.worklogId
  });
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
 */
function showToast(message) {
  clearTimeout(toastTimer);
  appToast.textContent = message;
  toastTimer = setTimeout(() => { appToast.textContent = ''; }, 4000);
}

/**
 * Entry point for logging more work on a worklog's issue (the card's + button). The issue
 * comes from the week already loaded, so this makes no Jira requests.
 * The Log Work flow isn't built yet; until it is, this tells the user so.
 * @param {string} worklogId - A worklog on the issue to log work against
 */
function startLogWork(worklogId) {
  const worklog = currentAggregatedData?.sourceWorklogs?.find((wl) => String(wl.id) === worklogId);
  if (!worklog) return;

  showToast(`Logging new work on ${worklog.issueKey} isn't available yet.`);
}

/**
 * Opens the Edit Worklog panel for a worklog in the displayed week. If another worklog
 * is open with unsaved changes, the user is asked to discard them first.
 * @param {string} worklogId
 */
function openEditor(worklogId) {
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
      const movedTo = new Date(updated.started);
      const stillInWeek = currentAggregatedData.weekDays.some((d) => d.dateKey === getLocalDateKey(movedTo));
      showToast(stillInWeek ? 'Worklog updated.' : `Worklog updated and moved to ${movedTo.toLocaleDateString()}.`);
    },
    onDelete: async () => {
      await deleteWorklog(client, worklog);
      if (currentAggregatedData?.sourceWorklogs) {
        showWeek(removeWorklogFromWeek(currentAggregatedData, worklogId), currentBaseUrl);
      }
      showToast('Worklog deleted.');
    },
    onClose: () => {
      worklogEditor = null;
      if (currentAggregatedData) renderDays(currentAggregatedData, currentBaseUrl);
      // Return focus to the edited worklog's button, or the day panel if it moved or was deleted.
      (daysContainer.querySelector(`.worklog-edit-btn[data-worklog-id="${CSS.escape(worklogId)}"]`) ||
        daysContainer.querySelector('.day-card.is-selected'))?.focus();
    }
  });

  renderDays(currentAggregatedData, currentBaseUrl);
}

/**
 * Fetches worklogs from Jira for the current week and updates all views.
 *
 * @param {object} [options]
 * @param {boolean} [options.force=false]
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

  if (!isConfigured(settings)) {
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
    showWorklogError('Invalid Jira Configuration', error);
    return;
  }

  currentClient = client;
  currentBaseUrl = client.baseUrl;

  // Update instance card header immediately with domain
  try {
    userInstanceHost.textContent = new URL(client.baseUrl).host;
  } catch {
    userInstanceHost.textContent = client.baseUrl;
  }

  deploymentBadge.textContent = settings.deploymentType === 'cloud' ? 'Cloud' : 'Data Center';
  deploymentBadge.className = `stat-badge ${settings.deploymentType === 'cloud' ? 'badge-cloud' : 'badge-server'}`;

  setWorklogBusy(true);
  worklogErrorAlert.classList.add('hidden');
  emptyWeekBanner.classList.add('hidden');

  try {
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
    tokenLabel.innerHTML = 'Atlassian API Token <span class="required">*</span>';
    jiraTokenInput.placeholder = 'Enter your Atlassian API token';
    cloudTokenHelp.classList.remove('hidden');
    serverTokenHelp.classList.add('hidden');
  } else {
    radioServer.checked = true;
    cloudEmailGroup.classList.add('hidden');
    tokenLabel.innerHTML = 'Personal Access Token (PAT) <span class="required">*</span>';
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
  const previousType = type === 'cloud' ? 'server' : 'cloud';
  baseUrlsByType[previousType] = jiraBaseUrlInput.value.trim();
  tokensByType[previousType] = jiraTokenInput.value.trim();
  setDeploymentType(type);
  jiraBaseUrlInput.value = baseUrlsByType[type];
  jiraTokenInput.value = tokensByType[type];
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
  statusArea.innerHTML = '';
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
  statusArea.className = 'status-container';
  statusArea.classList.remove('hidden');

  if (type === 'loading') {
    statusArea.classList.add('status-info');
    statusArea.innerHTML = `
      <div class="status-header">
        <span class="btn-spinner"></span>
        <span>Connecting to Jira...</span>
      </div>
      <div class="status-body">Verifying credentials and identity endpoint.</div>
    `;
    return;
  }

  if (type === 'success') {
    statusArea.classList.add('status-success');
    const user = payload.user || {};
    const serverInfo = payload.serverInfo;
    const initial = (user.displayName || 'U').charAt(0).toUpperCase();

    let metaDetails = user.emailAddress || user.name || '';
    if (serverInfo && serverInfo.version) {
      metaDetails += metaDetails ? ` • Jira v${serverInfo.version}` : `Jira v${serverInfo.version}`;
    }

    statusArea.innerHTML = `
      <div class="status-header">
        <svg class="status-header-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
          <polyline points="22 4 12 14.01 9 11.01"/>
        </svg>
        <span>Connection Successful</span>
      </div>
      <div class="status-body">
        <div class="user-card">
          <div class="user-avatar">${escapeHtml(initial)}</div>
          <div class="user-details">
            <span class="user-name">${escapeHtml(user.displayName || 'Authenticated User')}</span>
            <span class="user-meta">${escapeHtml(metaDetails)}</span>
          </div>
        </div>
        <span class="status-timestamp">Verified at: ${new Date(payload.testedAt || Date.now()).toLocaleTimeString()}</span>
      </div>
    `;
    return;
  }

  if (type === 'error') {
    statusArea.classList.add('status-error');
    statusArea.innerHTML = `
      <div class="status-header">
        <svg class="status-header-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="8" x2="12" y2="12"/>
          <line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        <span>Connection Failed</span>
      </div>
      <div class="status-body">
        <p>${escapeHtml(payload.error || 'Unable to connect to Jira.')}</p>
        ${payload.serverMessage ? `<p style="margin-top: 4px; font-size: 12px; opacity: 0.9;"><strong>Server detail:</strong> ${escapeHtml(payload.serverMessage)}</p>` : ''}
        <span class="status-timestamp">Attempted at: ${new Date(payload.testedAt || Date.now()).toLocaleTimeString()}</span>
      </div>
    `;
    return;
  }

  if (type === 'info') {
    statusArea.classList.add('status-info');
    statusArea.innerHTML = `
      <div class="status-header">
        <svg class="status-header-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="16" x2="12" y2="12"/>
          <line x1="12" y1="8" x2="12.01" y2="8"/>
        </svg>
        <span>${escapeHtml(payload.title || 'Notification')}</span>
      </div>
      <div class="status-body">${escapeHtml(payload.message || '')}</div>
    `;
  }
}

/**
 * Handles "Test Connection" button click.
 */
async function onTestConnection() {
  const formValidation = validateForm();
  if (!formValidation.isValid || !formValidation.values) {
    return;
  }

  const testId = ++connectionTestId;

  renderStatus('loading');
  setBusy(true);

  try {
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

  const formValidation = validateForm();
  if (!formValidation.isValid || !formValidation.values) {
    return;
  }

  const { baseUrl, deploymentType, email, token } = formValidation.values;

  jiraBaseUrlInput.value = baseUrl;
  setBusy(true);

  try {
    baseUrlsByType[deploymentType] = baseUrl;
    tokensByType[deploymentType] = token;

    await settingsStore.save({ deploymentType, email, baseUrlsByType, tokensByType });

    // Don't show the previous "Connection Successful" on next load for settings
    // that were changed and saved without being tested.
    if (hasUntestedChanges) {
      await settingsStore.clearTestResult();
    }

    renderStatus('info', {
      title: 'Settings Saved',
      message: 'Your Jira configuration has been successfully saved to local browser storage.'
    });

    // Refresh worklog view with updated settings
    loadAndRenderWorklogs({ force: true });
  } catch (err) {
    renderStatus('error', {
      error: `Failed to save settings: ${err.message || 'Storage error'}`
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
 * Loads saved settings from the browser extension storage when the page opens.
 * Works with both chrome.storage.local (Chrome MV3) and browser.storage.local (Firefox MV3).
 */
async function loadSavedSettings() {
  try {
    const settings = await settingsStore.load();

    Object.assign(baseUrlsByType, settings.baseUrlsByType);
    Object.assign(tokensByType, settings.tokensByType);

    setDeploymentType(settings.deploymentType);
    jiraBaseUrlInput.value = baseUrlsByType[settings.deploymentType];
    updateOpenInstanceBtn();
    jiraEmailInput.value = settings.email;
    jiraTokenInput.value = tokensByType[settings.deploymentType];

    if (settings.lastTestResult && settings.lastTestResult.success) {
      renderStatus('success', settings.lastTestResult);
    }

    // If no settings exist yet, default to settings tab, otherwise show weekly view
    const hasConfig = Boolean(settings.jiraBaseUrl && settings.token);
    if (!hasConfig && window.location.hash !== '#weekly') {
      switchTab('settings');
    } else {
      switchTab('weekly');
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

// Tab Switching
tabWeekly.addEventListener('click', () => switchTab('weekly'));
tabSettings.addEventListener('click', () => switchTab('settings'));
goToSettingsBtn.addEventListener('click', () => switchTab('settings'));

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

// Settings Form Actions
radioCloud.addEventListener('change', () => switchDeploymentType('cloud'));
radioServer.addEventListener('change', () => switchDeploymentType('server'));

toggleTokenBtn.addEventListener('click', () => {
  const isPassword = jiraTokenInput.type === 'password';
  jiraTokenInput.type = isPassword ? 'text' : 'password';
  eyeIcon.classList.toggle('hidden', isPassword);
  eyeOffIcon.classList.toggle('hidden', !isPassword);
  toggleTokenBtn.setAttribute('aria-label', isPassword ? 'Hide token' : 'Show token');
});

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

// Warn before leaving the page with unsaved worklog edits
window.addEventListener('beforeunload', (event) => {
  if (worklogEditor?.isDirty) {
    event.preventDefault();
    event.returnValue = '';
  }
});

// Initialize on page load
document.addEventListener('DOMContentLoaded', loadSavedSettings);
