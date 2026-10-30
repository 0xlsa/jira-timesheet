import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../options.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../options.css', import.meta.url), 'utf8');

const form = html.slice(html.indexOf('<form id="settingsForm"'), html.indexOf('</form>'));
const at = (marker) => {
  const index = form.indexOf(marker);
  assert.ok(index >= 0, `missing ${marker}`);
  return index;
};
/** The declarations of a CSS rule, by its exact selector. */
const rule = (selector) => css.match(new RegExp(`^${selector.replace('.', '\\.')} \\{([^}]*)\\}`, 'm'))?.[1] ?? '';

describe('Connection Settings layout - section dividers', () => {
  it('separates Jira Edition and connection, Additional Assignment Fields, and Public Holidays with a divider each', () => {
    const dividers = [...form.matchAll(/<hr class="settings-divider">/g)].map((match) => match.index);
    assert.equal(dividers.length, 2);
    const [first, second] = dividers;
    assert.ok(at('id="typeCloud"') < first);
    assert.ok(at('id="connectionSection"') < first);
    assert.ok(first < at('id="assignmentFieldsTitle"') && at('id="assignmentFieldsStatus"') < second);
    assert.ok(second < at('id="publicHolidaysEnabled"'));
  });

  it('adds no divider inside the collapsible connection details', () => {
    const section = form.slice(at('id="connectionSection"'), form.indexOf('</section>', at('id="connectionSection"')));
    assert.doesNotMatch(section, /<hr|settings-divider/);
  });

  it('draws the dividers as a thin subtle border, spaced like About', () => {
    const divider = rule('.settings-divider');
    const about = rule('.settings-about');
    assert.match(divider, /border: 0;/);
    assert.match(divider, /border-top: 1px solid var\(--border-subtle\);/);
    assert.match(about, /border-top: 1px solid var\(--border-subtle\);/);
    assert.match(divider, /margin: 0 0 18px;/);
    assert.match(about, /padding-top: 18px;/);
  });

  it('keeps About last, set off by its own border, with nothing after it', () => {
    const about = html.indexOf('id="aboutSection"');
    assert.ok(about > html.indexOf('</form>'));
    // No separate divider before About: its border-top is the divider.
    assert.doesNotMatch(html.slice(html.indexOf('</form>'), about), /<hr/);
    assert.match(html.slice(about), /^id="aboutSection"[^>]*><\/section>\s*<\/div>\s*<\/div>\s*<\/aside>/);
  });
});
