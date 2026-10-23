export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Sim time is UTC milliseconds, read as house local time. */
export const iso = (t: number): string => new Date(t).toISOString().slice(0, 16);
export const dateOf = (t: number): string => new Date(t).toISOString().slice(0, 10);
export const monthOf = (t: number): string => new Date(t).toISOString().slice(0, 7);
export const parseTime = (s: string): number => Date.parse(s.length === 10 ? `${s}T00:00:00Z` : `${s.replace('Z', '')}Z`);
export const weekday = (t: number): number => new Date(t).getUTCDay(); // 0 = Sunday
export const isWeekend = (t: number): boolean => weekday(t) === 0 || weekday(t) === 6;
export const startOfDay = (t: number): number => t - (t % DAY);
export const hourOf = (t: number): number => new Date(t).getUTCHours() + new Date(t).getUTCMinutes() / 60;
export const atTime = (day: number, hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return startOfDay(day) + h * HOUR + m * MINUTE;
};

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

export function daysInMonth(month: string): number {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Midnight of a given day of the month, clamped to the month's length. */
export function dayInMonth(month: string, day: number): number {
  const d = Math.min(Math.max(1, day), daysInMonth(month));
  return parseTime(`${month}-${String(d).padStart(2, '0')}`);
}

export const endOfMonth = (month: string): number => dayInMonth(month, 31) + DAY - 1;

export function seasonOf(t: number): string {
  const d = new Date(t);
  return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}

/** Next working moment for a person who works on the given weekdays. */
export function nextWorkday(t: number, workDays: number[]): number {
  let d = startOfDay(t);
  for (let i = 0; i < 14; i++) {
    if (workDays.includes(weekday(d)) && d >= startOfDay(t)) return d;
    d += DAY;
  }
  return startOfDay(t);
}

export const hoursBetween = (a: number, b: number): number => (b - a) / HOUR;
export const daysBetween = (a: number, b: number): number => (b - a) / DAY;
