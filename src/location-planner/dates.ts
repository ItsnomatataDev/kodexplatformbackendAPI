/** Calendar DATE columns arrive as local-midnight Date objects. Keep the local day. */
export function calendarDateKey(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function dateKey(value: unknown) {
  if (value instanceof Date) return calendarDateKey(value);
  return String(value ?? '').slice(0, 10);
}
