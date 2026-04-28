# Weekly Pod Status Update — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a structured weekly pod-status update flow to the Executive Summary tab — Unit-level Headline + per-pod Progress/Issues/Actions, ISO-week history, team-lead ownership, native-print PDF export, and a widening of the stale-state calculation. Spec: `docs/superpowers/specs/2026-04-28-weekly-pod-status-update-design.md`.

**Architecture:** Per-ISO-week records in a new `weeklyUpdates` storage key. New `weekly-update.js` module (storage, week math, carry-over, suggestion engine). UI restructure inside the existing `buildExecutiveSummaryPanel` in `board.js`. Settings additions for Unit Name and Team Leads. PDF export via a standalone `print-export.html` page launched in a new tab and printed natively. No new dependencies.

**Tech Stack:** Vanilla ES6+ JavaScript (no build, no semicolons in new code), Chrome MV3, `chrome.storage.local`, `chrome.tabs`, `window.print()`. Existing custom test runner (`test.js` + `test-node.js`) for pure-function TDD. Manual verification for DOM/UI work.

**Branch:** `claude/weekly-pod-status` (already created; spec already committed at `acae641`).

**Project conventions to honour:**
- No semicolons in new files; match existing style when editing files that already use semicolons.
- All HTML inserted via template strings must use `escHtml()` / `escAttr()` from `shared.js` for any data-derived content.
- The `$(id)` helper is `document.getElementById(id)`.
- Test framework runs in CI via `node test-node.js`. Add tests for every pure function added.
- Trace every consumer of widened/changed data before concluding a task is done.

---

## File structure

### New files

| File | Responsibility | Approx LoC |
|------|---------------|------------|
| `weekly-update.js` | Storage helpers, week math, carry-over detection, suggestion engine | ~300 |
| `print-export.html` | Standalone print page (loaded as `chrome.runtime.getURL`) | ~30 |
| `print-export.js` | Reads `?week=…`, renders PDF layout, calls `window.print()` | ~280 |
| `print-export.css` | A4 portrait print stylesheet | ~150 |

### Edited files

| File | Change |
|------|--------|
| `shared.js` | `STORAGE_KEYS.weeklyUpdates`, `DEFAULT_SETTINGS.unitName/teamLeads`, widened `calcStaleItems` returning `currentState`. |
| `board.html` | Load `weekly-update.js` before `board.js`. |
| `board.js` | Restructure `buildExecutiveSummaryPanel`: week selector, status badge, unit headline, per-pod structured-update sections, auto-suggestions block, owner picker, promote-to-headline, Steady checkbox, finalise/unlock, re-export PDF. |
| `options.html` | Unit Name input + Team Leads management section. |
| `options.js` | Wire Unit Name + Team Leads CRUD to settings. |
| `popup.js` | Verify it still renders correctly after stale-calc widening. |
| `manifest.json` | Add `print-export.html` to `web_accessible_resources`. |
| `test.js` | New test groups for stale widening, week math, carry-over, suggestion keys. |
| `CHANGELOG.md` | Entry for the feature + breaking-change note for stale calc. |

---

## Phase 1 — Foundation (testable pure code)

### Task 1: Widen `calcStaleItems` (TDD)

**Files:**
- Modify: `shared.js:727-769` (`calcStaleItems` function)
- Test: `test.js` (new test group)

- [ ] **Step 1: Write failing tests for the widened state set.**

Add to `test.js` after the existing groups (find a spot before any DOM-dependent tests):

```javascript
// ─── calcStaleItems widening ──────────────────────────────────────────────────

group('calcStaleItems — widened state set')

test('includes Resolved items past threshold', () => {
  const items = [
    makeItem({ id: 1, state: 'Resolved', changedDate: daysAgo(5) }),
    makeItem({ id: 2, state: 'Active',   changedDate: daysAgo(5) })
  ]
  const r = calcStaleItems(items, 2)
  assertEqual(r.total, 2, 'Resolved + Active both stale')
  assert(r.items.some(i => i.id === 1), 'Resolved item present')
})

test('includes QA Complete items past threshold', () => {
  const items = [makeItem({ id: 1, state: 'QA Complete', changedDate: daysAgo(10) })]
  const r = calcStaleItems(items, 2)
  assertEqual(r.total, 1)
})

test('excludes Closed items', () => {
  const items = [makeItem({ id: 1, state: 'Closed', changedDate: daysAgo(20) })]
  const r = calcStaleItems(items, 2)
  assertEqual(r.total, 0)
})

test('excludes Removed items', () => {
  const items = [makeItem({ id: 1, state: 'Removed', changedDate: daysAgo(20) })]
  const r = calcStaleItems(items, 2)
  assertEqual(r.total, 0)
})

test('excludes Triage items even when very old', () => {
  const items = [makeItem({ id: 1, state: 'Triage', changedDate: daysAgo(20) })]
  const r = calcStaleItems(items, 2)
  assertEqual(r.total, 0)
})

test('excludes New items even when very old', () => {
  const items = [makeItem({ id: 1, state: 'New', changedDate: daysAgo(20) })]
  const r = calcStaleItems(items, 2)
  assertEqual(r.total, 0)
})

test('returned items expose currentState', () => {
  const items = [makeItem({ id: 1, state: 'Resolved', changedDate: daysAgo(5) })]
  const r = calcStaleItems(items, 2)
  assertEqual(r.items[0].currentState, 'Resolved')
})

test('blocked items in Resolved state included', () => {
  const items = [makeItem({
    id: 1, state: 'Resolved', boardColumn: 'Blocked',
    changedDate: daysAgo(0)  // not stale by age, but blocked
  })]
  const r = calcStaleItems(items, 2)
  assertEqual(r.total, 1)
  assertEqual(r.blocked, 1)
})
```

- [ ] **Step 2: Run tests to verify they fail.**

```bash
node test-node.js 2>&1 | grep -E "FAIL|PASS|calcStaleItems" | head -20
```

Expected: new tests FAIL (the function still filters to `state === 'Active'`).

- [ ] **Step 3: Modify `calcStaleItems` in `shared.js`.**

Replace lines 727-769 with:

```javascript
const NON_STALE_STATES = new Set(['Closed', 'Removed', 'Triage', 'New']);

function calcStaleItems(items, staleDays = 2) {
  const cutoff = Date.now() - staleDays * 86400000;
  const inScope = items.filter(i => !NON_STALE_STATES.has(i.state));

  // Stale: in-scope items with no change beyond threshold
  const stale = inScope.filter(i => {
    const changed = i.changedDate ? new Date(i.changedDate).getTime() : 0;
    return changed < cutoff;
  });

  // Blocked: in-scope blocked items, regardless of how long
  const blockedNotStale = inScope.filter(i => {
    const changed = i.changedDate ? new Date(i.changedDate).getTime() : 0;
    return changed >= cutoff && isBlocked(i);
  });

  const combined = [...stale, ...blockedNotStale];
  let blockedCount = 0;
  const result = combined.map(item => {
    const blocked = isBlocked(item);
    if (blocked) blockedCount++;
    const staleDaysActual = Math.floor((Date.now() - new Date(item.changedDate).getTime()) / 86400000);
    return {
      id: item.id,
      title: item.title,
      type: item.type,
      assignee: item.assignee,
      boardColumn: item.boardColumn || 'Unknown',
      currentState: item.state || 'Unknown',
      staleDaysActual,
      blocked,
      url: item.url
    };
  }).sort((a, b) => {
    if (a.blocked !== b.blocked) return a.blocked ? -1 : 1;
    return b.staleDaysActual - a.staleDaysActual;
  });
  return {
    total: result.length,
    blocked: blockedCount,
    items: result
  };
}
```

- [ ] **Step 4: Run tests, verify all `calcStaleItems` tests pass.**

```bash
node test-node.js
```

Expected: zero failures across the suite (including the new group).

- [ ] **Step 5: Commit.**

```bash
git add shared.js test.js
git commit -m "Widen calcStaleItems to include non-terminal non-intake states"
```

---

### Task 2: Update existing `calcStaleItems` consumers

Per the project rule: trace every consumer when widening behaviour. Five consumers identified in spec §7.4.

**Files:**
- Modify: `shared.js:1017` (`calcPodHealthStatus` — verify the wider set is fine)
- Modify: `shared.js:1069` (`calcExecInsights` — verify the wider set is fine)
- Modify: `board.js` (around line 2114, the stale-table renderer)
- Modify: `popup.js` (verify aged-counts display still correct)
- Test: `test.js` (regression tests for `calcPodHealthStatus`)

- [ ] **Step 1: Read each consumer call site and confirm semantic compatibility.**

```bash
grep -n "calcStaleItems" shared.js board.js popup.js
```

Verify each consumer reads either `result.total`, `result.blocked`, or fields on `result.items[]` that are unchanged (`id`, `title`, `staleDaysActual`, `blocked`, `boardColumn`, `url`). Newly-included Resolved/QA-Complete items will increase counts — that's the intended behaviour.

- [ ] **Step 2: Add a regression test for `calcPodHealthStatus` with widened stale set.**

Add to `test.js`:

```javascript
group('calcPodHealthStatus — widened stale')

test('pod with Resolved-but-stuck items is at least amber', () => {
  const pod = {
    id: 'p1',
    items: [
      makeItem({ id: 1, state: 'Resolved', changedDate: daysAgo(10) }),
      makeItem({ id: 2, state: 'Resolved', changedDate: daysAgo(10) }),
      makeItem({ id: 3, state: 'Resolved', changedDate: daysAgo(10) })
    ]
  }
  const h = calcPodHealthStatus(pod, 2)
  assert(h.status === 'amber' || h.status === 'red',
    `Expected amber or red, got ${h.status}`)
})
```

- [ ] **Step 3: Update the stale-table renderer in `board.js` to show `currentState`.**

Find the renderer near `board.js:2114` (the `staleDaysActual` cell). Add a column or annotation showing the state. Read the surrounding rows first; the change is to the table header and one cell:

```javascript
// In the table header row, add a State column between Item and Days:
//   <th>State</th>
// In each data row, add the cell:
//   <td style="padding:4px 6px;font-size:.75rem">${escHtml(d.currentState || '')}</td>
```

- [ ] **Step 4: Run tests; load extension; verify no regressions on the popup.**

```bash
node test-node.js
```

Then in Chrome: reload extension at `chrome://extensions`, open the popup, confirm the aged counts render and don't crash. Open the board, confirm the stale-items table renders with the new State column.

- [ ] **Step 5: Commit.**

```bash
git add shared.js board.js test.js
git commit -m "Update calcStaleItems consumers; surface currentState in stale table"
```

---

### Task 3: Create `weekly-update.js` — storage + week math (TDD)

**Files:**
- Create: `weekly-update.js`
- Modify: `board.html` (add `<script src="weekly-update.js"></script>` before `board.js`)
- Test: `test.js` (new test groups)
- Test: `test-node.js` (load `weekly-update.js`)

- [ ] **Step 1: Write failing tests for week math.**

Add to `test.js`:

```javascript
// ─── weekly-update: week math ─────────────────────────────────────────────────

group('weekKeyFor')

test('Monday of W17 2026 maps to 2026-W17', () => {
  // 2026-04-20 is a Monday
  assertEqual(weekKeyFor(new Date('2026-04-20T12:00:00Z')), '2026-W17')
})

test('Sunday of W17 2026 maps to 2026-W17', () => {
  // 2026-04-26 is a Sunday
  assertEqual(weekKeyFor(new Date('2026-04-26T12:00:00Z')), '2026-W17')
})

test('Monday of W18 maps to 2026-W18', () => {
  assertEqual(weekKeyFor(new Date('2026-04-27T12:00:00Z')), '2026-W18')
})

test('zero-pads single-digit weeks', () => {
  // 2026-01-05 is Mon of W02
  assertEqual(weekKeyFor(new Date('2026-01-05T12:00:00Z')), '2026-W02')
})

group('weekRange')

test('returns Monday start and Sunday end for week key', () => {
  const r = weekRange('2026-W17')
  assertEqual(r.start.toISOString().slice(0, 10), '2026-04-20')
  assertEqual(r.end.toISOString().slice(0, 10), '2026-04-26')
})

test('label is human-readable', () => {
  const r = weekRange('2026-W17')
  assert(r.label.includes('Apr'), `Label should include Apr, got: ${r.label}`)
  assert(r.label.includes('20'), `Label should include 20, got: ${r.label}`)
  assert(r.label.includes('26'), `Label should include 26, got: ${r.label}`)
})
```

- [ ] **Step 2: Update `test-node.js` to load `weekly-update.js`.**

After the line `loadFile('shared.js')` add:

```javascript
loadFile('weekly-update.js')
```

- [ ] **Step 3: Run tests; verify they fail with "weekKeyFor not defined".**

```bash
node test-node.js 2>&1 | head -10
```

Expected: ReferenceError on `weekKeyFor` (file does not exist).

- [ ] **Step 4: Create `weekly-update.js` with week math.**

```javascript
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
```

- [ ] **Step 5: Add the script tag to `board.html`.**

Find the existing `<script src="shared.js">` tag and add `weekly-update.js` immediately after:

```html
<script src="shared.js"></script>
<script src="weekly-update.js"></script>
<script src="board.js"></script>
```

- [ ] **Step 6: Run tests; verify all pass.**

```bash
node test-node.js
```

Expected: zero failures.

- [ ] **Step 7: Commit.**

```bash
git add weekly-update.js board.html test.js test-node.js
git commit -m "Add weekly-update module with week math and storage helpers"
```

---

### Task 4: `weekly-update.js` — carry-over detection (TDD)

**Files:**
- Modify: `weekly-update.js`
- Modify: `test.js`

- [ ] **Step 1: Write failing tests.**

Add to `test.js`:

```javascript
// ─── weekly-update: carry-over ────────────────────────────────────────────────

group('detectCarryOver')

test('matches identical action text case-insensitively', () => {
  const prev = [{ id: 'p1', text: 'Triage QA backlog', owner: null, due: 'this-week' }]
  const curr = [{ id: 'c1', text: 'TRIAGE QA BACKLOG', owner: null, due: 'this-week', carriedFrom: null }]
  const r = detectCarryOver(curr, prev, '2026-W16')
  assertEqual(r[0].carriedFrom, '2026-W16')
})

test('ignores whitespace differences', () => {
  const prev = [{ id: 'p1', text: '  Triage QA backlog  ', owner: null, due: 'this-week' }]
  const curr = [{ id: 'c1', text: 'Triage QA backlog', owner: null, due: 'this-week', carriedFrom: null }]
  const r = detectCarryOver(curr, prev, '2026-W16')
  assertEqual(r[0].carriedFrom, '2026-W16')
})

test('does not match when text differs', () => {
  const prev = [{ id: 'p1', text: 'Triage QA backlog', owner: null, due: 'this-week' }]
  const curr = [{ id: 'c1', text: 'Different action', owner: null, due: 'this-week', carriedFrom: null }]
  const r = detectCarryOver(curr, prev, '2026-W16')
  assertEqual(r[0].carriedFrom, null)
})

test('preserves existing carriedFrom from earlier week (chain)', () => {
  const prev = [{ id: 'p1', text: 'Triage QA backlog', carriedFrom: '2026-W15' }]
  const curr = [{ id: 'c1', text: 'Triage QA backlog', carriedFrom: null }]
  const r = detectCarryOver(curr, prev, '2026-W16')
  assertEqual(r[0].carriedFrom, '2026-W16')
})

group('carryChainLength')

test('returns 0 for action not carried over', () => {
  const action = { id: 'a1', text: 't', carriedFrom: null }
  assertEqual(carryChainLength(action, {}), 0)
})

test('returns 1 for action carried from one prior week', () => {
  const action = { id: 'a1', text: 'X', carriedFrom: '2026-W16' }
  const allWeeks = {
    '2026-W16': { pods: { p1: { actions: [{ id: 'a0', text: 'X', carriedFrom: null }] } } }
  }
  assertEqual(carryChainLength(action, allWeeks), 1)
})

test('returns 2 for two-week chain', () => {
  const action = { id: 'a1', text: 'X', carriedFrom: '2026-W16' }
  const allWeeks = {
    '2026-W16': { pods: { p1: { actions: [{ id: 'a0', text: 'X', carriedFrom: '2026-W15' }] } } },
    '2026-W15': { pods: { p1: { actions: [{ id: 'a-1', text: 'X', carriedFrom: null }] } } }
  }
  assertEqual(carryChainLength(action, allWeeks), 2)
})
```

- [ ] **Step 2: Run tests; verify they fail.**

```bash
node test-node.js 2>&1 | grep -E "FAIL|carry" | head -10
```

Expected: ReferenceError on `detectCarryOver` and `carryChainLength`.

- [ ] **Step 3: Add the functions to `weekly-update.js`.**

Append to `weekly-update.js`:

```javascript
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
// returns the count of consecutive prior weeks that contain the same text.
function carryChainLength(action, allWeeklyUpdates) {
  let length = 0
  let textKey = _normaliseActionText(action.text)
  let prevKey = action.carriedFrom
  while (prevKey && allWeeklyUpdates[prevKey]) {
    const prevWeek = allWeeklyUpdates[prevKey]
    let foundInPrev = null
    for (const podId of Object.keys(prevWeek.pods || {})) {
      for (const prev of (prevWeek.pods[podId].actions || [])) {
        if (_normaliseActionText(prev.text) === textKey) { foundInPrev = prev; break }
      }
      if (foundInPrev) break
    }
    if (!foundInPrev) break
    length++
    prevKey = foundInPrev.carriedFrom
  }
  return length
}
```

- [ ] **Step 4: Run tests; verify all pass.**

```bash
node test-node.js
```

- [ ] **Step 5: Commit.**

```bash
git add weekly-update.js test.js
git commit -m "Add carry-over detection and chain-length walk"
```

---

### Task 5: `weekly-update.js` — suggestion engine (TDD)

**Files:**
- Modify: `weekly-update.js`
- Modify: `test.js`

- [ ] **Step 1: Write failing tests.**

Add to `test.js`:

```javascript
// ─── weekly-update: suggestion engine ────────────────────────────────────────

group('buildSuggestions — keys are deterministic')

test('throughput-up suggestion has stable key', () => {
  const pod = {
    id: 'p1', name: 'Pod A',
    items: Array.from({ length: 8 }, (_, i) => makeItem({
      id: i, type: 'User Story', state: 'Closed',
      closed: daysAgo(i < 4 ? 2 : 30)  // 4 closed last week, baseline lower in older weeks
    }))
  }
  const s1 = buildSuggestions(pod, {}, { staleDays: 2 }, {})
  const s2 = buildSuggestions(pod, {}, { staleDays: 2 }, {})
  const keys1 = s1.wins.concat(s1.issues, s1.actions).map(x => x.key).sort()
  const keys2 = s2.wins.concat(s2.issues, s2.actions).map(x => x.key).sort()
  assertEqual(JSON.stringify(keys1), JSON.stringify(keys2))
})

test('suggested action for stale item uses item id in key', () => {
  const pod = {
    id: 'p1', name: 'Pod A',
    items: [makeItem({ id: 4521, state: 'Active', changedDate: daysAgo(8) })]
  }
  const s = buildSuggestions(pod, {}, { staleDays: 2 }, {})
  const triage = s.actions.find(a => a.key === 'action-triage-stale-4521')
  assert(triage, 'Expected action with key action-triage-stale-4521')
})

test('suggested action for unassigned P1/P2 uses item id', () => {
  const pod = {
    id: 'p1', name: 'Pod A',
    items: [makeItem({ id: 9999, state: 'Active', priority: 1, assignee: null })]
  }
  const s = buildSuggestions(pod, {}, { staleDays: 2 }, {})
  const assn = s.actions.find(a => a.key === 'action-assign-owner-9999')
  assert(assn, 'Expected assign-owner suggestion for unassigned P1 item')
})
```

- [ ] **Step 2: Run tests; verify they fail.**

```bash
node test-node.js 2>&1 | head -20
```

- [ ] **Step 3: Implement `buildSuggestions` in `weekly-update.js`.**

Append:

```javascript
// ─── Suggestion engine ───────────────────────────────────────────────────────

// Returns { wins: Suggestion[], issues: Suggestion[], actions: Suggestion[] }
// where Suggestion = { key: string, type: 'positive'|'warning'|'blocker'|'info', text: string }
//
// Wraps existing calc* functions; thresholds match calcExecInsights.
function buildSuggestions(pod, _cachedData, settings, _holidays) {
  const items = pod.items || []
  const wins = []
  const issues = []
  const actions = []
  const staleDays = settings.staleDays || 2

  // — Throughput trend —
  const tp = calcWeeklyThroughput(items, 8)
  if (tp.length >= 5) {
    const last = tp[tp.length - 2]?.count || 0
    const baseline = tp.slice(0, -2).reduce((s, w) => s + w.count, 0) / (tp.length - 2)
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
  const aged = items.filter(i => !['Closed', 'Removed'].includes(i.state)).filter(i => {
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

  // — Pod-level fallbacks —
  // (predictability, cycle time, health-drop, paused-no-resume) — added in board.js
  // wiring or in a follow-up task once needed; out of unit-test scope here.

  return { wins, issues, actions }
}
```

- [ ] **Step 4: Run tests; verify all pass.**

```bash
node test-node.js
```

- [ ] **Step 5: Commit.**

```bash
git add weekly-update.js test.js
git commit -m "Add buildSuggestions engine with deterministic suggestion keys"
```

---

## Phase 2 — Settings

### Task 6: Add `unitName` and `teamLeads` to settings; add storage key

**Files:**
- Modify: `shared.js:3-27` (`DEFAULT_SETTINGS`)
- Modify: `shared.js:29-40` (`STORAGE_KEYS`)

- [ ] **Step 1: Add fields to `DEFAULT_SETTINGS` and storage key.**

In `shared.js` lines 3-27 (`DEFAULT_SETTINGS`), add after `executiveSummary: false,`:

```javascript
  unitName: '',
  teamLeads: [],
```

In `STORAGE_KEYS` (line 29-40), add a new entry:

```javascript
  weeklyUpdates: 'weeklyUpdates',
```

- [ ] **Step 2: Verify the test suite still passes.**

```bash
node test-node.js
```

- [ ] **Step 3: Commit.**

```bash
git add shared.js
git commit -m "Add unitName, teamLeads to DEFAULT_SETTINGS; add weeklyUpdates storage key"
```

---

### Task 7: Unit Name input on Options page

**Files:**
- Modify: `options.html`
- Modify: `options.js`

- [ ] **Step 1: Read the existing options.html to find the right insertion point.**

```bash
grep -n "id=" options.html | head -30
```

Identify the section near the existing org/project inputs. The Unit Name input belongs next to them.

- [ ] **Step 2: Add the input.**

In `options.html`, near the existing org/project inputs, add (matching surrounding markup style):

```html
<label for="unit-name">Unit name (shown on the weekly PDF)</label>
<input id="unit-name" type="text" placeholder="e.g. Platform Unit A" />
```

- [ ] **Step 3: Wire it in `options.js`.**

In `options.js`, find the load-settings function (probably reads `getSettings()` and populates inputs). Add:

```javascript
$('unit-name').value = settings.unitName || ''
```

In the save-settings handler, add:

```javascript
settings.unitName = $('unit-name').value.trim()
```

- [ ] **Step 4: Manual verify.**

Reload extension, open Options, type a unit name, save, reload Options page, confirm value persisted.

- [ ] **Step 5: Commit.**

```bash
git add options.html options.js
git commit -m "Add Unit Name input to Options page"
```

---

### Task 8: Team Leads management UI on Options page

**Files:**
- Modify: `options.html`
- Modify: `options.js`

- [ ] **Step 1: Read the existing Pods section to mirror its pattern.**

```bash
grep -n "pod" options.html options.js | head -40
```

The new Team Leads section must use the same patterns: add/edit/delete list, save back to `settings.teamLeads`.

- [ ] **Step 2: Add the Team Leads section to `options.html`.**

After the existing Pods section, add:

```html
<section class="team-leads-section">
  <h3>Team Leads</h3>
  <p class="section-desc">Authoritative owners of actions on the weekly status update. One lead can cover multiple pods.</p>
  <div id="team-leads-list"></div>
  <button id="add-team-lead-btn" type="button">+ Add team lead</button>
</section>
```

- [ ] **Step 3: Implement the renderer in `options.js`.**

Add a new function and call it when settings load:

```javascript
function renderTeamLeads(settings) {
  const container = $('team-leads-list')
  container.innerHTML = ''
  for (const lead of (settings.teamLeads || [])) {
    const podOptions = (settings.pods || []).map(p =>
      `<option value="${escAttr(p.id)}" ${lead.podIds?.includes(p.id) ? 'selected' : ''}>${escHtml(p.name)}</option>`
    ).join('')
    const row = document.createElement('div')
    row.className = 'team-lead-row'
    row.dataset.leadId = lead.id
    row.innerHTML = `
      <input class="lead-name" type="text" value="${escAttr(lead.name)}" placeholder="Name" />
      <input class="lead-email" type="email" value="${escAttr(lead.email || '')}" placeholder="Email (optional)" />
      <select class="lead-pods" multiple size="3">${podOptions}</select>
      <button class="lead-delete" type="button">×</button>
    `
    container.appendChild(row)
  }
}

$('add-team-lead-btn').addEventListener('click', () => {
  // Read current settings, append a fresh lead, re-render.
  getSettings().then(settings => {
    settings.teamLeads = settings.teamLeads || []
    settings.teamLeads.push({ id: crypto.randomUUID(), name: '', email: '', podIds: [] })
    saveSettingsFromForm(settings)
    renderTeamLeads(settings)
  })
})

// In the existing save-settings handler, before persisting:
function collectTeamLeadsFromDOM(settings) {
  const rows = document.querySelectorAll('#team-leads-list .team-lead-row')
  settings.teamLeads = [...rows].map(row => ({
    id: row.dataset.leadId,
    name: row.querySelector('.lead-name').value.trim(),
    email: row.querySelector('.lead-email').value.trim(),
    podIds: [...row.querySelector('.lead-pods').selectedOptions].map(o => o.value)
  })).filter(l => l.name)  // drop blank rows
}

// Wire delete handler (event delegation):
$('team-leads-list').addEventListener('click', (e) => {
  if (!e.target.classList.contains('lead-delete')) return
  const row = e.target.closest('.team-lead-row')
  if (row) row.remove()
})
```

Adjust `saveSettingsFromForm` (or whatever the existing save function is named) to call `collectTeamLeadsFromDOM(settings)` before `chrome.storage.local.set`.

- [ ] **Step 4: Manual verify.**

Reload extension. Add 2 team leads, set names, assign different pod sets to each. Save. Reload the Options page, confirm both leads and their pod selections persisted. Delete one, save, reload, confirm gone.

- [ ] **Step 5: Commit.**

```bash
git add options.html options.js
git commit -m "Add Team Leads management section to Options page"
```

---

## Phase 3 — Exec Summary tab UI

### Task 9: Week selector + status badge + auto-save indicator scaffold

**Files:**
- Modify: `board.js` (in `buildExecutiveSummaryPanel`, near line 834)

- [ ] **Step 1: Read the current `buildExecutiveSummaryPanel` head.**

Read `board.js:830-870`. Understand where the existing header is rendered (`exec-header`).

- [ ] **Step 2: Insert the week-selector toolbar markup before the existing header.**

Replace the existing `exec-header` block (around lines 960-965) with:

```javascript
const allWeeks = await listWeeks()
const selectedWeekKey = panel.dataset.selectedWeek || getLastCompletedWeekKey()
panel.dataset.selectedWeek = selectedWeekKey
const wu = await getWeeklyUpdate(selectedWeekKey)
const range = weekRange(selectedWeekKey)
const isFinalised = !!wu.finalisedAt
const finalisedDateLabel = isFinalised ? new Date(wu.finalisedAt).toLocaleDateString('en-GB') : ''

html += `
  <div class="exec-toolbar">
    <button class="exec-week-prev" title="Previous week">◀</button>
    <select class="exec-week-select">
      ${allWeeks.map(w => `<option value="${escAttr(w)}" ${w === selectedWeekKey ? 'selected' : ''}>Week of ${escHtml(weekRange(w).label)} (${escHtml(w)})</option>`).join('')}
    </select>
    <button class="exec-week-next" title="Next week">▶</button>
    <span class="exec-status-badge ${isFinalised ? 'finalised' : 'draft'}">
      ${isFinalised ? `✓ Finalised ${escHtml(finalisedDateLabel)}` : '● Draft'}
    </span>
    <span class="exec-saved-indicator"></span>
    ${isFinalised
      ? `<button class="exec-reexport-btn">Re-export PDF</button><button class="exec-unlock-btn">Unlock</button>`
      : `<button class="exec-finalise-btn">Finalise & Export PDF</button>`}
  </div>
  <div class="exec-header">
    <div class="exec-title">Executive Summary</div>
    <div class="exec-date">${escHtml(range.label)}</div>
  </div>
`
```

- [ ] **Step 3: Wire up week selector handlers (after `panel.innerHTML = html` near line 1253).**

Add to the existing event-wiring section at the end of `buildExecutiveSummaryPanel`:

```javascript
// Week selector
panel.querySelector('.exec-week-select')?.addEventListener('change', (e) => {
  panel.dataset.selectedWeek = e.target.value
  buildExecutiveSummaryPanel(cachedData, settings, sortedPods)
})
panel.querySelector('.exec-week-prev')?.addEventListener('click', () => {
  const sel = panel.querySelector('.exec-week-select')
  const idx = sel.selectedIndex
  if (idx < sel.options.length - 1) { sel.selectedIndex = idx + 1; sel.dispatchEvent(new Event('change')) }
})
panel.querySelector('.exec-week-next')?.addEventListener('click', () => {
  const sel = panel.querySelector('.exec-week-select')
  const idx = sel.selectedIndex
  if (idx > 0) { sel.selectedIndex = idx - 1; sel.dispatchEvent(new Event('change')) }
})
```

- [ ] **Step 4: Add styles for the toolbar.**

Find the existing CSS for `.exec-header` in `board.html` (or wherever inline styles live). Add:

```css
.exec-toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
.exec-toolbar button { padding: 4px 10px; }
.exec-status-badge { padding: 2px 8px; border-radius: 4px; font-size: .8rem; }
.exec-status-badge.draft { background: #fef3c7; color: #92400e; }
.exec-status-badge.finalised { background: #d1fae5; color: #065f46; }
.exec-saved-indicator { font-size: .75rem; color: var(--muted); }
```

- [ ] **Step 5: Manual verify.**

Reload extension. Open the board → Exec Summary tab. Confirm the toolbar renders, the dropdown lists at least the current week, ◀ ▶ navigate, switching weeks re-renders the panel.

- [ ] **Step 6: Commit.**

```bash
git add board.js board.html
git commit -m "Add week selector, status badge, and toolbar scaffold to exec summary"
```

---

### Task 10: Unit Headline section (data binding + add/edit/delete)

**Files:**
- Modify: `board.js`

- [ ] **Step 1: Insert the unit-headline render block.**

In `buildExecutiveSummaryPanel`, after the `exec-header` block but **before** the existing `exec-aggregate` (around line 980), insert:

```javascript
const readonly = isFinalised
const headline = wu.unitHeadline || { wins: [], issues: [], actions: [] }

function renderEntryList(category, entries, podScope = null) {
  return entries.map(e => {
    const sev = e.severity ? `<span class="exec-sev sev-${e.severity}">${e.severity}</span>` : ''
    const owner = e.owner ? `<span class="exec-owner">${e.owner.kind === 'lead' ? '👑 ' : ''}${escHtml(e.owner.name)}</span>` : ''
    const due = e.due ? `<span class="exec-due">due ${escHtml(e.due)}</span>` : ''
    const carried = e.carriedFrom ? `<span class="exec-carried">↻ carried from ${escHtml(e.carriedFrom)}</span>` : ''
    const needs = e.needsFromLeadership ? `<span class="exec-needs">NEEDS LEADERSHIP</span>` : ''
    const sourceChip = e.sourcePodId ? `<span class="exec-source">from ${escHtml(podNameById(e.sourcePodId))}</span>` : ''
    const del = readonly ? '' : `<button class="exec-entry-del" data-entry-id="${escAttr(e.id)}" data-category="${category}" data-pod="${podScope || '_unit'}">×</button>`
    return `<li class="exec-entry" data-entry-id="${escAttr(e.id)}">
      ${sev}<span class="exec-entry-text" contenteditable="${!readonly}">${escHtml(e.text)}</span>
      ${owner}${due}${carried}${needs}${sourceChip}${del}
    </li>`
  }).join('')
}

function podNameById(id) {
  const p = (settings.pods || []).find(p => p.id === id)
  return p ? p.name : id
}

const addBtn = (category) => readonly ? '' :
  `<button class="exec-headline-add" data-category="${category}">+ add ${category}</button>`

html += `
  <div class="exec-unit-headline">
    <h3>Unit Headline</h3>
    <div class="exec-headline-block">
      <div class="exec-headline-label">Wins</div>
      <ul class="exec-entries">${renderEntryList('wins', headline.wins)}</ul>
      ${addBtn('wins')}
    </div>
    <div class="exec-headline-block">
      <div class="exec-headline-label">Issues</div>
      <ul class="exec-entries">${renderEntryList('issues', headline.issues)}</ul>
      ${addBtn('issues')}
    </div>
    <div class="exec-headline-block">
      <div class="exec-headline-label">Actions for next week</div>
      <ul class="exec-entries">${renderEntryList('actions', headline.actions)}</ul>
      ${addBtn('actions')}
    </div>
  </div>
`
```

- [ ] **Step 2: Wire add/delete/edit handlers.**

Append to the event-wiring section at the end of `buildExecutiveSummaryPanel`:

```javascript
async function persistWu() {
  await setWeeklyUpdate(selectedWeekKey, wu)
  const ind = panel.querySelector('.exec-saved-indicator')
  if (ind) {
    ind.textContent = 'saved just now'
    setTimeout(() => { if (ind) ind.textContent = '' }, 3000)
  }
}

panel.querySelectorAll('.exec-headline-add').forEach(btn => {
  btn.addEventListener('click', async () => {
    const category = btn.dataset.category
    const newEntry = { id: crypto.randomUUID(), text: '', workItemIds: [] }
    if (category === 'issues') Object.assign(newEntry, { severity: 'risk', owner: null, needsFromLeadership: false })
    if (category === 'actions') Object.assign(newEntry, { owner: null, due: 'this-week', carriedFrom: null })
    wu.unitHeadline[category].push(newEntry)
    await persistWu()
    buildExecutiveSummaryPanel(cachedData, settings, sortedPods)
  })
})

panel.querySelectorAll('.exec-entry-del').forEach(btn => {
  btn.addEventListener('click', async () => {
    const id = btn.dataset.entryId
    const category = btn.dataset.category
    const pod = btn.dataset.pod
    const list = pod === '_unit' ? wu.unitHeadline[category] : wu.pods[pod]?.[category === 'wins' ? 'progress' : category]
    if (!list) return
    const idx = list.findIndex(e => e.id === id)
    if (idx >= 0) list.splice(idx, 1)
    await persistWu()
    buildExecutiveSummaryPanel(cachedData, settings, sortedPods)
  })
})

// Auto-save on text edits (contenteditable blur)
panel.querySelectorAll('.exec-entry-text').forEach(el => {
  el.addEventListener('blur', async () => {
    const li = el.closest('.exec-entry')
    const id = li?.dataset.entryId
    if (!id) return
    // Find the entry in any list and update its text
    const lists = [
      ...['wins', 'issues', 'actions'].map(c => wu.unitHeadline[c]),
      ...Object.values(wu.pods || {}).flatMap(p => [p.progress, p.issues, p.actions])
    ]
    for (const list of lists) {
      const e = list.find(x => x.id === id)
      if (e) { e.text = el.textContent.trim(); break }
    }
    await persistWu()
  })
})
```

- [ ] **Step 3: Add CSS.**

In the same place as the toolbar styles:

```css
.exec-unit-headline { background: var(--card-bg); padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; }
.exec-unit-headline h3 { margin: 0 0 8px 0; }
.exec-headline-block { margin-bottom: 12px; }
.exec-headline-label { font-weight: 600; font-size: .85rem; margin-bottom: 4px; }
.exec-entries { list-style: none; padding: 0; margin: 0; }
.exec-entry { padding: 4px 0; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.exec-entry-text { flex: 1; min-width: 200px; padding: 2px 4px; border-radius: 2px; }
.exec-entry-text:focus { outline: 1px solid var(--accent); background: var(--input-bg); }
.exec-sev { padding: 1px 6px; border-radius: 3px; font-size: .7rem; font-weight: 700; }
.exec-sev.sev-blocker { background: #dc2626; color: white; }
.exec-sev.sev-risk    { background: #d97706; color: white; }
.exec-sev.sev-watch   { background: #0891b2; color: white; }
.exec-needs { background: #fef3c7; color: #92400e; padding: 1px 6px; border-radius: 3px; font-size: .7rem; font-weight: 700; }
.exec-source { font-size: .7rem; color: var(--muted); }
.exec-carried { font-size: .7rem; color: #6366f1; }
.exec-headline-add { font-size: .8rem; padding: 2px 8px; }
.exec-entry-del { background: transparent; border: none; color: var(--muted); cursor: pointer; }
.exec-entry-del:hover { color: #dc2626; }
```

- [ ] **Step 4: Manual verify.**

Reload extension. Click "+ add wins", new entry appears with empty editable text. Type, click outside, see "saved just now". Reload tab, confirm entry persisted. Delete entry, confirm gone after reload.

- [ ] **Step 5: Commit.**

```bash
git add board.js board.html
git commit -m "Add Unit Headline section with entry add/edit/delete and auto-save"
```

---

### Task 11: Per-pod structured update — Progress / Issues / Actions

**Files:**
- Modify: `board.js` (the per-pod loop in `buildExecutiveSummaryPanel`, around line 1067)

- [ ] **Step 1: Insert structured-update block before the existing WoW table.**

In the per-pod loop, after the `exec-pod-body` opening tag (around line 1161) and BEFORE `if (pInsights.length)` (line 1164), insert:

```javascript
// Lazy-init pod entry shape for this week
if (!wu.pods[pod.id]) wu.pods[pod.id] = emptyPodShape()
const pe = wu.pods[pod.id]

const stickyDis = readonly ? 'disabled' : ''

html += `
  <div class="exec-pod-update" data-pod="${escHtml(pod.id)}">
    <label class="exec-steady-label">
      <input type="checkbox" class="exec-steady" ${stickyDis} ${pe.steady ? 'checked' : ''}/>
      Mark steady this week
    </label>
    <div class="exec-pod-update-body" ${pe.steady ? 'style="opacity:.5"' : ''}>
      <div class="exec-headline-block">
        <div class="exec-headline-label">Progress</div>
        <ul class="exec-entries">${renderEntryList('progress', pe.progress, pod.id)}</ul>
        ${readonly ? '' : `<button class="exec-pod-add" data-category="progress" data-pod="${escAttr(pod.id)}">+ add</button>`}
      </div>
      <div class="exec-headline-block">
        <div class="exec-headline-label">Issues</div>
        <ul class="exec-entries">${renderEntryList('issues', pe.issues, pod.id)}</ul>
        ${readonly ? '' : `<button class="exec-pod-add" data-category="issues" data-pod="${escAttr(pod.id)}">+ add</button>`}
      </div>
      <div class="exec-headline-block">
        <div class="exec-headline-label">Actions</div>
        <ul class="exec-entries">${renderEntryList('actions', pe.actions, pod.id)}</ul>
        ${readonly ? '' : `<button class="exec-pod-add" data-category="actions" data-pod="${escAttr(pod.id)}">+ add</button>`}
      </div>
    </div>
  </div>
`
```

- [ ] **Step 2: Wire pod-level add buttons + Steady toggle.**

Append to the event-wiring section:

```javascript
panel.querySelectorAll('.exec-pod-add').forEach(btn => {
  btn.addEventListener('click', async () => {
    const podId = btn.dataset.pod
    const category = btn.dataset.category
    const list = wu.pods[podId][category]
    const newEntry = { id: crypto.randomUUID(), text: '', workItemIds: [] }
    if (category === 'issues') Object.assign(newEntry, { severity: 'risk', owner: null, needsFromLeadership: false })
    if (category === 'actions') {
      Object.assign(newEntry, { owner: null, due: 'this-week', carriedFrom: null })
      // Carry-over detection on save
      const prevKey = previousIsoWeekKey(selectedWeekKey)
      const prevWu = await getWeeklyUpdate(prevKey)
      const prevActions = (prevWu.pods?.[podId]?.actions) || []
      detectCarryOver([newEntry], prevActions, prevKey)
    }
    list.push(newEntry)
    await persistWu()
    buildExecutiveSummaryPanel(cachedData, settings, sortedPods)
  })
})

panel.querySelectorAll('.exec-steady').forEach(cb => {
  cb.addEventListener('change', async () => {
    const podId = cb.closest('.exec-pod-update').dataset.pod
    wu.pods[podId].steady = cb.checked
    await persistWu()
    buildExecutiveSummaryPanel(cachedData, settings, sortedPods)
  })
})
```

Add a helper `previousIsoWeekKey` to `weekly-update.js`:

```javascript
function previousIsoWeekKey(weekKey) {
  const r = weekRange(weekKey)
  const d = new Date(r.start.getTime() - 86400000)  // 1 day before Monday → previous week
  return weekKeyFor(d)
}
```

- [ ] **Step 3: Manual verify.**

Reload, expand a pod, add Progress / Issues / Actions entries, confirm they persist after tab reload. Tick Steady, confirm body greys out. Untick, confirm restored.

- [ ] **Step 4: Commit.**

```bash
git add board.js weekly-update.js
git commit -m "Add per-pod structured update (Progress/Issues/Actions) with Steady toggle"
```

---

### Task 12: Auto-suggestions block per pod

**Files:**
- Modify: `board.js`

- [ ] **Step 1: Insert the suggestions block.**

In the per-pod loop, AFTER the `exec-pod-update` block from Task 11 and BEFORE the existing `pInsights` block:

```javascript
const showSuggestions = selectedWeekKey === getCurrentWeekKey() || selectedWeekKey === getLastCompletedWeekKey()
let suggHtml = ''
if (showSuggestions && !pe.steady && !readonly) {
  const sugg = buildSuggestions(pod, cachedData, settings, holidays)
  const promotedKeys = new Set(pe.suggestionsState?.promoted || [])
  const dismissedKeys = new Set(pe.suggestionsState?.dismissed || [])
  function renderSuggList(category, items) {
    if (items.length === 0) return '<div class="exec-sugg-empty">—</div>'
    return items.map(s => {
      const promoted = promotedKeys.has(s.key)
      const dismissed = dismissedKeys.has(s.key)
      if (dismissed) return ''
      const icon = s.type === 'positive' ? '✅' : s.type === 'blocker' ? '🔴' : s.type === 'warning' ? '⚠️' : 'ℹ️'
      const action = promoted
        ? '<span class="exec-sugg-added">✓ Added</span>'
        : `<button class="exec-sugg-promote" data-key="${escAttr(s.key)}" data-pod="${escAttr(pod.id)}" data-cat="${category}" data-text="${escAttr(s.text)}">→ Add to ${category}</button>
           <button class="exec-sugg-dismiss" data-key="${escAttr(s.key)}" data-pod="${escAttr(pod.id)}">Dismiss</button>`
      return `<li class="exec-sugg ${promoted ? 'promoted' : ''}">${icon} ${escHtml(s.text)} ${action}</li>`
    }).join('')
  }
  suggHtml = `
    <details class="exec-suggestions">
      <summary>Auto-suggestions for ${escHtml(pod.name)} (${sugg.wins.length} wins · ${sugg.issues.length} issues · ${sugg.actions.length} actions)</summary>
      <div class="exec-sugg-cols">
        <div><div class="exec-sugg-label">Wins</div><ul>${renderSuggList('progress', sugg.wins)}</ul></div>
        <div><div class="exec-sugg-label">Issues</div><ul>${renderSuggList('issues', sugg.issues)}</ul></div>
        <div><div class="exec-sugg-label">Actions</div><ul>${renderSuggList('actions', sugg.actions)}</ul></div>
      </div>
    </details>
  `
}
```

Insert `${suggHtml}` between the `exec-pod-update` block and the existing risks / WoW table (so suggestions live inside the pod card body, above the WoW table per spec).

- [ ] **Step 2: Wire promote/dismiss handlers.**

```javascript
panel.querySelectorAll('.exec-sugg-promote').forEach(btn => {
  btn.addEventListener('click', async () => {
    const podId = btn.dataset.pod
    const cat = btn.dataset.cat
    const key = btn.dataset.key
    const text = btn.dataset.text
    const newEntry = { id: crypto.randomUUID(), text, workItemIds: [] }
    if (cat === 'issues') Object.assign(newEntry, { severity: 'risk', owner: null, needsFromLeadership: false })
    if (cat === 'actions') {
      Object.assign(newEntry, { owner: null, due: 'this-week', carriedFrom: null })
      const prevKey = previousIsoWeekKey(selectedWeekKey)
      const prevWu = await getWeeklyUpdate(prevKey)
      detectCarryOver([newEntry], (prevWu.pods?.[podId]?.actions) || [], prevKey)
    }
    wu.pods[podId][cat].push(newEntry)
    if (!wu.pods[podId].suggestionsState) wu.pods[podId].suggestionsState = { promoted: [], dismissed: [] }
    wu.pods[podId].suggestionsState.promoted.push(key)
    await persistWu()
    buildExecutiveSummaryPanel(cachedData, settings, sortedPods)
  })
})

panel.querySelectorAll('.exec-sugg-dismiss').forEach(btn => {
  btn.addEventListener('click', async () => {
    const podId = btn.dataset.pod
    const key = btn.dataset.key
    if (!wu.pods[podId].suggestionsState) wu.pods[podId].suggestionsState = { promoted: [], dismissed: [] }
    wu.pods[podId].suggestionsState.dismissed.push(key)
    await persistWu()
    buildExecutiveSummaryPanel(cachedData, settings, sortedPods)
  })
})
```

- [ ] **Step 3: Add CSS.**

```css
.exec-suggestions { background: var(--card-bg); padding: 8px 12px; border-radius: 6px; margin: 8px 0; font-size: .85rem; }
.exec-suggestions summary { cursor: pointer; font-weight: 600; }
.exec-sugg-cols { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; margin-top: 8px; }
.exec-sugg-label { font-weight: 600; margin-bottom: 4px; }
.exec-sugg-cols ul { list-style: none; padding: 0; margin: 0; }
.exec-sugg { padding: 4px 0; }
.exec-sugg.promoted { opacity: .5; }
.exec-sugg-added { color: #059669; font-weight: 600; }
.exec-sugg-promote, .exec-sugg-dismiss { font-size: .7rem; margin-left: 4px; }
.exec-sugg-empty { color: var(--muted); font-style: italic; }
```

- [ ] **Step 4: Manual verify.**

Reload. Open a pod with throughput / stale data. Confirm suggestions appear. Promote a win — confirm it lands in Progress and the suggestion shows "✓ Added". Dismiss an issue — confirm it disappears. Switch to a historical week — confirm suggestions block does NOT appear.

- [ ] **Step 5: Commit.**

```bash
git add board.js board.html
git commit -m "Add auto-suggestions block with promote/dismiss per pod"
```

---

### Task 13: Owner picker (with Team Lead grouping)

**Files:**
- Modify: `board.js`

- [ ] **Step 1: Add an owner-picker render helper.**

Add near `renderEntryList`:

```javascript
function renderOwnerPicker(pod, currentOwner, readonly) {
  if (readonly) {
    return currentOwner
      ? `<span class="exec-owner">${currentOwner.kind === 'lead' ? '👑 ' : ''}${escHtml(currentOwner.name)}</span>`
      : '<span class="exec-owner exec-owner-empty">no owner</span>'
  }
  const teamLeads = settings.teamLeads || []
  const podLeads = teamLeads.filter(l => (l.podIds || []).includes(pod.id))
  const otherLeads = teamLeads.filter(l => !(l.podIds || []).includes(pod.id))
  const assignees = [...new Set((pod.items || []).filter(i => i.assignee).map(i => i.assignee))]
  function opt(value, label, selected) {
    return `<option value="${escAttr(value)}" ${selected ? 'selected' : ''}>${escHtml(label)}</option>`
  }
  const currentValue = currentOwner ? `${currentOwner.kind}:${currentOwner.id || ''}:${currentOwner.name}` : ''
  return `
    <select class="exec-owner-picker">
      <option value="">— select owner —</option>
      ${podLeads.length ? `<optgroup label="Team Leads (this pod)">${podLeads.map(l => opt(`lead:${l.id}:${l.name}`, `👑 ${l.name}`, currentValue === `lead:${l.id}:${l.name}`)).join('')}</optgroup>` : ''}
      ${assignees.length ? `<optgroup label="Pod members">${assignees.map(a => opt(`member::${a}`, a, currentValue === `member::${a}`)).join('')}</optgroup>` : ''}
      ${otherLeads.length ? `<optgroup label="Other team leads">${otherLeads.map(l => opt(`lead:${l.id}:${l.name}`, `👑 ${l.name}`, currentValue === `lead:${l.id}:${l.name}`)).join('')}</optgroup>` : ''}
      <option value="__custom__">+ Add custom...</option>
    </select>
  `
}
```

- [ ] **Step 2: Update `renderEntryList` to use the picker for issues and actions.**

Modify the `renderEntryList` function to include the picker (replacing the static `<span class="exec-owner">` line) for `issues` and `actions` categories. Also add severity dropdown for `issues` and due dropdown for `actions`. The existing `renderEntryList` function from Task 10 already has `category` and `podScope` params — extend the inner template to call the picker and the dropdowns.

Replace the existing `renderEntryList` body with:

```javascript
function renderEntryList(category, entries, podScope = null) {
  const pod = podScope ? (settings.pods || []).find(p => p.id === podScope) : null
  return entries.map(e => {
    const sev = (category === 'issues')
      ? (readonly
          ? `<span class="exec-sev sev-${e.severity || 'risk'}">${e.severity || 'risk'}</span>`
          : `<select class="exec-sev-picker" data-entry-id="${escAttr(e.id)}" data-pod="${escAttr(podScope || '_unit')}">
              <option value="blocker" ${e.severity === 'blocker' ? 'selected' : ''}>blocker</option>
              <option value="risk"    ${e.severity === 'risk' || !e.severity ? 'selected' : ''}>risk</option>
              <option value="watch"   ${e.severity === 'watch' ? 'selected' : ''}>watch</option>
            </select>`)
      : ''
    const ownerHtml = (category === 'issues' || category === 'actions') && pod
      ? renderOwnerPicker(pod, e.owner, readonly)
      : ''
    const dueHtml = (category === 'actions')
      ? (readonly
          ? `<span class="exec-due">${escHtml(e.due || 'this-week')}</span>`
          : `<select class="exec-due-picker" data-entry-id="${escAttr(e.id)}" data-pod="${escAttr(podScope || '_unit')}">
              <option value="this-week" ${e.due === 'this-week' ? 'selected' : ''}>this week</option>
              <option value="next-week" ${e.due === 'next-week' ? 'selected' : ''}>next week</option>
            </select>`)
      : ''
    const carried = e.carriedFrom ? `<span class="exec-carried">↻ carried from ${escHtml(e.carriedFrom)}</span>` : ''
    const needs = (category === 'issues' && !readonly)
      ? `<label class="exec-needs-label"><input type="checkbox" class="exec-needs-cb" data-entry-id="${escAttr(e.id)}" data-pod="${escAttr(podScope || '_unit')}" ${e.needsFromLeadership ? 'checked' : ''}/> Needs leadership</label>`
      : (e.needsFromLeadership ? `<span class="exec-needs">NEEDS LEADERSHIP</span>` : '')
    const sourceChip = e.sourcePodId ? `<span class="exec-source">from ${escHtml(podNameById(e.sourcePodId))}</span>` : ''
    const promoteBtn = (podScope && !readonly && (category === 'progress' || category === 'issues' || category === 'actions'))
      ? `<button class="exec-promote-btn" data-entry-id="${escAttr(e.id)}" data-pod="${escAttr(podScope)}" data-category="${category}" title="Promote to Unit Headline">↑</button>`
      : ''
    const del = readonly ? '' : `<button class="exec-entry-del" data-entry-id="${escAttr(e.id)}" data-category="${category}" data-pod="${podScope || '_unit'}">×</button>`
    return `<li class="exec-entry" data-entry-id="${escAttr(e.id)}">
      ${sev}<span class="exec-entry-text" contenteditable="${!readonly}">${escHtml(e.text)}</span>
      ${ownerHtml}${dueHtml}${carried}${needs}${sourceChip}${promoteBtn}${del}
    </li>`
  }).join('')
}
```

- [ ] **Step 3: Wire owner / severity / due / needs handlers.**

Append to event wiring:

```javascript
function findEntry(podScope, entryId, category) {
  const list = podScope === '_unit'
    ? wu.unitHeadline[category === 'progress' ? 'wins' : category]
    : wu.pods[podScope]?.[category]
  return list?.find(e => e.id === entryId)
}

panel.querySelectorAll('.exec-owner-picker').forEach(sel => {
  sel.addEventListener('change', async (e) => {
    const li = sel.closest('.exec-entry')
    const entryId = li.dataset.entryId
    const podScope = li.closest('[data-pod]')?.dataset.pod || '_unit'
    // determine category from list parent
    const block = li.closest('.exec-headline-block')
    const labelText = block.querySelector('.exec-headline-label').textContent.trim().toLowerCase()
    const category = labelText.startsWith('issue') ? 'issues' : labelText.startsWith('action') ? 'actions' : 'progress'
    const entry = findEntry(podScope, entryId, category)
    if (!entry) return
    let val = sel.value
    if (val === '__custom__') {
      const name = prompt('Custom owner name:')
      if (!name) { sel.value = ''; return }
      entry.owner = { kind: 'custom', name: name.trim() }
    } else if (val === '') {
      entry.owner = null
    } else {
      const [kind, id, name] = val.split(':')
      entry.owner = { kind, id: id || undefined, name }
    }
    await persistWu()
    buildExecutiveSummaryPanel(cachedData, settings, sortedPods)
  })
})

panel.querySelectorAll('.exec-sev-picker').forEach(sel => {
  sel.addEventListener('change', async () => {
    const entry = findEntry(sel.dataset.pod, sel.dataset.entryId, 'issues')
    if (entry) { entry.severity = sel.value; await persistWu() }
  })
})

panel.querySelectorAll('.exec-due-picker').forEach(sel => {
  sel.addEventListener('change', async () => {
    const entry = findEntry(sel.dataset.pod, sel.dataset.entryId, 'actions')
    if (entry) { entry.due = sel.value; await persistWu() }
  })
})

panel.querySelectorAll('.exec-needs-cb').forEach(cb => {
  cb.addEventListener('change', async () => {
    const entry = findEntry(cb.dataset.pod, cb.dataset.entryId, 'issues')
    if (entry) { entry.needsFromLeadership = cb.checked; await persistWu() }
  })
})
```

- [ ] **Step 4: Manual verify.**

Reload. Add an Issue, set severity = blocker, set owner = a configured team lead. Tick "Needs leadership". Reload tab. Confirm severity badge shows "blocker", owner shows 👑 + name, NEEDS LEADERSHIP shows.

- [ ] **Step 5: Commit.**

```bash
git add board.js
git commit -m "Add owner picker, severity, due, and Needs-leadership controls"
```

---

### Task 14: Promote-to-headline button wiring

**Files:**
- Modify: `board.js`

- [ ] **Step 1: Wire the promote button (already added in Task 13's renderEntryList).**

Append to event wiring:

```javascript
panel.querySelectorAll('.exec-promote-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const podId = btn.dataset.pod
    const category = btn.dataset.category
    const entryId = btn.dataset.entryId
    const list = wu.pods[podId][category]
    const src = list?.find(e => e.id === entryId)
    if (!src) return
    const headlineCategory = category === 'progress' ? 'wins' : category
    const copy = JSON.parse(JSON.stringify(src))
    copy.id = crypto.randomUUID()
    copy.sourcePodId = podId
    wu.unitHeadline[headlineCategory].push(copy)
    await persistWu()
    buildExecutiveSummaryPanel(cachedData, settings, sortedPods)
  })
})
```

- [ ] **Step 2: Manual verify.**

Click ↑ on a pod-level entry. Scroll to top. Confirm a copy lives in Unit Headline with a "from <Pod Name>" chip. Edit the headline copy — confirm the source pod entry is unchanged (independent copy). Delete the source — confirm headline copy survives.

- [ ] **Step 3: Commit.**

```bash
git add board.js
git commit -m "Wire promote-to-headline copy mechanism"
```

---

### Task 15: Auto-Steady for paused pods

**Files:**
- Modify: `board.js`

- [ ] **Step 1: Auto-tick logic when rendering.**

Inside the per-pod loop, just after `if (!wu.pods[pod.id]) wu.pods[pod.id] = emptyPodShape()` and before the steady checkbox is rendered:

```javascript
// Auto-Steady: if pod is paused for the entire selected week, tick steady once
const pause = holidays[pod.id]?._podPaused
if (pause?.paused && !pe._autoSteadyApplied) {
  const weekR = weekRange(selectedWeekKey)
  const resume = pause.resumeDate ? new Date(pause.resumeDate) : null
  // Auto-Steady only if paused covers the whole week (no resume during the week)
  if (!resume || resume > weekR.end) {
    pe.steady = true
    pe._autoSteadyApplied = true
    await persistWu()
  }
}
```

- [ ] **Step 2: Manual verify.**

In settings, mark a pod as paused with no resume date. Open exec summary, current week. Confirm Steady is auto-ticked. Untick, refresh — confirm it stays unticked (the `_autoSteadyApplied` flag prevents re-ticking).

- [ ] **Step 3: Commit.**

```bash
git add board.js
git commit -m "Auto-tick Steady for pods paused across the entire week"
```

---

### Task 16: Finalise / Unlock + read-only state

**Files:**
- Modify: `board.js`

- [ ] **Step 1: Wire Finalise button.**

Append to event wiring:

```javascript
panel.querySelector('.exec-finalise-btn')?.addEventListener('click', async () => {
  // Hard-block: unitName empty
  if (!settings.unitName || !settings.unitName.trim()) {
    alert('Unit Name is required for PDF export. Set it in Options first.')
    return
  }
  // Soft warn: actions without owner
  const allActions = [
    ...wu.unitHeadline.actions,
    ...Object.values(wu.pods).flatMap(p => p.actions || [])
  ]
  const ownerless = allActions.filter(a => !a.owner)
  if (ownerless.length > 0) {
    if (!confirm(`${ownerless.length} action${ownerless.length === 1 ? '' : 's'} have no owner — proceed anyway?`)) return
  }
  wu.finalisedAt = new Date().toISOString()
  await persistWu()
  // Open PDF export tab
  const url = chrome.runtime.getURL('print-export.html') + '?week=' + encodeURIComponent(selectedWeekKey)
  chrome.tabs.create({ url })
  buildExecutiveSummaryPanel(cachedData, settings, sortedPods)
})

panel.querySelector('.exec-reexport-btn')?.addEventListener('click', () => {
  const url = chrome.runtime.getURL('print-export.html') + '?week=' + encodeURIComponent(selectedWeekKey)
  chrome.tabs.create({ url })
})

panel.querySelector('.exec-unlock-btn')?.addEventListener('click', async () => {
  const finalisedDate = wu.finalisedAt ? new Date(wu.finalisedAt).toLocaleDateString('en-GB') : ''
  if (!confirm(`This week was finalised on ${finalisedDate}. Edits will not be re-sent unless you re-export. Continue?`)) return
  // We do NOT clear finalisedAt — leave the audit trail
  // Unlock is a per-render flag instead
  panel.dataset.unlocked = '1'
  buildExecutiveSummaryPanel(cachedData, settings, sortedPods)
})
```

- [ ] **Step 2: Update the read-only check to honour `panel.dataset.unlocked`.**

Replace the line `const readonly = isFinalised` with:

```javascript
const readonly = isFinalised && panel.dataset.unlocked !== '1'
```

- [ ] **Step 3: Manual verify.**

With Unit Name unset: click Finalise → expect alert, not finalised. Set Unit Name in Options. Try Finalise with one ownerless action — confirm soft warning. Confirm. Tab opens to print-export.html (which doesn't exist yet — that's fine for now; expect a 404). Status badge now shows ✓ Finalised. Read-only state: edits / + buttons / × buttons hidden. Click Unlock → confirm dialog → confirm → form returns to editable.

(The print-export 404 is expected at this task; it's wired up in Phase 4.)

- [ ] **Step 4: Commit.**

```bash
git add board.js
git commit -m "Wire Finalise, Unlock, and Re-export flows on exec summary"
```

---

## Phase 4 — PDF export

### Task 17: `print-export.html` + `manifest.json` web_accessible_resources

**Files:**
- Create: `print-export.html`
- Modify: `manifest.json`

- [ ] **Step 1: Create `print-export.html`.**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Weekly Pod Status</title>
  <link rel="stylesheet" href="print-export.css" />
</head>
<body>
  <div id="print-root">
    <p class="loading">Preparing PDF...</p>
  </div>
  <script src="shared.js"></script>
  <script src="weekly-update.js"></script>
  <script src="print-export.js"></script>
</body>
</html>
```

- [ ] **Step 2: Add `web_accessible_resources` to `manifest.json`.**

Read the current manifest, then add (or extend) the `web_accessible_resources` array to include the new files:

```json
"web_accessible_resources": [
  {
    "resources": ["print-export.html", "print-export.js", "print-export.css", "shared.js", "weekly-update.js"],
    "matches": ["<all_urls>"]
  }
]
```

If `web_accessible_resources` already exists, merge — do not duplicate.

- [ ] **Step 3: Reload extension; manual verify the URL is reachable.**

In the address bar, paste `chrome-extension://<your-extension-id>/print-export.html` (the ID is shown on `chrome://extensions`). Expect to see `Preparing PDF...`.

- [ ] **Step 4: Commit.**

```bash
git add print-export.html manifest.json
git commit -m "Add print-export page and web_accessible_resources entry"
```

---

### Task 18: `print-export.js` — load data, render layout

**Files:**
- Create: `print-export.js`

- [ ] **Step 1: Create the file with full layout rendering.**

```javascript
// print-export.js — Render the executive PDF layout for a given week
// and trigger window.print(). Reads ?week=YYYY-Www from URL.

(async function main() {
  const params = new URLSearchParams(location.search)
  const weekKey = params.get('week')
  if (!weekKey) {
    document.getElementById('print-root').innerHTML = '<p>Missing ?week parameter.</p>'
    return
  }

  const settings = await getSettings()
  const wu = await getWeeklyUpdate(weekKey)
  const cachedData = await new Promise(resolve =>
    chrome.storage.local.get('cachedData', r => resolve(r.cachedData || { pods: {} })))

  const range = weekRange(weekKey)
  const pods = settings.pods || []
  const teamLeads = settings.teamLeads || []

  document.title = `Weekly Pod Status — ${settings.unitName || 'Unit'} — ${weekKey}.pdf`

  const podsWithEntries = pods.filter(p => {
    const pe = wu.pods?.[p.id]
    if (!pe || pe.steady) return false
    return (pe.progress?.length || 0) + (pe.issues?.length || 0) + (pe.actions?.length || 0) > 0
  })
  const steadyPods = pods.filter(p => wu.pods?.[p.id]?.steady || (!wu.pods?.[p.id] && !podsWithEntries.includes(p)))

  // Aggregate KPIs from cached data
  const allItems = []
  for (const podId of Object.keys(cachedData.pods || {})) {
    for (const it of (cachedData.pods[podId].items || [])) allItems.push(it)
  }
  const tp = calcWeeklyThroughput(allItems, 8)
  const arr = calcWeeklyArrival(allItems, 8)
  const tpLast = tp[tp.length - 2]?.count ?? '—'
  const tpPrev = tp[tp.length - 3]?.count ?? null
  const arrLast = arr[arr.length - 2]?.count ?? '—'
  const arrPrev = arr[arr.length - 3]?.count ?? null
  const stale = calcStaleItems(allItems, settings.staleDays || 2)
  const wipItems = allItems.filter(i => !['Closed','Removed','Resolved'].includes(i.state))
  const wip = wipItems.length

  function dlt(curr, prev) {
    if (prev == null || curr === '—') return ''
    const d = curr - prev
    if (d === 0) return ' (→)'
    return ` (${d > 0 ? '↑' : '↓'}${Math.abs(d)})`
  }

  // Ownership roll-up
  const allActions = [
    ...wu.unitHeadline.actions,
    ...Object.values(wu.pods || {}).flatMap(p => p.actions || [])
  ]
  const byOwner = {}
  for (const a of allActions) {
    const k = a.owner ? a.owner.name : 'Unassigned'
    byOwner[k] = (byOwner[k] || 0) + 1
  }

  function renderEntry(e, includeOwner) {
    const sev = e.severity ? `<span class="sev sev-${e.severity}">${e.severity.toUpperCase()}</span> ` : ''
    const needs = e.needsFromLeadership ? ' <span class="needs">NEEDS LEADERSHIP</span>' : ''
    const owner = includeOwner && e.owner ? ` · <span class="owner">${e.owner.kind === 'lead' ? '👑 ' : ''}${escHtml(e.owner.name)}</span>` : ''
    const due = e.due ? ` · due ${escHtml(e.due)}` : ''
    const carried = e.carriedFrom ? ` <span class="carried">↻ carried from ${escHtml(e.carriedFrom)}</span>` : ''
    const src = e.sourcePodId ? ` <span class="src">from ${escHtml((pods.find(p => p.id === e.sourcePodId) || {}).name || e.sourcePodId)}</span>` : ''
    return `<li>${sev}${escHtml(e.text)}${owner}${due}${carried}${src}${needs}</li>`
  }

  let html = ''
  html += `
    <header>
      <h1>Weekly Pod Status — ${escHtml(settings.unitName || 'Unit')}</h1>
      <div class="meta">Week of ${escHtml(range.label)} · Finalised ${wu.finalisedAt ? new Date(wu.finalisedAt).toLocaleDateString('en-GB') : '—'}</div>
      <div class="meta">Pods covered: ${pods.length} (${podsWithEntries.length} with updates · ${pods.length - podsWithEntries.length} steady)</div>
    </header>
    <section class="page-1">
      <h2>Highlights</h2>
      <ul class="highlights">${wu.unitHeadline.wins.map(e => renderEntry(e, false)).join('') || '<li class="muted">No headline wins recorded.</li>'}</ul>
      <h2>Key Issues</h2>
      <ul class="key-issues">${wu.unitHeadline.issues.map(e => renderEntry(e, true)).join('') || '<li class="muted">No headline issues recorded.</li>'}</ul>
      <h2>Actions Next Week</h2>
      <ul class="actions">${wu.unitHeadline.actions.map(e => renderEntry(e, true)).join('') || '<li class="muted">No headline actions recorded.</li>'}</ul>
      <h2>At a Glance</h2>
      <div class="at-a-glance">
        Arrival ${arrLast}${dlt(arrLast, arrPrev)} ·
        Throughput ${tpLast}${dlt(tpLast, tpPrev)} ·
        Active WIP ${wip} ·
        Stale/Blocked ${stale.total}
      </div>
      <div class="actions-by-lead">
        Actions next week by lead:
        ${Object.entries(byOwner).map(([k, n]) =>
          `<span class="${k === 'Unassigned' ? 'unassigned' : ''}">${escHtml(k)} ${n}</span>`).join(' · ') || 'no actions'}
      </div>
    </section>
  `

  if (podsWithEntries.length > 0) {
    html += `<section class="pod-detail"><h2>Pod Detail</h2>`
    for (const pod of podsWithEntries) {
      const pe = wu.pods[pod.id]
      html += `
        <div class="pod-card">
          <h3>${escHtml(pod.name)}</h3>
          ${pe.progress.length ? `<div><strong>Progress</strong><ul>${pe.progress.map(e => renderEntry(e, false)).join('')}</ul></div>` : ''}
          ${pe.issues.length ? `<div><strong>Issues</strong><ul>${pe.issues.map(e => renderEntry(e, true)).join('')}</ul></div>` : ''}
          ${pe.actions.length ? `<div><strong>Actions</strong><ul>${pe.actions.map(e => renderEntry(e, true)).join('')}</ul></div>` : ''}
        </div>
      `
    }
    html += `</section>`
  }

  if (steadyPods.length > 0) {
    html += `<footer class="steady-footer">Steady this week: ${steadyPods.map(p => escHtml(p.name)).join(' · ')}</footer>`
  }

  document.getElementById('print-root').innerHTML = html

  // Trigger print after layout settles
  setTimeout(() => window.print(), 200)
})()
```

- [ ] **Step 2: Manual verify (renders, even if styling is rough).**

In the exec summary, finalise a week (with at least one entry). Verify the new tab opens, content renders, print dialog appears. Cancel the print dialog — content stays on screen for inspection.

- [ ] **Step 3: Commit.**

```bash
git add print-export.js
git commit -m "Render PDF executive layout from finalised week data"
```

---

### Task 19: `print-export.css` — A4 portrait print stylesheet

**Files:**
- Create: `print-export.css`

- [ ] **Step 1: Write the stylesheet.**

```css
/* print-export.css — A4 portrait, 11pt body, severity colours */

@page { size: A4 portrait; margin: 18mm; }

body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 11pt;
  line-height: 1.4;
  color: #111;
  margin: 0;
}

#print-root { max-width: 100%; }

.loading { color: #666; font-style: italic; }

header { margin-bottom: 16px; }
header h1 { font-size: 18pt; margin: 0 0 4px 0; }
header .meta { font-size: 9pt; color: #555; }

h2 { font-size: 14pt; margin: 12px 0 4px 0; padding-bottom: 2px; border-bottom: 1px solid #ddd; }
h3 { font-size: 12pt; margin: 8px 0 4px 0; }

ul { margin: 4px 0 8px 18px; padding: 0; }
li { margin: 2px 0; }
li.muted { color: #888; font-style: italic; }

.sev { font-size: 8pt; padding: 1px 5px; border-radius: 2px; color: white; font-weight: 700; vertical-align: middle; }
.sev-blocker { background: #dc2626; }
.sev-risk    { background: #d97706; }
.sev-watch   { background: #0891b2; }

.needs { background: #fef3c7; color: #92400e; padding: 1px 5px; border-radius: 2px; font-size: 8pt; font-weight: 700; }
.owner { font-weight: 600; }
.carried { color: #6366f1; font-size: 9pt; }
.src { color: #777; font-size: 9pt; font-style: italic; }

.at-a-glance {
  font-size: 11pt;
  background: #f3f4f6;
  padding: 6px 10px;
  border-radius: 4px;
  margin: 6px 0;
}

.actions-by-lead {
  font-size: 10pt;
  margin: 4px 0;
  padding: 4px 0;
}
.actions-by-lead .unassigned { color: #dc2626; font-weight: 700; }

.page-1 { page-break-after: always; }

.pod-card {
  page-break-inside: avoid;
  margin-bottom: 10px;
  padding: 6px 10px;
  border-left: 3px solid #6366f1;
  background: #fafafa;
}

.steady-footer {
  margin-top: 16px;
  padding-top: 8px;
  border-top: 1px solid #ddd;
  font-size: 9pt;
  color: #555;
}

@media print {
  /* Hide any browser-injected chrome that might leak through */
  body { background: white; }
}
```

- [ ] **Step 2: Manual verify.**

Reload extension, finalise a week, in the print dialog → "Save as PDF" → Save. Open the PDF. Verify:
- Page 1 fits A4 portrait
- Highlights / Key Issues / Actions / At a Glance / Actions-by-lead all present
- Page 2 starts with Pod Detail
- Severity badges are coloured
- Footer roll-up appears at the very end

- [ ] **Step 3: Commit.**

```bash
git add print-export.css
git commit -m "Add A4 portrait print stylesheet for weekly PDF"
```

---

## Phase 5 — Wrap-up

### Task 20: Steady-this-week footer in the on-screen exec summary

**Files:**
- Modify: `board.js`

- [ ] **Step 1: Add the footer at the end of the exec summary panel.**

After the per-pod loop (after the closing `html += '</div>'` near line 1252) and before `panel.innerHTML = html`:

```javascript
const steadyPods = pods.filter(p => wu.pods?.[p.id]?.steady)
if (steadyPods.length > 0) {
  html += `<div class="exec-steady-footer">Steady this week: ${steadyPods.map(p => escHtml(p.name)).join(' · ')}</div>`
}
```

CSS:

```css
.exec-steady-footer { margin: 16px 0; padding: 8px 12px; background: var(--card-bg); border-radius: 4px; font-size: .85rem; color: var(--muted); }
```

- [ ] **Step 2: Manual verify.**

Tick Steady on 2 pods, scroll to the bottom of the exec summary, confirm footer appears and lists their names.

- [ ] **Step 3: Commit.**

```bash
git add board.js board.html
git commit -m "Add Steady-this-week footer to exec summary"
```

---

### Task 21: CHANGELOG entry + breaking-change note

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add a new entry at the top of `CHANGELOG.md`.**

Read the existing format first:

```bash
head -30 CHANGELOG.md
```

Then prepend a new section matching that format:

```markdown
## [Unreleased]

### Added
- **Weekly pod status update** on the Executive Summary tab: structured Progress / Issues / Actions per pod, Unit-level Highlights, ISO-week history, auto-suggestions from cached data, carry-over detection on actions.
- **Team Leads** management on the Options page, with multi-pod assignment.
- **Unit Name** setting (required for PDF export).
- **PDF export** of the weekly status as an A4 portrait artifact via native browser print.

### Changed
- **BREAKING: `calcStaleItems` widened** to include items in any non-terminal, non-intake state (Resolved, QA Complete, Ready for Release, In Review, In Progress). Was: Active only. Items stuck in those states past the staleDays threshold now count toward stale totals on the popup, exec summary KPIs, pod health badges, and stale-items table. Existing dashboards may show higher counts on next refresh — these items were always there; the calculation now surfaces them.
- Stale-items table now displays the item's current state alongside the column.

### Fixed
- (none for this release)
```

- [ ] **Step 2: Commit.**

```bash
git add CHANGELOG.md
git commit -m "Document weekly status update feature and stale-calc widening"
```

---

### Task 22: End-to-end manual verification

**Files:** none (verification step only)

- [ ] **Step 1: Configure a fresh test environment.**

In `chrome://extensions`, reload the extension. In Options:
- Set Unit Name to "Acme Unit Test"
- Add 2 team leads, assign each to 2 pods
- Confirm the existing pods configuration is intact

- [ ] **Step 2: Verify all three UI surfaces (per project rule).**

1. **Popup:** Open. Confirm aged counts show. Stale numbers may be higher than before — that's expected.
2. **Board → Overview tab:** Confirm KPIs render. Stale figure may be higher.
3. **Board → Exec Summary tab:** Confirm:
   - Toolbar (week selector, status badge, Finalise button)
   - Default selected week = last completed week
   - Unit Headline section with three add buttons
   - Each pod card has Steady checkbox, Auto-suggestions block, Progress / Issues / Actions
   - WoW table, predictability, predictions, Meeting Notes textarea all still render below

- [ ] **Step 3: Author a complete week's update.**

Switch to the current week. Across 3 pods:
- Promote 1 throughput-up suggestion to Progress
- Add a Blocker issue with `needsFromLeadership: true` and team-lead owner
- Add 2 actions, one with team-lead owner, one without
- On a 4th pod, tick Steady

Promote one pod-level entry to the Unit Headline using ↑.

- [ ] **Step 4: Test Finalise.**

Click Finalise & Export PDF.
- Soft warn fires (one ownerless action). Confirm.
- Print-export tab opens.
- Save as PDF. Open the PDF.

Verify:
- Page 1 has Highlights / Key Issues / Actions / At a Glance / Actions-by-lead
- Page 2 has Pod Detail for the 3 pods with entries (NOT the steady one)
- Steady footer at the end lists the steady pod
- Severity badges are coloured
- 👑 chip on team-lead owners
- "NEEDS LEADERSHIP" highlighted on the bat-signal issue
- "Unassigned" appears in red in the actions-by-lead roll-up

- [ ] **Step 5: Test Unlock + Re-export.**

Back on the board. Status badge = ✓ Finalised. Click Unlock → confirm dialog → confirm. Edit one entry. Click Re-export → new PDF reflects the edit.

- [ ] **Step 6: Test history navigation.**

Use ◀ to navigate to the previous week. Confirm the data is whatever was there (or empty shape if none). No suggestions block on weeks older than current/last-completed.

- [ ] **Step 7: Test carry-over detection.**

Add an action this week with text "Triage QA backlog". Switch to the previous week, also add an action with the same text. Switch back to this week — confirm the action shows `↻ carried from <prev week>`.

- [ ] **Step 8: If anything fails, file a follow-up task. If all green, commit nothing further and move on to release prep.**

```bash
git status   # should be clean
git log --oneline  # review commit chain
```

---

## Out of scope (deferred from spec §11)

These are intentionally NOT in this plan:
- Cross-unit synchronisation (Phase 2 if format proves itself).
- Per-entry "done" marking on actions.
- Click-through from PDF to ADO work items (PDF dialog can lose hyperlinks in some environments).

## Notes

- **Branch:** `claude/weekly-pod-status` — spec already at `acae641`.
- **CI:** `node test-node.js` runs on every push via `.github/workflows/test.yml`. Every TDD task must leave the suite green.
- **Manual testing:** required after every Phase-3 and Phase-4 task because the project has no UI test framework.
- **Total tasks:** 22 (17 implementation + 5 wrap-up/verify).
