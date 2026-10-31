/**
 * Keyboard shortcuts: one registry for running shortcuts and for listing them in the
 * keyboard shortcuts drawer, so the drawer always shows exactly what is registered.
 *
 * A shortcut with a `handler` runs from the registry's keydown listener. One without a
 * handler documents a key that a component handles itself (such as Escape in the worklog
 * panel); the component declares it next to its handler and the page registers it.
 */

// Display order of categories; any other category follows, in registration order.
export const SHORTCUT_CATEGORIES = ['General', 'Day Navigation', 'Week Navigation', 'Navigation', 'Worklogs', 'Worklog form'];

// Words a key can be searched by, besides its label.
const KEY_NAMES = {
  '+': 'plus',
  '?': 'question mark',
  '/': 'slash',
  ',': 'comma',
  Esc: 'escape',
  Enter: 'return',
  '↑': 'up arrow',
  '↓': 'down arrow',
  '←': 'left arrow',
  '→': 'right arrow',
  Shift: 'shift',
  Ctrl: 'control',
  Alt: 'option',
  Cmd: 'command meta',
  '⌘': 'command cmd meta'
};

// Physical keys (KeyboardEvent.code) for characters, used only when a modifier shortcut is pressed
// on a layout where that key doesn't type the character (Ctrl+, on a Cyrillic layout gives "б").
const KEY_CODES = { ',': 'Comma', '.': 'Period', '/': 'Slash', ';': 'Semicolon' };

// Named keys a Shift or modifier shortcut can use, with how they're shown.
const NAMED_KEY_LABELS = { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓' };

/** The physical key for a character: punctuation from KEY_CODES, letters as KeyA to KeyZ. */
const keyCodeFor = (key) => KEY_CODES[key] ?? (/^[a-z]$/.test(key) ? `Key${key.toUpperCase()}` : undefined);

// Inputs that don't take typed text, so shortcuts still work while they have focus.
const NON_TEXT_INPUT_TYPES = new Set(['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file', 'image']);

/**
 * @typedef {object} Shortcut
 * @property {string} id - Stable identifier
 * @property {string} description - What it does, as shown in the drawer
 * @property {string} category - Group in the drawer (see SHORTCUT_CATEGORIES)
 * @property {string[][]} keys - Key combinations as shown, e.g. [['?']] or [['↑'], ['↓']] for alternatives,
 *   [['Ctrl', 'K']] for a combination
 * @property {string} [key] - With a handler: the character or key name it runs on (`KeyboardEvent.key`), so it
 *   follows the keyboard layout (`?` is Shift+/ on some layouts and a key of its own on others)
 * @property {boolean} [mod] - With a handler: also needs the platform's primary modifier, ⌘ on macOS and Ctrl
 *   elsewhere. Its keys are then shown from the binding (⌘ , or Ctrl ,; Ctrl ← for an arrow key) and can be
 *   left out. With an arrow key, an extra Shift doesn't count (Ctrl+Shift+arrow selects text by word) unless
 *   the shortcut also sets `shift`: then it needs both (shown as Ctrl Shift ← or ⌘ Shift ←)
 * @property {boolean} [shift] - With a handler and a lowercase letter `key` (or an arrow key, `ArrowLeft` …): needs
 *   Shift with that key, a letter in either case (Caps Lock turns Shift+T into "t"). Its keys are then shown from
 *   the binding (Shift T, Shift ←)
 * @property {() => boolean} [when] - Whether it's available now; unavailable shortcuts neither run nor show
 * @property {(event: KeyboardEvent) => (void | false)} [handler] - Runs the shortcut; returns false when there was
 *   nothing to do, so the key keeps its default (Escape with no panel open, say)
 */

/**
 * The platform shortcuts are shown and matched for: 'mac' (⌘ is the primary modifier) or 'other' (Ctrl).
 * @param {Navigator} [nav]
 * @returns {'mac' | 'other'}
 */
export function detectPlatform(nav = globalThis.navigator) {
  const name = nav?.userAgentData?.platform || nav?.platform || '';
  return /mac|iphone|ipad/i.test(name) ? 'mac' : 'other';
}

/**
 * Returns true when keys pressed on `target` are typed text: a text field, a select, or
 * editable content. Checkboxes, radio buttons, and buttons aren't.
 * @param {EventTarget | null} target
 * @returns {boolean}
 */
export function isTypingTarget(target) {
  if (target?.isContentEditable) return true;
  const field = target?.closest?.('input, textarea, select, [contenteditable]');
  if (!field) return false;
  return !(field.localName === 'input' && NON_TEXT_INPUT_TYPES.has(String(field.getAttribute('type') || 'text').toLowerCase()));
}

/**
 * Creates an empty shortcut registry.
 * @param {object} [options]
 * @param {'mac' | 'other'} [options.platform] - Defaults to detectPlatform()
 */
export function createShortcutRegistry({ platform = detectPlatform() } = {}) {
  /** @type {Map<string, Shortcut>} */
  const shortcuts = new Map();
  const modLabel = platform === 'mac' ? '⌘' : 'Ctrl';

  /**
   * True when a key press is for this shortcut's key: by character (either case for a Shift shortcut),
   * or for a modifier or Shift shortcut on a layout that types another character, by physical key.
   */
  const matchesKey = (shortcut, event) => {
    const letter = /^[a-z]$/.test(shortcut.key);
    if (shortcut.shift && letter ? event.key.toLowerCase() === shortcut.key : event.key === shortcut.key) return true;
    return Boolean(shortcut.mod || shortcut.shift) && !/^[\x21-\x7e]$/.test(event.key) &&
      Boolean(keyCodeFor(shortcut.key)) && event.code === keyCodeFor(shortcut.key);
  };

  return {
    /**
     * Adds a shortcut. Rejects a duplicate id, and a second handler for the same key.
     * @param {Shortcut} shortcut
     * @returns {() => void} Removes the shortcut again
     */
    register(shortcut) {
      const { id, description, category, key, handler, mod, shift } = shortcut;
      if (mod && !key) throw new Error(`Shortcut "${id}" needs a modifier but has no key.`);
      if (shift && !/^[a-z]$/.test(key ?? '') && !NAMED_KEY_LABELS[key]) {
        throw new Error(`Shortcut "${id}" needs Shift with a lowercase letter key or an arrow key.`);
      }
      // A modifier or Shift shortcut is shown exactly as it's bound (on this platform).
      const label = NAMED_KEY_LABELS[key];
      const keys = shortcut.keys ?? (mod && shift ? [[modLabel, 'Shift', label ?? key.toUpperCase()]]
        : mod ? [[modLabel, label ?? key]] : shift ? [['Shift', label ?? key.toUpperCase()]] : undefined);
      if (!id || !description || !category || !Array.isArray(keys) || keys.length === 0 || keys.some((combo) => !Array.isArray(combo) || combo.length === 0)) {
        throw new Error(`Shortcut "${id}" needs an id, a description, a category, and keys.`);
      }
      if (shortcuts.has(id)) throw new Error(`Shortcut "${id}" is already registered.`);
      if (handler && !key) throw new Error(`Shortcut "${id}" has a handler but no key to run on.`);
      for (const other of shortcuts.values()) {
        if (handler && other.handler && other.key === key && Boolean(other.mod) === Boolean(mod) && Boolean(other.shift) === Boolean(shift)) {
          throw new Error(`Shortcut "${id}" runs on "${key}", which "${other.id}" already uses.`);
        }
      }
      shortcuts.set(id, Object.freeze({ ...shortcut, keys: keys.map((combo) => [...combo]) }));
      return () => { shortcuts.delete(id); };
    },

    /**
     * Shortcuts available now (their `when()` passes), in registration order.
     * @returns {Shortcut[]}
     */
    list() {
      return [...shortcuts.values()].filter((shortcut) => !shortcut.when || shortcut.when());
    },

    /**
     * Runs the shortcut for a key press, if one applies: a registered key with a handler,
     * available now, not held down, not while composing text, not typed into a field, and not
     * already handled by the element that has focus. Plain shortcuts need no Ctrl, Alt, or Meta
     * (Shift is part of typing `?` or `+`); `mod` shortcuts need exactly the platform's primary
     * modifier (⌘ on macOS, Ctrl elsewhere) and no Alt (nor Shift, with an arrow key); `shift`
     * shortcuts need Shift and no other modifier.
     * @param {KeyboardEvent} event
     * @returns {boolean} True when a shortcut ran (the event's default is then prevented); false when none
     *   applied, or its handler returned false
     */
    handleKeydown(event) {
      if (event.defaultPrevented || event.altKey || event.repeat || event.isComposing) return false;
      const primary = platform === 'mac' ? event.metaKey : event.ctrlKey;
      const secondary = platform === 'mac' ? event.ctrlKey : event.metaKey;
      if (secondary) return false;
      if (isTypingTarget(event.target)) return false;
      const shortcut = [...shortcuts.values()].find((s) => s.handler && Boolean(s.mod) === primary &&
        (!s.shift || event.shiftKey) && !(s.mod && !s.shift && NAMED_KEY_LABELS[s.key] && event.shiftKey) &&
        matchesKey(s, event) && (!s.when || s.when()));
      if (!shortcut || shortcut.handler(event) === false) return false;
      event.preventDefault();
      return true;
    },

    /**
     * Runs shortcuts for key presses on `target` (the document).
     * @param {EventTarget} target
     * @returns {() => void} Removes the listener
     */
    listen(target) {
      const listener = (event) => this.handleKeydown(event);
      target.addEventListener('keydown', listener);
      return () => target.removeEventListener('keydown', listener);
    }
  };
}

/**
 * Groups shortcuts by category, in SHORTCUT_CATEGORIES order, keeping only those that match
 * the search. A shortcut matches when every word of the query appears in its description,
 * its category, or its keys (by label, e.g. "Esc", or name, e.g. "escape").
 *
 * @param {Shortcut[]} shortcuts
 * @param {string} [query]
 * @returns {Array<{ category: string, shortcuts: Shortcut[] }>} Only non-empty categories
 */
export function groupShortcuts(shortcuts, query = '') {
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  const searchText = (shortcut) => [
    shortcut.description,
    shortcut.category,
    ...shortcut.keys.flat().flatMap((label) => [label, KEY_NAMES[label] || ''])
  ].join(' ').toLowerCase();

  const groups = new Map(SHORTCUT_CATEGORIES.map((category) => [category, []]));
  for (const shortcut of shortcuts) {
    const text = searchText(shortcut);
    if (!words.every((word) => text.includes(word))) continue;
    if (!groups.has(shortcut.category)) groups.set(shortcut.category, []);
    groups.get(shortcut.category).push(shortcut);
  }
  return [...groups].filter(([, list]) => list.length > 0).map(([category, list]) => ({ category, shortcuts: list }));
}
