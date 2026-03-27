// test.js — Lightweight test runner for shared.js pure functions
// Open test.html in Chrome to run. No dependencies required.

const _results = []
let _currentGroup = ''

function group(name) { _currentGroup = name }

function test(name, fn) {
  try {
    fn()
    _results.push({ group: _currentGroup, name, pass: true })
  } catch (err) {
    _results.push({ group: _currentGroup, name, pass: false, error: err.message })
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed')
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(msg || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function assertClose(actual, expected, tolerance, msg) {
  if (Math.abs(actual - expected) > tolerance) throw new Error(msg || `Expected ~${expected}, got ${actual}`)
}

// ─── Test Data Helpers ────────────────────────────────────────────────────────

function daysAgo(n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString()
}

function makeItem(overrides = {}) {
  return {
    id: Math.floor(Math.random() * 100000),
    type: 'User Story',
    state: 'Active',
    priority: 2,
    assignee: 'Test User',
    boardColumn: 'In Progress',
    created: daysAgo(30),
    changedDate: daysAgo(1),
    arrivedAt: daysAgo(20),
    closed: null,
    resolved: null,
    startedAt: null,
    targetPI: null,
    url: null,
    ...overrides
  }
}

// ─── weekBuckets ──────────────────────────────────────────────────────────────

group('weekBuckets')

test('returns correct number of buckets', () => {
  assertEqual(weekBuckets(8).length, 8)
  assertEqual(weekBuckets(4).length, 4)
  assertEqual(weekBuckets(12).length, 12)
})

test('buckets are ordered oldest to newest', () => {
  const b = weekBuckets(4)
  assert(b[0].start < b[1].start, 'First bucket should be oldest')
  assert(b[2].start < b[3].start, 'Last bucket should be newest')
})

test('each bucket spans exactly 7 days', () => {
  const b = weekBuckets(4)
  for (const bucket of b) {
    const diff = bucket.end - bucket.start
    const days = diff / 86400000
    assertClose(days, 7, 0.01, `Bucket spans ${days} days, expected ~7`)
  }
})

test('last bucket contains today', () => {
  const b = weekBuckets(4)
  const last = b[b.length - 1]
  const now = new Date()
  assert(now >= last.start && now <= last.end, 'Today should be in last bucket')
})

// ─── calcWeeklyArrival ────────────────────────────────────────────────────────

group('calcWeeklyArrival')

test('counts items arriving in each week', () => {
  const items = [
    makeItem({ arrivedAt: daysAgo(1) }),
    makeItem({ arrivedAt: daysAgo(2) }),
    makeItem({ arrivedAt: daysAgo(50) })
  ]
  const result = calcWeeklyArrival(items, 8)
  assertEqual(result.length, 8)
  // Last bucket should have the 2 recent items
  const lastCount = result[result.length - 1].count
  assert(lastCount >= 2, `Expected >=2 items in last week, got ${lastCount}`)
})

test('uses created date as fallback when arrivedAt is null', () => {
  const items = [makeItem({ arrivedAt: null, created: daysAgo(1) })]
  const result = calcWeeklyArrival(items, 4)
  const total = result.reduce((s, w) => s + w.count, 0)
  assertEqual(total, 1, 'Item should be counted using created date')
})

test('returns zero counts for empty items', () => {
  const result = calcWeeklyArrival([], 4)
  assertEqual(result.length, 4)
  assert(result.every(w => w.count === 0), 'All counts should be 0')
})

// ─── calcWeeklyThroughput ─────────────────────────────────────────────────────

group('calcWeeklyThroughput')

test('counts closed and resolved items', () => {
  const items = [
    makeItem({ closed: daysAgo(1) }),
    makeItem({ closed: null, resolved: daysAgo(2) }),
    makeItem({ closed: null, resolved: null }) // active — not counted
  ]
  const result = calcWeeklyThroughput(items, 4)
  const total = result.reduce((s, w) => s + w.count, 0)
  assertEqual(total, 2)
})

test('excludes Spikes from throughput', () => {
  const items = [
    makeItem({ closed: daysAgo(1), type: 'Spike' }),
    makeItem({ closed: daysAgo(1), type: 'Bug' })
  ]
  const result = calcWeeklyThroughput(items, 4)
  const total = result.reduce((s, w) => s + w.count, 0)
  assertEqual(total, 1, 'Spikes should be excluded')
})

// ─── calcWeeklyThroughputPerPerson ────────────────────────────────────────────

group('calcWeeklyThroughputPerPerson')

test('calculates per-person rate', () => {
  const items = [
    makeItem({ closed: daysAgo(1), assignee: 'Alice' }),
    makeItem({ closed: daysAgo(1), assignee: 'Bob' }),
    makeItem({ closed: daysAgo(2), assignee: 'Alice' })
  ]
  const result = calcWeeklyThroughputPerPerson(items, 4)
  const last = result[result.length - 1]
  assertEqual(last.count, 3)
  assertEqual(last.numPeople, 2)
  assertEqual(last.perPerson, 1.5)
})

test('excludes items without assignee', () => {
  const items = [
    makeItem({ closed: daysAgo(1), assignee: null }),
    makeItem({ closed: daysAgo(1), assignee: 'Alice' })
  ]
  const result = calcWeeklyThroughputPerPerson(items, 4)
  const last = result[result.length - 1]
  assertEqual(last.count, 1)
})

// ─── calcAgeDistribution ──────────────────────────────────────────────────────

group('calcAgeDistribution')

test('groups active items into age bands', () => {
  const items = [
    makeItem({ arrivedAt: daysAgo(3), state: 'Active' }),
    makeItem({ arrivedAt: daysAgo(10), state: 'Active' }),
    makeItem({ arrivedAt: daysAgo(45), state: 'Active' }),
    makeItem({ arrivedAt: daysAgo(100), state: 'Active' }),
    makeItem({ state: 'Closed' }) // should be excluded
  ]
  const result = calcAgeDistribution(items)
  assertEqual(result.length, 6, 'Should have 6 age bands')
  const total = result.reduce((s, b) => s + b.count, 0)
  assertEqual(total, 4, 'Should count only active items')
})

test('returns zero counts for no active items', () => {
  const items = [makeItem({ state: 'Closed' })]
  const result = calcAgeDistribution(items)
  assert(result.every(b => b.count === 0), 'All bands should be 0')
})

// ─── calcStaleItems ───────────────────────────────────────────────────────────

group('calcStaleItems')

test('identifies stale items by changedDate', () => {
  const items = [
    makeItem({ changedDate: daysAgo(30), state: 'Active', boardColumn: 'In Progress' }),
    makeItem({ changedDate: daysAgo(1), state: 'Active' }),
    makeItem({ changedDate: daysAgo(20), state: 'Closed' }) // closed — excluded
  ]
  const result = calcStaleItems(items, 14)
  assertEqual(result.total, 1)
  assertEqual(result.byColumn[0].col, 'In Progress')
})

test('returns zero for no stale items', () => {
  const items = [makeItem({ changedDate: daysAgo(1), state: 'Active' })]
  const result = calcStaleItems(items, 14)
  assertEqual(result.total, 0)
  assertEqual(result.byColumn.length, 0)
})

// ─── calcBugRatioTrend ────────────────────────────────────────────────────────

group('calcBugRatioTrend')

test('calculates bug percentage per week', () => {
  const items = [
    makeItem({ closed: daysAgo(1), type: 'Bug' }),
    makeItem({ closed: daysAgo(1), type: 'User Story' }),
    makeItem({ closed: daysAgo(2), type: 'Bug' })
  ]
  const result = calcBugRatioTrend(items, 4)
  const last = result[result.length - 1]
  assertEqual(last.total, 3)
  assertEqual(last.bugs, 2)
  assertEqual(last.pct, 67)
})

test('returns 0% for weeks with no items', () => {
  const result = calcBugRatioTrend([], 4)
  assert(result.every(w => w.pct === 0), 'All weeks should be 0%')
})

// ─── calcThroughputPredictability ─────────────────────────────────────────────

group('calcThroughputPredictability')

test('returns null for fewer than 2 weeks', () => {
  const result = calcThroughputPredictability([], 1)
  assertEqual(result, null)
})

test('stable throughput yields low CV', () => {
  // Create items with exactly 2 per week for 4 weeks
  const items = []
  for (let w = 0; w < 4; w++) {
    items.push(makeItem({ closed: daysAgo(w * 7 + 1) }))
    items.push(makeItem({ closed: daysAgo(w * 7 + 2) }))
  }
  const result = calcThroughputPredictability(items, 4)
  if (result) {
    assert(result.cv <= 0.5, `CV should be low for stable throughput, got ${result.cv}`)
    assert(result.rating === 'Stable' || result.rating === 'Moderate', `Expected Stable/Moderate, got ${result.rating}`)
  }
})

// ─── calcFlowEfficiency ───────────────────────────────────────────────────────

group('calcFlowEfficiency')

test('calculates percentage from cycle time data', () => {
  const ctData = [
    { inProgressToClose: 5, arrivalToClose: 10 },
    { inProgressToClose: 3, arrivalToClose: 6 }
  ]
  const result = calcFlowEfficiency(ctData)
  assertEqual(result.pct, 50)
  assertEqual(result.count, 2)
})

test('returns null for empty data', () => {
  assertEqual(calcFlowEfficiency([]), null)
})

test('filters items with null values', () => {
  const ctData = [
    { inProgressToClose: null, arrivalToClose: 10 },
    { inProgressToClose: 3, arrivalToClose: 6 }
  ]
  const result = calcFlowEfficiency(ctData)
  assertEqual(result.count, 1)
  assertEqual(result.pct, 50)
})

// ─── calcCumulativeFlow ───────────────────────────────────────────────────────

group('calcCumulativeFlow')

test('cumulative counts increase monotonically', () => {
  const items = [
    makeItem({ arrivedAt: daysAgo(20) }),
    makeItem({ arrivedAt: daysAgo(10) }),
    makeItem({ arrivedAt: daysAgo(5), closed: daysAgo(1) })
  ]
  const result = calcCumulativeFlow(items, 4)
  for (let i = 1; i < result.length; i++) {
    assert(result[i].arrived >= result[i - 1].arrived, 'Arrivals must be monotonically increasing')
    assert(result[i].closed >= result[i - 1].closed, 'Closures must be monotonically increasing')
  }
})

// ─── calcCycleTimes ───────────────────────────────────────────────────────────

group('calcCycleTimes')

test('calculates days from arrival to close', () => {
  const items = [
    makeItem({ arrivedAt: daysAgo(15), closed: daysAgo(5), startedAt: daysAgo(12) })
  ]
  const result = calcCycleTimes(items)
  assertEqual(result.length, 1)
  assertEqual(result[0].arrivalToClose, 10)
  assertEqual(result[0].inProgressToClose, 7)
})

test('excludes items closed more than 90 days ago', () => {
  const items = [makeItem({ arrivedAt: daysAgo(120), closed: daysAgo(100) })]
  const result = calcCycleTimes(items)
  assertEqual(result.length, 0)
})

test('handles missing startedAt', () => {
  const items = [makeItem({ arrivedAt: daysAgo(10), closed: daysAgo(2), startedAt: null })]
  const result = calcCycleTimes(items)
  assertEqual(result.length, 1)
  assertEqual(result[0].arrivalToClose, 8)
  assertEqual(result[0].inProgressToClose, null)
})

// ─── calcNewStackRank ─────────────────────────────────────────────────────────

group('calcNewStackRank')

test('midpoint between two ranks', () => {
  assertEqual(calcNewStackRank(10, 20), 15)
})

test('above only — adds 1', () => {
  assertEqual(calcNewStackRank(10, null), 11)
})

test('below only — subtracts 1', () => {
  assertEqual(calcNewStackRank(null, 10), 9)
})

test('both null — returns 1', () => {
  assertEqual(calcNewStackRank(null, null), 1)
})

// ─── calcPriorityAgeDistribution ──────────────────────────────────────────────

group('calcPriorityAgeDistribution')

test('groups by priority and age band', () => {
  const items = [
    makeItem({ priority: 1, arrivedAt: daysAgo(5), state: 'Active' }),
    makeItem({ priority: 2, arrivedAt: daysAgo(40), state: 'Active' }),
    makeItem({ priority: 3, arrivedAt: daysAgo(100), state: 'Active' })
  ]
  const result = calcPriorityAgeDistribution(items)
  assertEqual(result.bands.length, 5)
  assert(result.priorities.length > 0, 'Should have priority rows')
  const totalCounts = result.priorities.reduce((s, p) => s + p.counts.reduce((a, b) => a + b, 0), 0)
  assertEqual(totalCounts, 3)
})

// ─── calcWeeklyWIP ────────────────────────────────────────────────────────────

group('calcWeeklyWIP')

test('active items are counted at week boundaries', () => {
  const items = [
    makeItem({ created: daysAgo(30), closed: null }), // still active
    makeItem({ created: daysAgo(30), closed: daysAgo(20) }) // closed 20 days ago
  ]
  const result = calcWeeklyWIP(items, 4)
  assertEqual(result.length, 4)
  // Last week should have 1 active item
  const last = result[result.length - 1]
  assertEqual(last.value, 1)
})

// ─── hashStr ──────────────────────────────────────────────────────────────────

group('hashStr')

test('same input produces same output', () => {
  assertEqual(hashStr('Alice'), hashStr('Alice'))
  assertEqual(hashStr('Bob'), hashStr('Bob'))
})

test('different inputs produce different outputs', () => {
  assert(hashStr('Alice') !== hashStr('Bob'), 'Different names should hash differently')
})

test('returns unsigned 32-bit integer', () => {
  const h = hashStr('Test')
  assert(h >= 0, 'Hash should be non-negative')
  assert(h <= 0xFFFFFFFF, 'Hash should fit in 32 bits')
})

// ─── escSvg ───────────────────────────────────────────────────────────────────

group('escSvg')

test('escapes HTML entities', () => {
  assertEqual(escSvg('<script>'), '&lt;script&gt;')
  assertEqual(escSvg('a & b'), 'a &amp; b')
  assertEqual(escSvg('"hello"'), '&quot;hello&quot;')
})

test('passes through safe strings', () => {
  assertEqual(escSvg('Hello World'), 'Hello World')
  assertEqual(escSvg('123'), '123')
})

test('converts non-strings', () => {
  assertEqual(escSvg(42), '42')
  assertEqual(escSvg(null), 'null')
})

// ─── columnCounts ─────────────────────────────────────────────────────────────

group('columnCounts')

test('counts items per board column', () => {
  const items = [
    makeItem({ boardColumn: 'In Progress' }),
    makeItem({ boardColumn: 'In Progress' }),
    makeItem({ boardColumn: 'Ready' })
  ]
  const result = columnCounts(items)
  assertEqual(result['In Progress'], 2)
  assertEqual(result['Ready'], 1)
})

// ─── colCount ─────────────────────────────────────────────────────────────────

group('colCount')

test('sums counts matching keywords case-insensitively', () => {
  const cols = { 'Intake/Triage': 3, 'In Progress': 5, 'Ready': 2 }
  assertEqual(colCount(cols, 'triage'), 3)
  assertEqual(colCount(cols, 'progress'), 5)
  assertEqual(colCount(cols, 'triage', 'ready'), 5)
})

// ─── calcBurndown ─────────────────────────────────────────────────────────────

group('calcBurndown')

test('returns empty for no matching PI', () => {
  const items = [makeItem({ targetPI: 'PI-1' })]
  assertEqual(calcBurndown(items, 'PI-999').length, 0)
})

test('remaining count decreases as items close', () => {
  const items = [
    makeItem({ targetPI: 'PI-1', closed: null }),
    makeItem({ targetPI: 'PI-1', closed: daysAgo(5) }),
    makeItem({ targetPI: 'PI-1', closed: daysAgo(50) })
  ]
  const result = calcBurndown(items, 'PI-1')
  assert(result.length > 0, 'Should have burndown data')
  // Last bucket: 1 still open
  const last = result[result.length - 1]
  assertEqual(last.remaining, 1)
})

// ─── ageDays ──────────────────────────────────────────────────────────────────

group('ageDays')

test('calculates days since arrival', () => {
  const item = makeItem({ arrivedAt: daysAgo(10) })
  assertClose(ageDays(item), 10, 1)
})

test('falls back to created date', () => {
  const item = makeItem({ arrivedAt: null, created: daysAgo(5) })
  assertClose(ageDays(item), 5, 1)
})

// ─── assigneeColor ────────────────────────────────────────────────────────────

group('assigneeColor (hash-based)')

test('returns consistent color for same name', () => {
  assertEqual(assigneeColor('Alice'), assigneeColor('Alice'))
})

test('returns fallback for null', () => {
  assertEqual(assigneeColor(null), '#475569')
})

test('returns a color from the palette', () => {
  const color = assigneeColor('TestPerson')
  assert(ASSIGNEE_COLORS.includes(color), `${color} should be in ASSIGNEE_COLORS`)
})

// ─── Render Results ───────────────────────────────────────────────────────────

;(() => {
  const passed = _results.filter(r => r.pass).length
  const failed = _results.filter(r => !r.pass).length
  const total = _results.length

  const summaryEl = document.getElementById('summary')
  summaryEl.className = `summary ${failed > 0 ? 'fail' : 'pass'}`
  summaryEl.textContent = `${passed}/${total} passed` + (failed > 0 ? ` — ${failed} FAILED` : ' ✓')

  const resultsEl = document.getElementById('results')
  let currentGroup = ''
  for (const r of _results) {
    if (r.group !== currentGroup) {
      currentGroup = r.group
      const groupEl = document.createElement('div')
      groupEl.className = 'group-name'
      groupEl.textContent = currentGroup
      resultsEl.appendChild(groupEl)
    }
    const el = document.createElement('div')
    el.className = `result ${r.pass ? 'pass' : 'fail'}`
    el.textContent = r.pass ? `✓ ${r.name}` : `✗ ${r.name} — ${r.error}`
    resultsEl.appendChild(el)
  }

  // Also log to console for CI or headless use
  console.log(`\n${passed}/${total} passed${failed > 0 ? ` — ${failed} FAILED` : ''}`)
  for (const r of _results.filter(r => !r.pass)) {
    console.error(`  FAIL: ${r.group} > ${r.name} — ${r.error}`)
  }
})()
