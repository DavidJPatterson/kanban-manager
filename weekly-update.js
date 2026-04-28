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

// ─── Carry-over detection ────────────────────────────────────────────────────

function _normaliseActionText(s) {
  return (s || '').trim().toLowerCase()
}

// Mutates each action in `currentActions` to set carriedFrom = prevWeekKey
// when the same text appears in `prevWeekActions` (case-insensitive, trimmed).
function detectCarryOver(currentActions, prevWeekActions, prevWeekKey) {
  const prevTexts = new Set((prevWeekActions || []).map(a => _normaliseActionText(a.text)))
  for (const a of currentActions) {
    if (prevTexts.has(_normaliseActionText(a.text))) {
      a.carriedFrom = prevWeekKey
    }
  }
  return currentActions
}

// Walk backwards through allWeeklyUpdates following carriedFrom links;
// returns the count of consecutive prior weeks that contain the same text
// for the SAME pod. Cross-pod text collisions are intentionally ignored —
// a chain is per-pod state, not a global text match.
function carryChainLength(action, allWeeklyUpdates, podId) {
  let length = 0
  const textKey = _normaliseActionText(action.text)
  let prevKey = action.carriedFrom
  while (prevKey && allWeeklyUpdates[prevKey]) {
    const prevWeek = allWeeklyUpdates[prevKey]
    const prevActions = prevWeek.pods?.[podId]?.actions || []
    const foundInPrev = prevActions.find(prev => _normaliseActionText(prev.text) === textKey)
    if (!foundInPrev) break
    length++
    prevKey = foundInPrev.carriedFrom
  }
  return length
}

// ─── Suggestion engine ───────────────────────────────────────────────────────

// Returns { wins: Suggestion[], issues: Suggestion[], actions: Suggestion[] }
// where Suggestion = { key: string, type: 'positive'|'warning'|'blocker'|'info', text: string }
//
// Wraps existing calc* functions; thresholds match calcExecInsights.
//
// Param notes:
//   _cachedData — reserved for pod-health history (predictability / health-drop
//                 suggestions). Deferred to a follow-up task.
//   _holidays   — reserved for holiday-adjusted throughput baseline. Deferred.
//
// Spec deviations to address in a follow-up:
//   - win-zero-aged currently fires whenever today's aged count is zero.
//     Spec §6.3 says it should only fire when the prior week had ≥ 3 aged
//     items. Implementing that gate requires access to allWeeklyUpdates
//     (or last-week's pod data); deferred until the function signature is
//     extended.
function buildSuggestions(pod, _cachedData, settings, _holidays) {
  const items = pod.items || []
  const wins = []
  const issues = []
  const actions = []
  const staleDays = settings.staleDays || 2

  // — Throughput trend —
  // Compare last completed week vs the 4 weeks immediately preceding it.
  // calcWeeklyThroughput always returns 8 buckets oldest-first; tp[6] is the
  // last completed week (tp[7] is the current incomplete one). The 4-week
  // baseline is buckets [2..5] inclusive, i.e. tp.slice(-6, -2).
  const tp = calcWeeklyThroughput(items, 8)
  const baselineBuckets = tp.slice(-6, -2)
  const baseline = baselineBuckets.reduce((s, w) => s + w.count, 0) / 4
  const last = tp[tp.length - 2]?.count || 0
  if (baseline > 0) {
    const delta = (last - baseline) / baseline
    if (delta >= 0.25) {
      wins.push({ key: 'win-throughput-up', type: 'positive',
        text: `Throughput up ${Math.round(delta * 100)}% vs 4-wk baseline (${last} vs ${baseline.toFixed(1)})` })
    } else if (delta <= -0.25) {
      issues.push({ key: 'issue-throughput-down', type: 'warning',
        text: `Throughput down ${Math.round(Math.abs(delta) * 100)}% vs 4-wk baseline (${last} vs ${baseline.toFixed(1)})` })
    }
  }

  // — Stale items + Triage actions —
  const stale = calcStaleItems(items, staleDays)
  if (stale.total > 0) {
    issues.push({ key: 'issue-stale-count', type: 'warning',
      text: `${stale.total} stale item${stale.total === 1 ? '' : 's'} (≥ ${staleDays} days no change)` })
  }
  for (const it of stale.items) {
    if (it.staleDaysActual >= 7) {
      actions.push({
        key: `action-triage-stale-${it.id}`, type: 'info',
        text: `Triage stale item: #${it.id} ${it.title || ''}`.trim()
      })
    }
  }

  // — Aged > 7d —
  // Use the same in-scope state set as the stale-item calc so the count
  // and the per-item triage actions stay consistent.
  const aged = items.filter(i => !NON_STALE_STATES.has(i.state)).filter(i => {
    const created = i.arrivedAt || i.created
    return created && (Date.now() - new Date(created).getTime()) >= 7 * 86400000
  })
  if (aged.length === 0 && items.some(i => i.changedDate)) {
    wins.push({ key: 'win-zero-aged', type: 'positive', text: 'Zero items aged >7 days' })
  } else if (aged.length > 0) {
    issues.push({ key: 'issue-aged-count', type: 'warning',
      text: `${aged.length} item${aged.length === 1 ? '' : 's'} aged >7 days` })
  }

  // — P1/P2 unassigned —
  for (const i of items) {
    if (!['Closed', 'Removed'].includes(i.state) &&
        (i.priority === 1 || i.priority === 2) && !i.assignee) {
      actions.push({
        key: `action-assign-owner-${i.id}`, type: 'info',
        text: `Assign owner to P${i.priority}: #${i.id} ${i.title || ''}`.trim()
      })
    }
  }

  return { wins, issues, actions }
}
