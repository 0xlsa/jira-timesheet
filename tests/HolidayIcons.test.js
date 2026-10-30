import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyHoliday, buildHolidayIndicators, westernEaster, orthodoxEaster, HOLIDAY_ICONS } from '../src/holidays/holidayIcons.js';

const isoDate = (time) => new Date(time).toISOString().slice(0, 10);

describe('Holiday icons', () => {
  it('computes Western and Orthodox Easter', () => {
    assert.equal(isoDate(westernEaster(2025)), '2025-04-20');
    assert.equal(isoDate(westernEaster(2026)), '2026-04-05');
    assert.equal(isoDate(westernEaster(2027)), '2027-03-28');
    assert.equal(isoDate(orthodoxEaster(2025)), '2025-04-20');
    assert.equal(isoDate(orthodoxEaster(2026)), '2026-04-12');
    assert.equal(isoDate(orthodoxEaster(2027)), '2027-05-02');
  });

  it('classifies holidays by their date, when the name agrees', () => {
    const cases = [
      ['2026-12-25', 'Christmas Day', 'christmas'],
      ['2026-01-07', 'Orthodox Christmas Day', 'christmas'],
      ['2026-04-05', 'Easter Sunday', 'easter'],
      ['2026-04-06', 'Easter Monday', 'easter'],
      ['2026-04-03', 'Good Friday', 'goodFriday'],
      ['2026-04-10', 'Orthodox Good Friday', 'goodFriday'],
      ['2026-04-13', 'Orthodox Easter Monday', 'easter'],
      ['2026-01-01', "New Year's Day", 'newYear'],
      ['2026-05-01', 'Labour Day', 'labour'],
      ['2026-09-07', 'Labor Day', 'labour']
    ];
    for (const [date, name, kind] of cases) assert.equal(classifyHoliday({ date, name }), kind, `${date} ${name}`);
  });

  it('uses the generic icon when the date and the name do not agree', () => {
    // Another holiday on Christmas's date, and holidays named like a rule on another date.
    assert.equal(classifyHoliday({ date: '2026-12-25', name: 'Quaid-e-Azam Day' }), 'other');
    assert.equal(classifyHoliday({ date: '2026-10-26', name: 'Labour Day' }), 'other');
    assert.equal(classifyHoliday({ date: '2026-04-20', name: 'Easter Monday' }), 'other');
    assert.equal(classifyHoliday({ date: '2026-06-02', name: 'Festa della Repubblica' }), 'other');
    assert.equal(classifyHoliday({ date: 'not a date', name: 'Christmas Day' }), 'other');
  });

  it('shows one icon per date, with every distinct name in the tooltip', () => {
    const indicators = buildHolidayIndicators([
      { date: '2026-12-25', name: 'Quaid-e-Azam Day' },
      { date: '2026-12-25', name: 'Christmas Day' },
      { date: '2026-12-25', name: 'Christmas Day' },
      { date: '2026-06-02', name: 'Republic Day' }
    ]);
    assert.equal(indicators.size, 2);
    assert.deepEqual(indicators.get('2026-12-25'), { icon: HOLIDAY_ICONS.christmas, label: 'Quaid-e-Azam Day / Christmas Day' });
    assert.deepEqual(indicators.get('2026-06-02'), { icon: '🎉', label: 'Republic Day' });
  });

  it('maps each kind to its icon', () => {
    assert.deepEqual(HOLIDAY_ICONS, { christmas: '🎄', easter: '🐰', goodFriday: '✝️', newYear: '🎆', labour: '⚒️', other: '🎉' });
  });
});
