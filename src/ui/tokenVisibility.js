/**
 * Show / hide control for the API token field on the Settings tab.
 *
 * The token is masked whenever the page loads, the user leaves the Settings tab, or the
 * browser tab is hidden. Visibility lives only in the DOM; it is never persisted, and
 * masking only changes the input type, so the entered token is left untouched.
 */

const LABELS = {
  show: 'Show API token',
  hide: 'Hide API token'
};

/**
 * Wires the eye button to the token input and returns controls for the page to mask it.
 *
 * @param {{ input: HTMLInputElement, button: HTMLButtonElement, showIcon: Element, hideIcon: Element }} elements
 * @returns {{ isVisible: () => boolean, setVisible: (visible: boolean) => void, mask: () => void }}
 */
export function createTokenVisibilityToggle({ input, button, showIcon, hideIcon }) {
  const isVisible = () => input.type === 'text';

  function setVisible(visible) {
    input.type = visible ? 'text' : 'password';
    // The eye shows what a click will do: open eye to reveal, crossed-out eye to hide.
    showIcon.classList.toggle('hidden', visible);
    hideIcon.classList.toggle('hidden', !visible);
    const label = visible ? LABELS.hide : LABELS.show;
    button.setAttribute('aria-label', label);
    button.setAttribute('title', label);
  }

  button.addEventListener('click', () => setVisible(!isVisible()));
  setVisible(false);

  return { isVisible, setVisible, mask: () => setVisible(false) };
}
