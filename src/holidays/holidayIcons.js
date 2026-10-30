/**
 * Which icon a public holiday gets on the weekly timesheet.
 *
 * A holiday is classified by an explicit date rule (Christmas on 25 December or, in the Orthodox
 * calendar, 7 January; Easter computed for the year; and so on) and only when its English name
 * agrees, so another holiday that happens to fall on the same date isn't mislabeled. Anything
 * else, including holidays these rules don't cover, gets the generic icon. Only holidays the API
 * returned for the selected country are ever classified: nothing here adds a holiday.
 */

export const HOLIDAY_ICONS = {
  christmas: '🎄',
  easter: '🐰',
  goodFriday: '✝️',
  newYear: '✨',
  labour: '⚒️',
  other: '🎉'
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** UTC midnight of a Gregorian date, as epoch milliseconds. */
const utcDay = (year, month, day) => Date.UTC(year, month - 1, day);

/** Western (Gregorian) Easter Sunday, anonymous Gregorian algorithm. */
export function westernEaster(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return utcDay(year, month, day);
}

/** Orthodox Easter Sunday (Julian computus, Meeus), as a Gregorian date. */
export function orthodoxEaster(year) {
  const d = (19 * (year % 19) + 15) % 30;
  const e = (2 * (year % 4) + 4 * (year % 7) - d + 34) % 7;
  const month = Math.floor((d + e + 114) / 31);
  const day = ((d + e + 114) % 31) + 1;
  // Days the Julian calendar is behind the Gregorian one in March and April of `year`.
  const julianOffset = Math.floor(year / 100) - Math.floor(year / 400) - 2;
  return utcDay(year, month, day + julianOffset);
}

/** First Monday of September (Labor Day in the United States and Canada). */
function firstMondayOfSeptember(year) {
  const first = new Date(utcDay(year, 9, 1));
  return utcDay(year, 9, 1 + ((8 - first.getUTCDay()) % 7));
}

/**
 * @param {string} date - YYYY-MM-DD
 * @returns {{ year: number, time: number, monthDay: string } | null}
 */
function parseDate(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const year = Number(match[1]);
  return { year, time: utcDay(year, Number(match[2]), Number(match[3])), monthDay: `${match[2]}-${match[3]}` };
}

// Each rule: does the date fit, and does the name agree. Checked in this order.
const RULES = [
  {
    kind: 'goodFriday',
    date: ({ year, time }) => time === westernEaster(year) - 2 * DAY_MS || time === orthodoxEaster(year) - 2 * DAY_MS,
    name: /good friday|holy friday|great friday/i
  },
  {
    kind: 'easter',
    date: ({ year, time }) => [westernEaster(year), orthodoxEaster(year)].some((easter) => time === easter || time === easter + DAY_MS),
    name: /easter/i
  },
  {
    kind: 'christmas',
    date: ({ monthDay }) => monthDay === '12-25' || monthDay === '01-07',
    name: /christmas|nativity/i
  },
  {
    kind: 'newYear',
    date: ({ monthDay }) => monthDay === '01-01',
    name: /new year/i
  },
  {
    kind: 'labour',
    date: ({ year, time, monthDay }) => monthDay === '05-01' || time === firstMondayOfSeptember(year),
    name: /labou?r|workers/i
  }
];

/**
 * @param {{ date: string, name: string }} holiday
 * @returns {keyof HOLIDAY_ICONS}
 */
export function classifyHoliday({ date, name }) {
  const parsed = parseDate(date);
  if (!parsed) return 'other';
  return RULES.find((rule) => rule.date(parsed) && rule.name.test(name))?.kind ?? 'other';
}

/**
 * One indicator per date: the icon of the first classified holiday that day (else the generic
 * one), and every distinct name, for the tooltip.
 *
 * @param {Array<{ date: string, name: string }>} holidays
 * @returns {Map<string, { icon: string, label: string }>} By YYYY-MM-DD date
 */
export function buildHolidayIndicators(holidays) {
  const byDate = new Map();
  for (const holiday of holidays) {
    const entry = byDate.get(holiday.date) ?? { kinds: [], names: [] };
    entry.kinds.push(classifyHoliday(holiday));
    if (!entry.names.includes(holiday.name)) entry.names.push(holiday.name);
    byDate.set(holiday.date, entry);
  }
  const indicators = new Map();
  for (const [date, { kinds, names }] of byDate) {
    const kind = kinds.find((k) => k !== 'other') ?? 'other';
    indicators.set(date, { icon: HOLIDAY_ICONS[kind], label: names.join(' / ') });
  }
  return indicators;
}
