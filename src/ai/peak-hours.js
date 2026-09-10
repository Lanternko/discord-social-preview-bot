// DeepSeek bills double during its peak window, so the interactive chain
// prefers the flat-rate fallback (luna) while peak is in effect and keeps
// DeepSeek behind it as the tail safety net.
//
// The window is DeepSeek's, defined in UTC, and is NOT the bot's local time:
//   "Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday"
//   — https://api-docs.deepseek.com/quick_start/pricing
// In Asia/Taipei that reads 09:00-12:00 and 14:00-18:00 on weekdays, but the
// conversion is deliberately not hardcoded: DST-free UTC is the billing
// authority, and a local-time copy would silently drift if the host's zone
// ever changes.
const PEAK_UTC_HOURS = new Set([1, 2, 3, 6, 7, 8, 9]);

function isDeepSeekPeak(now = new Date()) {
  const weekday = now.getUTCDay(); // 0 = Sunday, 6 = Saturday
  if (weekday < 1 || weekday > 5) return false;
  return PEAK_UTC_HOURS.has(now.getUTCHours());
}

module.exports = { isDeepSeekPeak, PEAK_UTC_HOURS };
