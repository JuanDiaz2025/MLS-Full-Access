// Utilities.formatDate for the patterns the scripts use, with Node's Intl.
function formatDate(d, tz, pat) {
  const parts = {};
  new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' })
    .formatToParts(d).forEach(p => { parts[p.type] = p.value; });
  if (pat === 'Z') {
    const s = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(d).find(p => p.type === 'timeZoneName').value;
    const m = /GMT([+-])(\d\d):(\d\d)/.exec(s);
    return m ? m[1] + m[2] + m[3] : '+0000';
  }
  if (pat === 'H') return String(Number(parts.hour));
  if (pat === 'yyyy-MM-dd') return `${parts.year}-${parts.month}-${parts.day}`;
  if (pat === 'yyyy/MM/dd') return `${parts.year}/${parts.month}/${parts.day}`;
  const mon = new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short' }).format(d);
  const day = Number(parts.day), h = Number(parts.hour);
  if (pat === 'MMM d, h:mm a') return `${mon} ${day}, ${h % 12 || 12}:${parts.minute} ${h < 12 ? 'AM' : 'PM'}`;
  if (pat === 'EEE, MMM d') return `${parts.weekday}, ${mon} ${day}`;
  throw new Error('formatDate pattern not faked: ' + pat);
}
module.exports = { formatDate };
