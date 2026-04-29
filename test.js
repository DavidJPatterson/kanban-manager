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
    boardLane: null,
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

test('each bucket spans Monday to Sunday', () => {
  const b = weekBuckets(4)
  for (const bucket of b) {
    assertEqual(bucket.start.getDay(), 1, 'Bucket should start on Monday')
    assertEqual(bucket.end.getDay(), 0, 'Bucket should end on Sunday')
    assertEqual(bucket.end.getHours(), 23, 'Bucket end should be 23:59:59')
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
  // Use bucket midpoints to guarantee items land inside buckets
  const buckets = weekBuckets(8)
  const midFirst = new Date((buckets[0].start.getTime() + buckets[0].end.getTime()) / 2)
  const items = [
    makeItem({ arrivedAt: daysAgo(0) }),
    makeItem({ arrivedAt: daysAgo(0) }),
    makeItem({ arrivedAt: midFirst.toISOString() })
  ]
  const result = calcWeeklyArrival(items, 8)
  assertEqual(result.length, 8)
  const total = result.reduce((s, w) => s + w.count, 0)
  assertEqual(total, 3, 'All 3 items should be counted across buckets')
  assertEqual(result[result.length - 1].count, 2, 'Last bucket should have 2 items')
  assertEqual(result[0].count, 1, 'First bucket should have 1 item')
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

test('count only includes closed items, resolved tracked separately', () => {
  const items = [
    makeItem({ closed: daysAgo(1) }),
    makeItem({ closed: null, resolved: daysAgo(2) }), // resolved only — not in count
    makeItem({ closed: null, resolved: null }) // active — not counted
  ]
  const result = calcWeeklyThroughput(items, 4)
  const totalCount = result.reduce((s, w) => s + w.count, 0)
  const totalResolved = result.reduce((s, w) => s + w.resolved, 0)
  assertEqual(totalCount, 1, 'count should only include closed items')
  assertEqual(totalResolved, 1, 'resolved should track resolved-only items')
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
    makeItem({ closed: daysAgo(0), assignee: 'Alice' }),
    makeItem({ closed: daysAgo(0), assignee: 'Bob' }),
    makeItem({ closed: daysAgo(0), assignee: 'Alice' })
  ]
  const result = calcWeeklyThroughputPerPerson(items, 4)
  const last = result[result.length - 1]
  assertEqual(last.count, 3)
  assertEqual(last.numPeople, 2)
  assertEqual(last.perPerson, 1.5)
})

test('excludes items without assignee', () => {
  const items = [
    makeItem({ closed: daysAgo(0), assignee: null }),
    makeItem({ closed: daysAgo(0), assignee: 'Alice' })
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

test('identifies stale Active items by changedDate', () => {
  const items = [
    makeItem({ changedDate: daysAgo(5), state: 'Active', boardColumn: 'In Progress' }),
    makeItem({ changedDate: daysAgo(1), state: 'Active' }),
    makeItem({ changedDate: daysAgo(20), state: 'Closed' }) // closed — excluded
  ]
  const result = calcStaleItems(items, 2)
  assertEqual(result.total, 1)
  assertEqual(result.items[0].boardColumn, 'In Progress')
  assert(result.items[0].staleDaysActual >= 4 && result.items[0].staleDaysActual <= 5, `Expected ~5 days, got ${result.items[0].staleDaysActual}`)
})

test('excludes terminal and intake states, includes in-scope states', () => {
  const items = [
    makeItem({ changedDate: daysAgo(10), state: 'New' }),     // excluded (intake)
    makeItem({ changedDate: daysAgo(10), state: 'Ready' }),   // included (in-scope)
    makeItem({ changedDate: daysAgo(10), state: 'Active' })   // included (in-scope)
  ]
  const result = calcStaleItems(items, 2)
  assertEqual(result.total, 2, 'New excluded; Ready and Active both stale')
})

test('returns zero for no stale items', () => {
  const items = [makeItem({ changedDate: daysAgo(1), state: 'Active' })]
  const result = calcStaleItems(items, 2)
  assertEqual(result.total, 0)
  assertEqual(result.items.length, 0)
})

test('detects blocked items via board column', () => {
  const items = [
    makeItem({ changedDate: daysAgo(5), state: 'Active', boardColumn: 'Blocked' })
  ]
  const result = calcStaleItems(items, 2)
  assertEqual(result.blocked, 1)
  assert(result.items[0].blocked, 'Item should be marked blocked')
})

test('detects blocked items via swim lane', () => {
  const items = [
    makeItem({ changedDate: daysAgo(5), state: 'Active', boardColumn: 'In Progress', boardLane: 'Blocked' })
  ]
  const result = calcStaleItems(items, 2)
  assertEqual(result.blocked, 1)
})

test('detects blocked items via tag', () => {
  const items = [
    makeItem({ changedDate: daysAgo(5), state: 'Active', tags: ['Blocked', 'Important'] })
  ]
  const result = calcStaleItems(items, 2)
  assertEqual(result.blocked, 1)
})

test('blocked items always show regardless of staleDays', () => {
  const items = [
    makeItem({ changedDate: daysAgo(0), state: 'Active', boardLane: 'Blocked' })
  ]
  const result = calcStaleItems(items, 2)
  assertEqual(result.total, 1, 'Blocked item should show even if changed today')
  assertEqual(result.blocked, 1)
  assert(result.items[0].blocked, 'Item should be marked blocked')
})

test('sorts by stalest first', () => {
  const items = [
    makeItem({ changedDate: daysAgo(3), state: 'Active' }),
    makeItem({ changedDate: daysAgo(10), state: 'Active' }),
    makeItem({ changedDate: daysAgo(5), state: 'Active' })
  ]
  const result = calcStaleItems(items, 2)
  assert(result.items[0].staleDaysActual >= result.items[1].staleDaysActual, 'Should be sorted stalest first')
  assert(result.items[1].staleDaysActual >= result.items[2].staleDaysActual, 'Should be sorted stalest first')
})

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

// ─── calcPodHealthStatus — widened stale ──────────────────────────────────────

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
  assert(h.reasons.some(r => r.toLowerCase().includes('stale')),
    `Expected a stale-items reason, got: ${JSON.stringify(h.reasons)}`)
})

// ─── calcBugRatioTrend ────────────────────────────────────────────────────────

group('calcBugRatioTrend')

test('calculates bug percentage per week', () => {
  const items = [
    makeItem({ closed: daysAgo(0), type: 'Bug' }),
    makeItem({ closed: daysAgo(0), type: 'User Story' }),
    makeItem({ closed: daysAgo(0), type: 'Bug' })
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
  // Place 2 items in each of the last 4 week buckets using bucket midpoints
  const buckets = weekBuckets(4)
  const items = []
  for (const b of buckets) {
    const mid = new Date((b.start.getTime() + b.end.getTime()) / 2)
    items.push(makeItem({ closed: mid.toISOString() }))
    items.push(makeItem({ closed: mid.toISOString() }))
  }
  const result = calcThroughputPredictability(items, 4)
  assert(result !== null, 'Should return a result')
  assertEqual(result.cv, 0, `CV should be 0 for perfectly stable throughput, got ${result.cv}`)
  assertEqual(result.rating, 'Stable')
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

// ─── weekly-update: week math ─────────────────────────────────────────────────

group('weekKeyFor')

test('Sunday Apr 19 2026 maps to 2026-W16', () => {
  // Apr 19 is Sun, Wed of week is Apr 22 (year 2026). First Wed of 2026 = Jan 7.
  // Week 1 Sunday = Jan 4. Apr 19 - Jan 4 = 105 days = 15 weeks → weekNum 16.
  assertEqual(weekKeyFor(new Date('2026-04-19T12:00:00Z')), '2026-W16')
})

test('Saturday Apr 25 2026 maps to 2026-W16', () => {
  // Same week as Sunday Apr 19.
  assertEqual(weekKeyFor(new Date('2026-04-25T12:00:00Z')), '2026-W16')
})

test('Sunday Apr 26 2026 maps to 2026-W17', () => {
  // Next Sun-Sat week.
  assertEqual(weekKeyFor(new Date('2026-04-26T12:00:00Z')), '2026-W17')
})

test('zero-pads single-digit weeks', () => {
  // Sun Jan 4 2026 is week 1.
  assertEqual(weekKeyFor(new Date('2026-01-04T12:00:00Z')), '2026-W01')
})

group('weekRange')

test('returns Sunday start and Saturday end for week key', () => {
  const r = weekRange('2026-W17')
  assertEqual(r.start.toISOString().slice(0, 10), '2026-04-26')
  assertEqual(r.end.toISOString().slice(0, 10), '2026-05-02')
})

test('label is human-readable', () => {
  const r = weekRange('2026-W17')
  assert(r.label.includes('Apr') || r.label.includes('May'),
    `Label should include Apr or May, got: ${r.label}`)
  assert(r.label.includes('26'), `Label should include 26, got: ${r.label}`)
  assert(r.label.includes('2'), `Label should include 2 (May 2), got: ${r.label}`)
})

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

test('sets carriedFrom when prior action has its own chain', () => {
  // Even when prev's action was already carried from W15, the current
  // action's carriedFrom should reflect the *immediately prior* week (W16).
  const prev = [{ id: 'p1', text: 'Triage QA backlog', carriedFrom: '2026-W15' }]
  const curr = [{ id: 'c1', text: 'Triage QA backlog', carriedFrom: null }]
  const r = detectCarryOver(curr, prev, '2026-W16')
  assertEqual(r[0].carriedFrom, '2026-W16')
})

test('overwrites a stale carriedFrom on the current action', () => {
  // detectCarryOver always sets carriedFrom to the immediately prior week
  // when a match is found, regardless of any pre-existing value on the current action.
  const prev = [{ id: 'p1', text: 'Triage QA backlog' }]
  const curr = [{ id: 'c1', text: 'Triage QA backlog', carriedFrom: '2026-W12' }]
  const r = detectCarryOver(curr, prev, '2026-W16')
  assertEqual(r[0].carriedFrom, '2026-W16',
    'Pre-existing stale carriedFrom should be overwritten with the immediate prior week')
})

group('carryChainLength')

test('returns 0 for action not carried over', () => {
  const action = { id: 'a1', text: 't', carriedFrom: null }
  assertEqual(carryChainLength(action, {}, 'p1'), 0)
})

test('returns 1 for action carried from one prior week', () => {
  const action = { id: 'a1', text: 'X', carriedFrom: '2026-W16' }
  const allWeeks = {
    '2026-W16': { pods: { p1: { actions: [{ id: 'a0', text: 'X', carriedFrom: null }] } } }
  }
  assertEqual(carryChainLength(action, allWeeks, 'p1'), 1)
})

test('returns 2 for two-week chain', () => {
  const action = { id: 'a1', text: 'X', carriedFrom: '2026-W16' }
  const allWeeks = {
    '2026-W16': { pods: { p1: { actions: [{ id: 'a0', text: 'X', carriedFrom: '2026-W15' }] } } },
    '2026-W15': { pods: { p1: { actions: [{ id: 'a-1', text: 'X', carriedFrom: null }] } } }
  }
  assertEqual(carryChainLength(action, allWeeks, 'p1'), 2)
})

test('does not chain across pods with identical action text', () => {
  const action = { id: 'a1', text: 'Triage backlog', carriedFrom: '2026-W16' }
  const allWeeks = {
    '2026-W16': { pods: {
      p2: { actions: [{ id: 'a0', text: 'Triage backlog', carriedFrom: null }] }
      // note: p1 has no matching action
    } }
  }
  assertEqual(carryChainLength(action, allWeeks, 'p1'), 0,
    'Pod p1 chain should not pick up Pod p2 actions even with identical text')
})

// ─── weekly-update: suggestion engine ────────────────────────────────────────

group('buildSuggestions — keys are deterministic')

test('throughput-up suggestion has stable key', () => {
  // Throughput pattern: 1 item closed each in older weeks 1-6, 4 items in last completed week.
  // baseline = 6 / 4 = 1.5 (using last 4 of those 6), last = 4 → +166% triggers win.
  const items = []
  for (let i = 0; i < 4; i++) {
    items.push(makeItem({ id: `last-${i}`, type: 'User Story', state: 'Closed', closed: daysAgo(8) }))
  }
  for (let i = 0; i < 4; i++) {
    items.push(makeItem({ id: `bw-${i}`, type: 'User Story', state: 'Closed', closed: daysAgo(15 + i * 7) }))
  }
  const pod = { id: 'p1', name: 'Pod A', items }
  const s1 = buildSuggestions(pod, {}, { staleDays: 2 }, {})
  const s2 = buildSuggestions(pod, {}, { staleDays: 2 }, {})
  const keys1 = s1.wins.concat(s1.issues, s1.actions).map(x => x.key).sort()
  const keys2 = s2.wins.concat(s2.issues, s2.actions).map(x => x.key).sort()
  assertEqual(JSON.stringify(keys1), JSON.stringify(keys2))
  assert(s1.wins.some(w => w.key === 'win-throughput-up'),
    `Expected win-throughput-up to fire on this fixture; got: ${JSON.stringify(s1.wins.map(w => w.key))}`)
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

// ─── Render Results ───────────────────────────────────────────────────────────

;(() => {
  const passed = _results.filter(r => r.pass).length
  const failed = _results.filter(r => !r.pass).length
  const total = _results.length

  // Browser rendering (skipped in Node.js)
  if (typeof window !== 'undefined' && document.getElementById('summary')) {
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
  }

  // Console output (works in both browser and Node.js)
  console.log(`\n${passed}/${total} passed${failed > 0 ? ` — ${failed} FAILED` : ''}`)
  for (const r of _results.filter(r => !r.pass)) {
    console.error(`  FAIL: ${r.group} > ${r.name} — ${r.error}`)
  }
})()
