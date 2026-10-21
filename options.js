/**
 * Timesheet for Jira Options & Weekly Worklog Controller
 *
 * Responsibilities:
 * - Tab navigation (Weekly Worklogs vs Connection Settings)
 * - Week navigation (previous, next, today/this week)
 * - Jira worklog data retrieval using standard Jira REST API via JiraClient
 * - Day aggregation in user local timezone and second-level precision duration calculations
 * - Weekday card selection and selected-day worklog panel
 * - Settings loading, validation, and persistence via the browser storage API
 * - Zero credential leakage in error handling and UI
 * Compatible with Chrome (MV3) and Firefox (MV3, 116+).
 */

import { JiraUrlValidator } from './src/validation/JiraUrlValidator.js';
import { JiraCloudTokenProvider } from './src/auth/JiraCloudTokenProvider.js';
import { JiraPatProvider } from './src/auth/JiraPatProvider.js';
import { JiraClient } from './src/jira/JiraClient.js';
import {
  getMondayOfWeek,
  getLocalDateKey,
  getWeekDays,
  formatWeekRange,
  aggregateWorklogsByWeek
} from './src/worklog/worklogUtils.js';
import { ext, isExtensionContext } from './src/compat/browser-api.js';

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
let savedSettings = null;
let isBusyFetching = false;

// Settings form tokens kept per deployment type, so a Cloud API token and a
// Data Center PAT never overwrite each other when switching types.
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
// Security & Utilities
// ============================================================================

/**
 * Escapes HTML characters to prevent XSS when injecting strings into the DOM.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ============================================================================
// Tab Navigation
// ============================================================================

/**
 * Switches the active tab view between Weekly Worklogs and Settings.
 * @param {'weekly' | 'settings'} tabId
 */
function switchTab(tabId) {
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

// Daily duration that fills a weekday card's indicator bar (visual only).
const DAY_INDICATOR_FULL_SECONDS = 8 * 60 * 60;

const LONG_DATE_FORMAT = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric'
});

/**
 * Builds the HTML for a single worklog entry in the selected-day panel.
 * @param {object} wl
 * @param {string} baseUrl
 * @returns {string}
 */
function renderWorklogItem(wl, baseUrl) {
  const issueUrl = baseUrl ? `${baseUrl.replace(/\/+$/, '')}/browse/${encodeURIComponent(wl.issueKey)}` : '#';

  return `
    <a href="${escapeHtml(issueUrl)}" target="_blank" rel="noopener noreferrer" class="issue-key-badge" title="Open ${escapeHtml(wl.issueKey)} in Jira">
      ${escapeHtml(wl.issueKey || 'ISSUE')}
    </a>
    <div class="worklog-body">
      <span class="issue-summary" title="${escapeHtml(wl.issueSummary)}">${escapeHtml(wl.issueSummary)}</span>
      ${wl.comment ? `<div class="worklog-comment">${escapeHtml(wl.comment)}</div>` : ''}
      <div class="worklog-meta-row">
        <span class="worklog-time">
          <svg class="meta-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/>
            <polyline points="12 6 12 12 16 14"/>
          </svg>
          Started ${escapeHtml(wl.formattedStartTime)}
        </span>
        ${wl.author?.displayName ? `
        <span class="worklog-author">
          <svg class="meta-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
            <circle cx="12" cy="7" r="4"/>
          </svg>
          ${escapeHtml(wl.author.displayName)}
        </span>` : ''}
      </div>
    </div>
    <span class="worklog-duration-badge">${escapeHtml(wl.formattedDuration)}</span>
  `;
}

/**
 * Renders the 7 weekday cards and the selected day's worklog panel.
 * Daily totals and weekly totals are never modified by changing the selection.
 *
 * @param {object} aggregatedData
 * @param {string} baseUrl
 */
function renderDays(aggregatedData, baseUrl = '') {
  daysContainer.innerHTML = '';

  const weekDays = aggregatedData.weekDays || [];
  const selectedDay = weekDays.find((d) => d.dateKey === selectedDateKey) || weekDays[0];
  if (!selectedDay) return;

  // 1. Weekday cards strip
  const strip = document.createElement('div');
  strip.className = 'week-strip';
  strip.setAttribute('role', 'tablist');
  strip.setAttribute('aria-label', 'Days of the week');

  weekDays.forEach((day) => {
    const isSelected = day === selectedDay;
    const fillPercent = Math.min(100, (day.totalDurationSeconds / DAY_INDICATOR_FULL_SECONDS) * 100);

    const dayCard = document.createElement('button');
    dayCard.type = 'button';
    dayCard.className = `day-card ${day.isToday ? 'is-today' : ''} ${isSelected ? 'is-selected' : ''} ${day.totalDurationSeconds > 0 ? 'has-time' : ''}`;
    dayCard.dataset.dateKey = day.dateKey;
    dayCard.setAttribute('role', 'tab');
    dayCard.setAttribute('aria-selected', isSelected ? 'true' : 'false');
    dayCard.setAttribute('aria-controls', 'selectedDayPanel');
    dayCard.title = `${day.dayName}, ${day.formattedDate}`;

    dayCard.innerHTML = `
      <span class="day-card-top">
        <span class="day-name">${escapeHtml(day.shortDayName)}</span>
        ${day.isToday ? '<span class="badge-today">Today</span>' : ''}
      </span>
      <span class="day-date">${escapeHtml(String(day.dayOfMonth))}</span>
      <span class="day-duration">${escapeHtml(day.formattedTotal)}</span>
      <span class="day-count">${day.worklogCount} ${day.worklogCount === 1 ? 'worklog' : 'worklogs'}</span>
      <span class="day-indicator" aria-hidden="true"><span class="day-indicator-fill" style="width: ${fillPercent.toFixed(1)}%"></span></span>
    `;

    dayCard.addEventListener('click', () => {
      selectedDateKey = day.dateKey;
      updateSelectedDayMetric(day.dateKey);
      renderDays(aggregatedData, baseUrl);
      daysContainer.querySelector(`.day-card[data-date-key="${day.dateKey}"]`)?.focus();
    });

    strip.appendChild(dayCard);
  });

  daysContainer.appendChild(strip);

  // 2. Selected-day worklogs panel
  const panel = document.createElement('section');
  panel.id = 'selectedDayPanel';
  panel.className = 'day-panel';
  panel.setAttribute('role', 'tabpanel');

  const countLabel = `${selectedDay.worklogCount} ${selectedDay.worklogCount === 1 ? 'worklog' : 'worklogs'}`;
  panel.innerHTML = `
    <div class="day-panel-header">
      <div>
        <h3 class="day-panel-title">${escapeHtml(selectedDay.dayName)}, ${escapeHtml(LONG_DATE_FORMAT.format(selectedDay.date))}</h3>
        <span class="day-panel-meta">${countLabel} &bull; ${escapeHtml(selectedDay.formattedTotal)} total</span>
      </div>
      <span class="day-panel-total ${selectedDay.totalDurationSeconds > 0 ? 'has-time' : ''}">${escapeHtml(selectedDay.formattedTotal)}</span>
    </div>
  `;

  if (selectedDay.worklogs.length > 0) {
    const listEl = document.createElement('div');
    listEl.className = 'worklog-list';

    selectedDay.worklogs.forEach((wl) => {
      const itemEl = document.createElement('div');
      itemEl.className = 'worklog-item';
      itemEl.innerHTML = renderWorklogItem(wl, baseUrl);
      listEl.appendChild(itemEl);
    });

    panel.appendChild(listEl);
  } else {
    const emptyPlaceholder = document.createElement('div');
    emptyPlaceholder.className = 'empty-day-placeholder';
    emptyPlaceholder.textContent = 'No worklogs logged for this day.';
    panel.appendChild(emptyPlaceholder);
  }

  daysContainer.appendChild(panel);
}

/**
 * Fetches worklogs from Jira for the current week and updates all views.
 *
 * @param {object} [options]
 * @param {boolean} [options.force=false]
 */
async function loadAndRenderWorklogs(options = {}) {
  if (isBusyFetching) return;

  // 1. Calculate Sunday (end of week)
  const monday = new Date(currentMonday);
  monday.setHours(0, 0, 0, 0);

  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);

  // Update date range heading immediately
  weekDateRangeText.textContent = formatWeekRange(monday, sunday);

  // 2. Load settings from storage
  let settings;
  try {
    if (isExtensionContext() && ext.storage && ext.storage.local) {
      settings = await ext.storage.local.get([
        'jiraBaseUrl',
        'deploymentType',
        'email',
        'token',
        'lastTestResult'
      ]);
    } else {
      settings = savedSettings || {};
    }
  } catch (err) {
    console.error('Storage access error:', err);
    settings = {};
  }

  savedSettings = settings;

  // Check if connection is configured
  const isConfigured = Boolean(
    settings.jiraBaseUrl &&
    settings.token &&
    (settings.deploymentType === 'server' || settings.email)
  );

  if (!isConfigured) {
    unconfiguredAlert.classList.remove('hidden');
    worklogErrorAlert.classList.add('hidden');
    emptyWeekBanner.classList.add('hidden');

    // Render empty week with 0h 00m totals
    const weekDays = getWeekDays(monday, new Date());
    const emptyAggregated = aggregateWorklogsByWeek([], weekDays);
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

  // Validate Base URL & Origin pattern
  const urlCheck = JiraUrlValidator.validate(settings.jiraBaseUrl);
  if (!urlCheck.isValid) {
    showWorklogError('Invalid Jira Configuration', urlCheck.error || 'Invalid Base URL.');
    return;
  }

  // Update instance card header immediately with domain
  try {
    const parsed = new URL(urlCheck.sanitizedUrl);
    userInstanceHost.textContent = parsed.host;
  } catch {
    userInstanceHost.textContent = urlCheck.sanitizedUrl;
  }

  deploymentBadge.textContent = settings.deploymentType === 'cloud' ? 'Cloud' : 'Data Center';
  deploymentBadge.className = `stat-badge ${settings.deploymentType === 'cloud' ? 'badge-cloud' : 'badge-server'}`;

  // 3. Request / Verify Host Permission
  const hasPermission = await ensureHostPermission(urlCheck.originPattern);
  if (!hasPermission) {
    showWorklogError(
      'Host Permission Required',
      `Permission to reach "${urlCheck.originPattern}" was not granted. Please click "Grant Permission" or test connection in Settings.`
    );
    return;
  }

  // 4. Begin Fetch
  setWorklogBusy(true);
  worklogErrorAlert.classList.add('hidden');
  emptyWeekBanner.classList.add('hidden');

  try {
    // Instantiate provider and client
    let provider;
    if (settings.deploymentType === 'cloud') {
      provider = new JiraCloudTokenProvider(settings.email, settings.token);
    } else {
      provider = new JiraPatProvider(settings.token);
    }

    const client = new JiraClient(urlCheck.sanitizedUrl, provider);

    // Fetch worklogs for target week
    const result = await client.getWorklogsForDateRange(monday, sunday);

    // Populate user metadata from response
    if (result.user) {
      userName.textContent = result.user.displayName || 'Authenticated User';
      const initial = (result.user.displayName || 'U').charAt(0).toUpperCase();
      userAvatar.textContent = initial;
    }

    // Aggregate into 7 days using user's local timezone
    const weekDays = getWeekDays(monday, new Date());
    const aggregated = aggregateWorklogsByWeek(result.worklogs, weekDays);
    currentAggregatedData = aggregated;

    // Update Totals
    weeklyTotalDuration.textContent = aggregated.formattedWeekTotal;
    weeklyTotalCount.textContent = `${aggregated.totalWorklogsCount} worklog${aggregated.totalWorklogsCount === 1 ? '' : 's'}`;

    // Update Selected Day Card
    updateSelectedDayMetric(selectedDateKey);

    // Show empty week banner if no results
    if (!aggregated.hasAnyWorklogs) {
      emptyWeekBanner.classList.remove('hidden');
    } else {
      emptyWeekBanner.classList.add('hidden');
    }

    // Render weekday cards and selected-day panel
    renderDays(aggregated, urlCheck.sanitizedUrl);
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
  const monday = new Date(currentMonday);
  const weekDays = getWeekDays(monday, new Date());
  const emptyAggregated = aggregateWorklogsByWeek([], weekDays);
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
 * Switches deployment type from the radio controls, swapping the token field
 * to the token remembered for the newly selected type.
 * @param {'cloud' | 'server'} type
 */
function switchDeploymentType(type) {
  const previousType = type === 'cloud' ? 'server' : 'cloud';
  tokensByType[previousType] = jiraTokenInput.value.trim();
  setDeploymentType(type);
  jiraTokenInput.value = tokensByType[type];
  invalidateConnectionStatus();
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
 *     token: string,
 *     originPattern: string
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
  const urlCheck = JiraUrlValidator.validate(rawUrl);
  if (!urlCheck.isValid) {
    showFieldError(jiraBaseUrlInput, urlError, urlCheck.error || 'Invalid URL.');
    isValid = false;
  }

  // 2. Cloud Email Validation
  if (deploymentType === 'cloud') {
    if (!email) {
      showFieldError(jiraEmailInput, emailError, 'Account email is required for Jira Cloud.');
      isValid = false;
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
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
      email: deploymentType === 'cloud' ? email : '',
      token,
      originPattern: urlCheck.originPattern
    }
  };
}

/**
 * Requests Chrome runtime host permission for the target Jira origin if not already granted.
 * @param {string} originPattern
 * @returns {Promise<boolean>}
 */
async function ensureHostPermission(_originPattern) {
  // Host access is declared as a required host_permission (https://*/*) in the manifest.
  // Required permissions are always granted and cannot be queried or requested via the
  // optional-permissions API. We return true unconditionally; if fetch() is still blocked
  // (e.g. the extension was not reloaded after the manifest change), the network layer
  // will throw a TypeError that surfaces a clear error message to the user.
  return true;
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

  const { baseUrl, deploymentType, email, token, originPattern } = formValidation.values;
  const testId = ++connectionTestId;

  renderStatus('loading');
  setBusy(true);

  try {
    const permissionGranted = await ensureHostPermission(originPattern);
    if (testId !== connectionTestId) return;
    if (!permissionGranted) {
      renderStatus('error', {
        error: `Permission to connect to "${originPattern}" was not granted. Timesheet for Jira requires host permission to reach your Jira instance.`
      });
      setBusy(false);
      return;
    }

    let provider;
    if (deploymentType === 'cloud') {
      provider = new JiraCloudTokenProvider(email, token);
    } else {
      provider = new JiraPatProvider(token);
    }

    const client = new JiraClient(baseUrl, provider);
    const result = await client.testConnection();
    // Settings changed while the test was running: the result no longer applies.
    if (testId !== connectionTestId) return;

    if (result.success) {
      hasUntestedChanges = false;
      renderStatus('success', result);

      if (isExtensionContext() && ext.storage && ext.storage.local) {
        ext.storage.local.set({
          lastTestResult: {
            success: true,
            user: result.user,
            serverInfo: result.serverInfo,
            testedAt: result.testedAt
          }
        });
      }
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

  const { baseUrl, deploymentType, email, token, originPattern } = formValidation.values;

  jiraBaseUrlInput.value = baseUrl;
  setBusy(true);

  try {
    const permissionGranted = await ensureHostPermission(originPattern);
    if (!permissionGranted) {
      renderStatus('error', {
        error: `Host permission was denied for ${originPattern}. Settings were not saved because Timesheet for Jira cannot access this domain.`
      });
      setBusy(false);
      return;
    }

    tokensByType[deploymentType] = token;

    if (isExtensionContext() && ext.storage && ext.storage.local) {
      await ext.storage.local.set({
        jiraBaseUrl: baseUrl,
        deploymentType,
        email,
        token,
        cloudToken: tokensByType.cloud,
        serverToken: tokensByType.server,
        savedAt: new Date().toISOString()
      });

      // Don't show the previous "Connection Successful" on next load for settings
      // that were changed and saved without being tested.
      if (hasUntestedChanges) {
        await ext.storage.local.remove('lastTestResult');
      }
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
  if (!isExtensionContext() || !ext.storage || !ext.storage.local) {
    loadAndRenderWorklogs({ initial: true });
    return;
  }

  try {
    const data = await ext.storage.local.get([
      'jiraBaseUrl',
      'deploymentType',
      'email',
      'token',
      'cloudToken',
      'serverToken',
      'lastTestResult'
    ]);

    // Settings saved before per-type tokens existed only have `token`,
    // which belongs to the saved deployment type.
    const savedType = data.deploymentType === 'server' ? 'server' : 'cloud';
    tokensByType.cloud = data.cloudToken ?? (savedType === 'cloud' ? data.token || '' : '');
    tokensByType.server = data.serverToken ?? (savedType === 'server' ? data.token || '' : '');

    if (data.deploymentType) {
      setDeploymentType(data.deploymentType);
    } else {
      setDeploymentType('cloud');
    }

    if (data.jiraBaseUrl) {
      jiraBaseUrlInput.value = data.jiraBaseUrl;
    }

    if (data.email) {
      jiraEmailInput.value = data.email;
    }

    jiraTokenInput.value = tokensByType[savedType];

    if (data.lastTestResult && data.lastTestResult.success) {
      renderStatus('success', data.lastTestResult);
    }

    // If no settings exist yet, default to settings tab, otherwise show weekly view
    const hasConfig = Boolean(data.jiraBaseUrl && data.token);
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
    const check = JiraUrlValidator.validate(val);
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

// Initialize on page load
document.addEventListener('DOMContentLoaded', loadSavedSettings);
