// weekly-update.js — Weekly status update lifecycle:
// storage, week math, carry-over detection, suggestion engine.

// ─── Constants ────────────────────────────────────────────────────────────────

const WEEKLY_UPDATE_STORAGE_KEY = 'weeklyUpdates'

// ─── Week math ────────────────────────────────────────────────────────────────

// Returns the ISO week key for a date as "YYYY-Www" (e.g. "2026-W17").
function weekKeyFor(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  // ISO week: shift to Thursday of the same week, then compute year and week
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7))
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const weekNum = Math.ceil((((d - yearStart) / 86400000) + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`
}

// Returns the Monday and Sunday of an ISO week key, plus a display label.
function weekRange(weekKey) {
  const m = /^(\d{4})-W(\d{2})$/.exec(weekKey)
  if (!m) throw new Error(`Invalid week key: ${weekKey}`)
  const year = parseInt(m[1], 10)
  const week = parseInt(m[2], 10)
  // ISO week 1 is the week containing 4 January
  const jan4 = new Date(Date.UTC(year, 0, 4))
  const jan4Day = jan4.getUTCDay() || 7
  const week1Monday = new Date(jan4)
  week1Monday.setUTCDate(jan4.getUTCDate() - (jan4Day - 1))
  const start = new Date(week1Monday)
  start.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7)
  const end = new Date(start)
  end.setUTCDate(start.getUTCDate() + 6)
  end.setUTCHours(23, 59, 59, 999)
  const fmt = { day: 'numeric', month: 'short' }
  const label = `${start.toLocaleDateString('en-GB', fmt)} – ${end.toLocaleDateString('en-GB', { ...fmt, year: 'numeric' })}`
  return { start, end, label }
}

function getCurrentWeekKey() {
  return weekKeyFor(new Date())
}

function getLastCompletedWeekKey() {
  const now = new Date()
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000)
  return weekKeyFor(sevenDaysAgo)
}

// ─── Storage helpers ──────────────────────────────────────────────────────────

function emptyWeekShape(weekKey) {
  const r = weekRange(weekKey)
  return {
    weekStart: r.start.toISOString().slice(0, 10),
    weekEnd:   r.end.toISOString().slice(0, 10),
    finalisedAt: null,
    unitHeadline: { wins: [], issues: [], actions: [] },
    pods: {}
  }
}

function emptyPodShape() {
  return {
    steady: false,
    progress: [],
    issues: [],
    actions: [],
    suggestionsState: { promoted: [], dismissed: [] }
  }
}

function getAllWeeklyUpdates() {
  return new Promise(resolve =>
    chrome.storage.local.get(WEEKLY_UPDATE_STORAGE_KEY, r =>
      resolve(r[WEEKLY_UPDATE_STORAGE_KEY] || {})))
}

function getWeeklyUpdate(weekKey) {
  return getAllWeeklyUpdates().then(all => all[weekKey] || emptyWeekShape(weekKey))
}

function setWeeklyUpdate(weekKey, data) {
  return getAllWeeklyUpdates().then(all => {
    all[weekKey] = data
    return new Promise(resolve =>
      chrome.storage.local.set({ [WEEKLY_UPDATE_STORAGE_KEY]: all }, resolve))
  })
}

function listWeeks() {
  return getAllWeeklyUpdates().then(all => {
    const keys = new Set(Object.keys(all))
    keys.add(getCurrentWeekKey())  // always include current week even if not yet stored
    return [...keys].sort().reverse()
  })
}
