/**
 * The Connection Settings form's unsaved values (the "draft"), kept apart from the saved
 * settings. The saved settings (settingsStore.load()) are the active configuration; the draft
 * starts as a copy of them each time the form opens, takes the user's edits, and is written
 * back only by a successful save. Choosing another Jira edition changes only the draft.
 */

/**
 * Starts a draft from saved settings. The draft has its own copies of the per-edition values,
 * so editing it never changes the settings it came from.
 *
 * @param {{
 *   deploymentType: 'cloud' | 'server',
 *   email: string,
 *   baseUrlsByType: { cloud: string, server: string },
 *   tokensByType: { cloud: string, server: string }
 * }} saved - Normalized settings (see normalizeSettings())
 * @returns {{
 *   deploymentType: 'cloud' | 'server',
 *   email: string,
 *   baseUrlsByType: { cloud: string, server: string },
 *   tokensByType: { cloud: string, server: string }
 * }}
 */
export function createSettingsDraft(saved) {
  return {
    deploymentType: saved.deploymentType === 'server' ? 'server' : 'cloud',
    email: saved.email || '',
    baseUrlsByType: { cloud: saved.baseUrlsByType?.cloud || '', server: saved.baseUrlsByType?.server || '' },
    tokensByType: { cloud: saved.tokensByType?.cloud || '', server: saved.tokensByType?.server || '' }
  };
}

/**
 * Switches the draft to another edition. The instance URL and token in the form are kept for
 * the edition being left, so switching back restores them, and the new edition's values are
 * returned for the form.
 *
 * @param {ReturnType<typeof createSettingsDraft>} draft
 * @param {'cloud' | 'server'} type
 * @param {{ baseUrl: string, token: string }} fields - The form's current instance URL and token
 * @returns {{ baseUrl: string, token: string }} The values to show for `type`
 */
export function switchDraftEdition(draft, type, { baseUrl, token }) {
  draft.baseUrlsByType[draft.deploymentType] = baseUrl;
  draft.tokensByType[draft.deploymentType] = token;
  draft.deploymentType = type;
  return { baseUrl: draft.baseUrlsByType[type], token: draft.tokensByType[type] };
}
