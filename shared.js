// shared.js — ADO API + data processing shared across popup, board, and background

const DEFAULT_SETTINGS = {
  org: 'amcsgroup',
  project: 'Platform',
  refreshInterval: 15,
  pat: '',
  pods: [],
  overviewCharts: {
    cycleTimeInProgress: false,
    cycleTimeArrival: false,
    burndownByPI: false,
    throughputByPerson: false,
    cycleTimeByPerson: false,
    resolvedByPerson: false,
    wipTrend: false,
    ageDistribution: false,
    flowEfficiency: false,
    staleItems: false,
    bugRatioTrend: false,
    throughputPredictability: false,
    priorityAgeDistribution: false,
    cfdChart: false
  }
};

// ─── Storage helpers ───────────────────────────────────────────────────────────

function getSettings() {
  return new Promise(resolve =>
    chrome.storage.local.get('settings', r => {
      const s = { ...DEFAULT_SETTINGS, ...(r.settings || {}) };
      // Migrate from old single-areaPath format
      if (s.areaPath && (!s.pods || s.pods.length === 0)) {
        s.pods = [{ id: 'pod-migrated', name: 'Pod 1', areaPath: s.areaPath }];
        delete s.areaPath;
      }
      resolve(s);
    })
  );
}

function generateId() {
  return 'pod-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}

function getCachedData() {
  return new Promise(resolve =>
    chrome.storage.local.get('cachedData', r => resolve(r.cachedData || null))
  );
}

function setCachedData(data) {
  return new Promise(resolve => chrome.storage.local.set({ cachedData: data }, resolve));
}

// Cache version — bump when arrival logic changes to force a re-fetch of all items.
const ARRIVED_CACHE_VERSION = 3;

function getArrivedAtCache() {
  return new Promise(resolve =>
    chrome.storage.local.get(['arrivedAtCache', 'arrivedAtCacheVersion'], r => {
      if (r.arrivedAtCacheVersion !== ARRIVED_CACHE_VERSION) {
        // Logic changed — wipe stale cache
        chrome.storage.local.set({ arrivedAtCache: {}, arrivedAtCacheVersion: ARRIVED_CACHE_VERSION });
        resolve({});
      } else {
        resolve(r.arrivedAtCache || {});
      }
    })
  );
}

async function updateArrivedAtCache(entries) {
  const cache = await getArrivedAtCache();
  Object.assign(cache, entries);
  return new Promise(resolve => chrome.storage.local.set({ arrivedAtCache: cache }, resolve));
}

// ─── ADO REST API ──────────────────────────────────────────────────────────────

async function adoFetch(url, settings, options = {}) {
  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let resp;
    try {
      resp = await fetch(url, {
        ...options,
        headers: {
          'Authorization': `Basic ${btoa(':' + settings.pat)}`,
          'Content-Type': 'application/json',
          ...(options.headers || {})
        }
      });
    } catch (networkErr) {
      // Network-level failure (offline, DNS, CORS etc.) — retry with backoff
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, (2 ** attempt) * 1000));
        continue;
      }
      throw networkErr;
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      const err = new Error(`ADO ${resp.status}: ${resp.statusText} — ${body.slice(0, 200)}`);
      // Retry only on server errors (5xx) or rate limit (429); never on 4xx auth/not-found
      if ((resp.status >= 500 || resp.status === 429) && attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, (2 ** attempt) * 1000));
        continue;
      }
      throw err;
    }
    return resp.json();
  }
}

async function runWiql(query, settings) {
  const url = `https://dev.azure.com/${settings.org}/${settings.project}/_apis/wit/wiql?api-version=7.1`;
  const data = await adoFetch(url, settings, {
    method: 'POST',
    body: JSON.stringify({ query })
  });
  return (data.workItems || []).map(w => w.id);
}

async function getWorkItemsBatch(ids, settings) {
  if (!ids.length) return [];
  const FIELDS = [
    'System.Id', 'System.Title', 'System.State', 'System.AssignedTo',
    'System.WorkItemType', 'System.CreatedDate', 'System.BoardColumn',
    'Microsoft.VSTS.Scheduling.StoryPoints', 'Microsoft.VSTS.Common.Priority',
    'System.Tags', 'Microsoft.VSTS.Common.ClosedDate',
    'Microsoft.VSTS.Common.ResolvedDate', 'System.ChangedDate',
    'System.IterationPath', 'System.AreaPath',
    'Microsoft.VSTS.Common.StackRank', 'Custom.TargetPI'
  ];
  const url = `https://dev.azure.com/${settings.org}/_apis/wit/workitemsbatch?api-version=7.1`;
  const results = [];
  for (let i = 0; i < ids.length; i += 200) {
    const data = await adoFetch(url, settings, {
      method: 'POST',
      body: JSON.stringify({ ids: ids.slice(i, i + 200), fields: FIELDS })
    });
    results.push(...(data.value || []));
  }
  return results;
}

// Columns considered "inactive" — items sitting here haven't truly arrived on the board yet.
const INACTIVE_COLUMNS = ['backlog', 'new'];

// Fetches the most recent date an item arrived in the given pod.
// Checks two signals (in priority order):
//   1. AreaPath change INTO the pod — item moved from another team/area.
//   2. Board column activation — item moved from Backlog/New to an active column
//      (Ready, In Progress, etc.) within the same area path.
// Returns 'native' when API succeeded but neither signal was found (item was
// created directly in an active column in this pod).
// Returns null only on API failure (caller should not cache, will retry next refresh).
async function getItemArrivedAt(itemId, podAreaPath, settings) {
  const url = `https://dev.azure.com/${settings.org}/${settings.project}/_apis/wit/workitems/${itemId}/updates?api-version=7.1`;
  try {
    const data = await adoFetch(url, settings);
    let lastAreaArrival = null;
    let lastBoardActivation = null;
    for (const update of (data.value || [])) {
      // Prefer ChangedDate from the diff; revisedDate can be "9999-01-01..." sentinel on the latest update
      const rd = update.revisedDate;
      const changeDate = update.fields?.['System.ChangedDate']?.newValue
        || (rd && !rd.startsWith('0001') && !rd.startsWith('9999') ? rd : null);
      if (!changeDate) continue;

      // Signal 1: AreaPath moved into this pod
      const areaChange = update.fields?.['System.AreaPath'];
      if (areaChange?.newValue) {
        const nv = areaChange.newValue;
        if (nv === podAreaPath || nv.startsWith(podAreaPath + '\\')) {
          lastAreaArrival = changeDate;
        }
      }

      // Signal 2: Board column moved from inactive (Backlog/New) to active
      const boardChange = update.fields?.['System.BoardColumn'];
      if (boardChange?.oldValue && boardChange?.newValue) {
        const oldCol = boardChange.oldValue.toLowerCase();
        const newCol = boardChange.newValue.toLowerCase();
        if (INACTIVE_COLUMNS.includes(oldCol) && !INACTIVE_COLUMNS.includes(newCol)) {
          lastBoardActivation = changeDate;
        }
      }
    }
    // AreaPath move takes priority; board activation is the fallback for native items
    return lastAreaArrival || lastBoardActivation || 'native';
  } catch {
    return null; // API failure — don't cache, retry next refresh
  }
}

// Enriches items with arrivedAt dates, using a persistent cache to avoid re-fetching.
// Cache is keyed by "podAreaPath:itemId" so moves between pods are handled correctly.
// - Cached date string  → use it directly
// - null (API failure)  → not cached, temporary changedDate heuristic used until next refresh
// - 'native' sentinel   → item created in pod; cached as item.created (no false positives)
async function enrichWithArrivedAt(items, podAreaPath, settings) {
  const cache = await getArrivedAtCache();

  // Invalidate stale cache entries: if an item was changed after its cached
  // arrival date, it may have been moved between pods — re-fetch its history.
  const invalidated = [];
  for (const item of items) {
    const key = `${podAreaPath}:${item.id}`;
    if (Object.prototype.hasOwnProperty.call(cache, key)) {
      const cachedMs = new Date(cache[key]).getTime();
      const changedMs = item.changedDate ? new Date(item.changedDate).getTime() : 0;
      if (changedMs > cachedMs + 86400000) {
        delete cache[key];
        invalidated.push(key);
      }
    }
  }

  // Only fetch items not yet in cache (undefined key = never checked or just invalidated)
  const uncached = items.filter(i => !Object.prototype.hasOwnProperty.call(cache, `${podAreaPath}:${i.id}`));

  if (uncached.length > 0) {
    const CONCURRENCY = 10;
    const newEntries = {};
    const queue = [...uncached];
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
        while (queue.length > 0) {
          const item = queue.shift();
          const result = await getItemArrivedAt(item.id, podAreaPath, settings);
          if (result !== null) {
            // 'native' → item was always in this pod → cache its created date
            newEntries[`${podAreaPath}:${item.id}`] = result === 'native' ? item.created : result;
          }
          // null (API failure) → skip caching, will retry next refresh
        }
      })
    );
    if (Object.keys(newEntries).length > 0 || invalidated.length > 0) {
      // Re-read cache to avoid race conditions, apply invalidations + new entries
      const freshCache = await getArrivedAtCache();
      for (const key of invalidated) delete freshCache[key];
      Object.assign(freshCache, newEntries);
      await new Promise(resolve => chrome.storage.local.set({ arrivedAtCache: freshCache }, resolve));
      Object.assign(cache, newEntries);
    }
  } else if (invalidated.length > 0) {
    // No uncached items but we invalidated some — persist the removals
    const freshCache = await getArrivedAtCache();
    for (const key of invalidated) delete freshCache[key];
    await new Promise(resolve => chrome.storage.local.set({ arrivedAtCache: freshCache }, resolve));
  }

  return items.map(item => {
    const key = `${podAreaPath}:${item.id}`;
    if (Object.prototype.hasOwnProperty.call(cache, key)) return { ...item, arrivedAt: cache[key] };
    // Temporary fallback for items whose history hasn't been fetched yet (API failures only).
    // changedDate heuristic: if changed significantly after creation, use changedDate; else created.
    const created = new Date(item.created).getTime();
    const changed = item.changedDate ? new Date(item.changedDate).getTime() : 0;
    return { ...item, arrivedAt: changed > created + 86400000 ? item.changedDate : item.created };
  });
}

// ─── ADO Board WIP Limits ─────────────────────────────────────────────────────

// Resolve a pod's area path to its ADO team
async function fetchTeamForPod(pod, settings) {
  const teamsResp = await adoFetch(
    `https://dev.azure.com/${encodeURIComponent(settings.org)}/_apis/projects/${encodeURIComponent(settings.project)}/teams?api-version=7.1`,
    settings
  )
  for (const team of teamsResp.value || []) {
    try {
      const fields = await adoFetch(
        `https://dev.azure.com/${encodeURIComponent(settings.org)}/${encodeURIComponent(settings.project)}/${team.id}/_apis/work/teamsettings/teamfieldvalues?api-version=7.1`,
        settings
      )
      for (const v of fields.values || []) {
        if (v.value === pod.areaPath) return team
        if (v.includeChildren && pod.areaPath.startsWith(v.value + '\\')) return team
      }
    } catch (_) { /* skip teams we can't read */ }
  }
  return null
}

// Fetch WIP limits from the ADO board columns for a pod's team
async function fetchWipLimits(pod, settings) {
  try {
    const team = pod.teamId
      ? { id: pod.teamId }
      : await fetchTeamForPod(pod, settings)
    if (!team) return { wipLimits: {}, teamId: null, boardName: null }

    let boardName = pod.boardName
    if (!boardName) {
      const boards = await adoFetch(
        `https://dev.azure.com/${encodeURIComponent(settings.org)}/${encodeURIComponent(settings.project)}/${team.id}/_apis/work/boards?api-version=7.1`,
        settings
      )
      boardName = (boards.value || [])[0]?.name || 'Stories'
    }

    const board = await adoFetch(
      `https://dev.azure.com/${encodeURIComponent(settings.org)}/${encodeURIComponent(settings.project)}/${team.id}/_apis/work/boards/${encodeURIComponent(boardName)}?api-version=7.1`,
      settings
    )

    const wipLimits = {}
    for (const col of board.columns || []) {
      if (col.itemLimit > 0) wipLimits[col.name] = col.itemLimit
    }
    return { wipLimits, teamId: team.id, boardName }
  } catch (_) {
    return { wipLimits: {}, teamId: null, boardName: null }
  }
}

// Fetch data for a single pod area path
async function fetchPodData(pod, settings) {
  const ap = pod.areaPath;
  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
  const cutoff = ninetyDaysAgo.toISOString().split('T')[0];

  const [activeIds, closedIds] = await Promise.all([
    runWiql(
      `SELECT [System.Id] FROM WorkItems
       WHERE [System.AreaPath] UNDER '${ap}'
       AND [System.WorkItemType] IN ('Bug','User Story','Feature','Spike')
       AND [System.State] NOT IN ('Closed','Removed')
       ORDER BY [System.CreatedDate] DESC`,
      settings
    ),
    runWiql(
      `SELECT [System.Id] FROM WorkItems
       WHERE [System.AreaPath] UNDER '${ap}'
       AND [System.WorkItemType] IN ('Bug','User Story','Feature','Spike')
       AND [System.State] IN ('Closed','Resolved')
       AND [Microsoft.VSTS.Common.ClosedDate] >= '${cutoff}'
       ORDER BY [Microsoft.VSTS.Common.ClosedDate] DESC`,
      settings
    )
  ]);

  const allIds = [...new Set([...activeIds, ...closedIds])];
  const rawItems = await getWorkItemsBatch(allIds, settings);
  const items = rawItems.map(mapItem);
  return await enrichWithArrivedAt(items, pod.areaPath, settings);
}

// Fetch all configured pods in parallel
async function fetchAllPods(settings) {
  const pods = settings.pods || [];
  const podResults = {};

  await Promise.all(pods.map(async pod => {
    try {
      const items = await fetchPodData(pod, settings);
      const { wipLimits, teamId, boardName } = await fetchWipLimits(pod, settings);
      podResults[pod.id] = { id: pod.id, name: pod.name, areaPath: pod.areaPath, items, wipLimits, teamId, boardName, fetchedAt: new Date().toISOString(), error: null };
    } catch (err) {
      podResults[pod.id] = { id: pod.id, name: pod.name, areaPath: pod.areaPath, items: [], wipLimits: {}, fetchedAt: new Date().toISOString(), error: err.message };
    }
  }));

  return { fetchedAt: new Date().toISOString(), pods: podResults };
}

// Flatten all pod items for aggregate metrics
function getAllItems(cachedData) {
  if (!cachedData?.pods) return [];
  return Object.values(cachedData.pods).flatMap(p => p.items || []);
}

function mapItem(raw) {
  const f = raw.fields;
  const at = f['System.AssignedTo'];
  const assignee = at ? (typeof at === 'object' ? at.displayName : at) : null;
  const tags = (f['System.Tags'] || '').split(';').map(t => t.trim()).filter(Boolean);
  const created = f['System.CreatedDate'];
  const changedDate = f['System.ChangedDate'] || null;
  // arrivedAt: if the item was changed significantly after creation it was likely
  // moved into this pod — use changedDate as the arrival date, otherwise use created.
  const createdMs = new Date(created).getTime();
  const changedMs = changedDate ? new Date(changedDate).getTime() : 0;
  const arrivedAt = changedMs > createdMs + 86400000 ? changedDate : created;
  return {
    id: f['System.Id'],
    title: f['System.Title'] || '(no title)',
    state: f['System.State'],
    assignee,
    type: f['System.WorkItemType'],
    created,
    changedDate,
    arrivedAt,
    closed: f['Microsoft.VSTS.Common.ClosedDate'] || null,
    resolved: f['Microsoft.VSTS.Common.ResolvedDate'] || null,
    boardColumn: f['System.BoardColumn'] || null,
    sp: f['Microsoft.VSTS.Scheduling.StoryPoints'] || null,
    priority: f['Microsoft.VSTS.Common.Priority'] || 2,
    tags,
    iterationPath: f['System.IterationPath'] || '',
    stackRank: f['Microsoft.VSTS.Common.StackRank'] || 0,
    targetPI: f['Custom.TargetPI'] || '',
    url: `https://dev.azure.com/${DEFAULT_SETTINGS.org}/${DEFAULT_SETTINGS.project}/_workitems/edit/${f['System.Id']}`
  };
}

// ─── Flow metrics ──────────────────────────────────────────────────────────────

function weekBuckets(weeksBack = 8) {
  const now = new Date();
  // Snap to most recent Monday
  const daysToMonday = (now.getDay() + 6) % 7; // Mon=0 … Sun=6
  const thisMonday = new Date(now);
  thisMonday.setDate(now.getDate() - daysToMonday);
  thisMonday.setHours(0, 0, 0, 0);

  const buckets = [];
  for (let w = weeksBack - 1; w >= 0; w--) {
    const start = new Date(thisMonday);
    start.setDate(thisMonday.getDate() - w * 7);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    end.setHours(23, 59, 59, 999);
    buckets.push({ start, end, label: fmtWeek(start) });
  }
  return buckets;
}

function fmtWeek(date) {
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function calcWeeklyArrival(items, weeksBack = 8) {
  return weekBuckets(weeksBack).map(({ start, end, label }) => ({
    label,
    count: items.filter(i => {
      const d = new Date(i.arrivedAt || i.created);
      return d >= start && d <= end;
    }).length
  }));
}

function calcWeeklyThroughput(items, weeksBack = 8) {
  const done = items.filter(i => (i.closed || i.resolved) && i.type !== 'Spike')
  return weekBuckets(weeksBack).map(({ start, end, label }) => {
    let resolved = 0
    let closed = 0
    for (const i of done) {
      const d = new Date(i.closed || i.resolved)
      if (d >= start && d <= end) {
        if (i.closed) closed++
        else resolved++
      }
    }
    return { label, count: resolved + closed, resolved, closed }
  })
}

function calcWeeklyThroughputByPerson(items, weeksBack = 8) {
  const done = items.filter(i => (i.closed || i.resolved) && i.assignee && i.type !== 'Spike');
  const buckets = weekBuckets(weeksBack);
  const people = {};
  for (const item of done) {
    const d = new Date(item.closed || item.resolved);
    for (const bucket of buckets) {
      if (d >= bucket.start && d <= bucket.end) {
        if (!people[item.assignee]) people[item.assignee] = new Array(buckets.length).fill(0);
        people[item.assignee][buckets.indexOf(bucket)]++;
        break;
      }
    }
  }
  // Sort people by total throughput descending
  const sorted = Object.entries(people).sort((a, b) => b[1].reduce((s, v) => s + v, 0) - a[1].reduce((s, v) => s + v, 0));
  return {
    labels: buckets.map(b => b.label),
    people: sorted.map(([name, counts]) => ({ name, counts }))
  };
}

function calcClosedByPerson(items, weeksBack = 8) {
  const buckets = weekBuckets(weeksBack);
  const closed = items.filter(i => i.closed && i.assignee);

  // Count per person per week
  const byPerson = {};
  for (const item of closed) {
    const d = new Date(item.closed);
    for (let wi = 0; wi < buckets.length; wi++) {
      if (d >= buckets[wi].start && d <= buckets[wi].end) {
        if (!byPerson[item.assignee]) byPerson[item.assignee] = new Array(buckets.length).fill(0);
        byPerson[item.assignee][wi]++;
        break;
      }
    }
  }

  return Object.entries(byPerson)
    .map(([name, weekly]) => {
      const thisWeek = weekly[weekly.length - 1];
      const total = weekly.reduce((s, v) => s + v, 0);
      const avg = +(total / weekly.length).toFixed(1);
      return { name, thisWeek, avg, total, weekly };
    })
    .sort((a, b) => b.thisWeek - a.thisWeek || b.avg - a.avg);
}

function calcResolvedByPerson(items, weeksBack = 8) {
  const buckets = weekBuckets(weeksBack);
  const resolved = items.filter(i => i.resolved && i.assignee);

  const byPerson = {};
  for (const item of resolved) {
    const d = new Date(item.resolved);
    for (let wi = 0; wi < buckets.length; wi++) {
      if (d >= buckets[wi].start && d <= buckets[wi].end) {
        if (!byPerson[item.assignee]) byPerson[item.assignee] = new Array(buckets.length).fill(0);
        byPerson[item.assignee][wi]++;
        break;
      }
    }
  }

  return Object.entries(byPerson)
    .map(([name, weekly]) => {
      const thisWeek = weekly[weekly.length - 1];
      const total = weekly.reduce((s, v) => s + v, 0);
      const avg = +(total / weekly.length).toFixed(1);
      return { name, thisWeek, avg, total, weekly };
    })
    .sort((a, b) => b.thisWeek - a.thisWeek || b.avg - a.avg);
}

// ─── WIP Trend: count of active items at end of each week ────────────────────

function calcWeeklyWIP(items, weeksBack = 8) {
  const buckets = weekBuckets(weeksBack);
  return buckets.map(({ end, label }) => {
    const count = items.filter(item => {
      const created = new Date(item.created);
      if (created > end) return false;
      const doneDate = item.closed || item.resolved;
      if (doneDate && new Date(doneDate) <= end) return false;
      return true;
    }).length;
    return { label, value: count };
  });
}

// ─── Age Distribution: active items grouped by age band ──────────────────────

function calcAgeDistribution(items) {
  const active = items.filter(i => !['Closed', 'Removed', 'Resolved'].includes(i.state));
  const bands = [
    { label: '0–7d', min: 0, max: 7 },
    { label: '7–14d', min: 7, max: 14 },
    { label: '14–30d', min: 14, max: 30 },
    { label: '30–60d', min: 30, max: 60 },
    { label: '60–90d', min: 60, max: 90 },
    { label: '90d+', min: 90, max: Infinity }
  ];
  return bands.map(band => ({
    label: band.label,
    count: active.filter(i => {
      const days = ageDays(i);
      return days >= band.min && days < band.max;
    }).length
  }));
}

// ─── Priority Age Distribution: active items grouped by priority × age band ──

function calcPriorityAgeDistribution(items) {
  const active = items.filter(i => !['Closed', 'Removed', 'Resolved'].includes(i.state));
  const bands = [
    { label: '0–14d',  min: 0,   max: 14 },
    { label: '14–30d', min: 14,  max: 30 },
    { label: '30–60d', min: 30,  max: 60 },
    { label: '60–90d', min: 60,  max: 90 },
    { label: '90d+',   min: 90,  max: Infinity }
  ];
  const PRIORITY_COLORS = { 1: '#ef4444', 2: '#f59e0b', 3: '#64748b' };
  const rows = [1, 2, 3].map(p => ({
    priority: p,
    label: `P${p}`,
    color: PRIORITY_COLORS[p],
    counts: bands.map(band => active.filter(i => {
      const days = ageDays(i);
      return (i.priority || 2) === p && days >= band.min && days < band.max;
    }).length)
  })).filter(row => row.counts.some(c => c > 0));
  return { bands: bands.map(b => b.label), priorities: rows };
}

// ─── Cumulative Flow Diagram: weekly cumulative arrivals vs closures ──────────

function calcCumulativeFlow(items, weeksBack = 12) {
  const buckets = weekBuckets(weeksBack);
  let cumArrived = 0;
  let cumClosed = 0;
  return buckets.map(({ start, end, label }) => {
    cumArrived += items.filter(i => {
      const d = new Date(i.arrivedAt || i.created);
      return d >= start && d <= end;
    }).length;
    cumClosed += items.filter(i => {
      if (!i.closed && !i.resolved) return false;
      const d = new Date(i.closed || i.resolved);
      return d >= start && d <= end;
    }).length;
    return { label, arrived: cumArrived, closed: cumClosed };
  });
}

// ─── Flow Efficiency: active time / total time for closed items ──────────────

function calcFlowEfficiency(ctData) {
  const items = ctData.filter(d => d.inProgressToClose != null && d.arrivalToClose != null && d.arrivalToClose > 0);
  if (!items.length) return null;
  const ratios = items.map(d => d.inProgressToClose / d.arrivalToClose);
  const avg = ratios.reduce((s, r) => s + r, 0) / ratios.length;
  return {
    pct: Math.round(avg * 100),
    count: items.length,
    median: Math.round(ratios.sort((a, b) => a - b)[Math.floor(ratios.length / 2)] * 100)
  };
}

// ─── Stale Items: active items with no state change in X days ────────────────

function calcStaleItems(items, staleDays = 14) {
  const cutoff = Date.now() - staleDays * 86400000;
  const active = items.filter(i => !['Closed', 'Removed', 'Resolved'].includes(i.state));
  const stale = active.filter(i => {
    const changed = i.changedDate ? new Date(i.changedDate).getTime() : 0;
    return changed < cutoff;
  });
  // Group by column
  const byCol = {};
  for (const item of stale) {
    const col = item.boardColumn || item.state || 'Unknown';
    if (!byCol[col]) byCol[col] = 0;
    byCol[col]++;
  }
  return {
    total: stale.length,
    byColumn: Object.entries(byCol).map(([col, count]) => ({ col, count })).sort((a, b) => b.count - a.count)
  };
}

// ─── Bug Ratio Trend: bugs as % of throughput per week ───────────────────────

function calcBugRatioTrend(items, weeksBack = 8) {
  const done = items.filter(i => (i.closed || i.resolved) && i.type !== 'Spike');
  return weekBuckets(weeksBack).map(({ start, end, label }) => {
    const weekItems = done.filter(i => {
      const d = new Date(i.closed || i.resolved);
      return d >= start && d <= end;
    });
    const total = weekItems.length;
    const bugs = weekItems.filter(i => i.type === 'Bug').length;
    return { label, bugs, total, pct: total > 0 ? Math.round((bugs / total) * 100) : 0 };
  });
}

// ─── Throughput Predictability: coefficient of variation ──────────────────────

function calcThroughputPredictability(items, weeksBack = 8) {
  const weekly = calcWeeklyThroughput(items, weeksBack);
  const counts = weekly.map(w => w.count);
  const n = counts.length;
  if (n < 2) return null;
  const mean = counts.reduce((s, v) => s + v, 0) / n;
  if (mean === 0) return null;
  const variance = counts.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  const stdDev = Math.sqrt(variance);
  const cv = stdDev / mean;
  return {
    mean: +mean.toFixed(1),
    stdDev: +stdDev.toFixed(1),
    cv: +cv.toFixed(2),
    rating: cv <= 0.3 ? 'Stable' : cv <= 0.6 ? 'Moderate' : 'Volatile',
    ratingColor: cv <= 0.3 ? '#22c55e' : cv <= 0.6 ? '#f59e0b' : '#ef4444',
    weekly
  };
}

function arrivalStats(items) {
  // Derive from the same week buckets used by the bar chart so KPI and chart are always consistent.
  const weekly = calcWeeklyArrival(items, 8);
  const last7  = weekly[weekly.length - 1]?.count || 0;
  const prev7  = weekly[weekly.length - 2]?.count || 0;
  const last30 = weekly.slice(-4).reduce((s, w) => s + w.count, 0);
  return { last7, prev7, last30, avgPerWeek: +(last30 / 4.3).toFixed(1) };
}

// Sums counts for all column keys containing any of the given substrings (case-insensitive).
// Use this instead of exact key lookups so variant column names (e.g. 'Triage' vs 'Intake/Triage') still match.
function colCount(cols, ...keywords) {
  return Object.entries(cols)
    .filter(([k]) => keywords.some(kw => k.toLowerCase().includes(kw.toLowerCase())))
    .reduce((s, [, v]) => s + v, 0);
}

function columnCounts(items) {
  const map = {};
  for (const item of items) {
    const col = item.boardColumn || item.state || 'Unknown';
    map[col] = (map[col] || 0) + 1;
  }
  return map;
}

function teamLoad(items) {
  const map = {};
  for (const item of items) {
    if (!item.assignee) continue;
    if (!map[item.assignee]) map[item.assignee] = { total: 0, columns: {} };
    map[item.assignee].total++;
    const col = item.boardColumn || item.state || '?';
    map[item.assignee].columns[col] = (map[item.assignee].columns[col] || 0) + 1;
  }
  return map;
}

function ageDays(item) {
  return Math.floor((Date.now() - new Date(item.created).getTime()) / 86400000);
}

function ageClass(days) {
  if (days < 30) return 'age-ok';
  if (days < 90) return 'age-warn';
  return 'age-old';
}

function ageLabel(days) {
  if (days < 1) return 'today';
  if (days < 30) return `${days}d`;
  if (days < 90) return `${Math.round(days / 7)}w`;
  return `${Math.round(days / 30)}mo`;
}

function initials(name) {
  if (!name) return '?';
  return name.split(' ').slice(0, 2).map(p => p[0]).join('').toUpperCase();
}

const ASSIGNEE_COLORS = [
  '#6366f1','#f59e0b','#10b981','#8b5cf6','#ef4444',
  '#06b6d4','#f97316','#84cc16','#ec4899','#14b8a6'
];
const _colorMap = {};
let _colorIdx = 0;
function assigneeColor(name) {
  if (!name) return '#475569';
  if (!_colorMap[name]) {
    _colorMap[name] = ASSIGNEE_COLORS[_colorIdx++ % ASSIGNEE_COLORS.length];
  }
  return _colorMap[name];
}

// Consistent colour per pod (stable across renders)
const POD_PALETTE = ['#6366f1','#f59e0b','#10b981','#8b5cf6','#ef4444','#06b6d4','#f97316','#84cc16'];
const _podColorMap = {};
let _podColorIdx = 0;
function podColor(podId) {
  if (!_podColorMap[podId]) _podColorMap[podId] = POD_PALETTE[_podColorIdx++ % POD_PALETTE.length];
  return _podColorMap[podId];
}

// ─── Work Item Update (Drag-and-Drop) ─────────────────────────────────────────

async function updateWorkItem(itemId, operations, settings) {
  const url = `https://dev.azure.com/${settings.org}/${settings.project}/_apis/wit/workitems/${itemId}?api-version=7.1`;
  return adoFetch(url, settings, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json-patch+json' },
    body: JSON.stringify(operations)
  });
}

async function reorderWorkItem(itemId, newRank, newColumn, settings) {
  const ops = [
    { op: 'replace', path: '/fields/Microsoft.VSTS.Common.StackRank', value: newRank }
  ];
  if (newColumn) {
    ops.push({ op: 'replace', path: '/fields/System.BoardColumn', value: newColumn });
  }
  return updateWorkItem(itemId, ops, settings);
}

function calcNewStackRank(aboveRank, belowRank) {
  if (aboveRank != null && belowRank != null) return (aboveRank + belowRank) / 2;
  if (aboveRank != null) return aboveRank + 1;
  if (belowRank != null) return belowRank - 1;
  return 1;
}

// ─── Started-At Cache (for cycle time) ────────────────────────────────────────

const STARTED_CACHE_VERSION = 1;

function getStartedAtCache() {
  return new Promise(resolve =>
    chrome.storage.local.get(['startedAtCache', 'startedAtCacheVersion'], r => {
      if (r.startedAtCacheVersion !== STARTED_CACHE_VERSION) {
        chrome.storage.local.set({ startedAtCache: {}, startedAtCacheVersion: STARTED_CACHE_VERSION });
        resolve({});
      } else {
        resolve(r.startedAtCache || {});
      }
    })
  );
}

async function getItemStartedAt(itemId, settings) {
  const url = `https://dev.azure.com/${settings.org}/${settings.project}/_apis/wit/workitems/${itemId}/updates?api-version=7.1`;
  try {
    const data = await adoFetch(url, settings);
    for (const update of (data.value || [])) {
      const boardChange = update.fields?.['System.BoardColumn'];
      if (boardChange?.newValue) {
        const newCol = boardChange.newValue.toLowerCase();
        if (newCol === 'in progress' || newCol === 'active') {
          const changeDate = update.fields?.['System.ChangedDate']?.newValue
            || (update.revisedDate && !update.revisedDate.startsWith('0001') && !update.revisedDate.startsWith('9999') ? update.revisedDate : null);
          if (changeDate) return changeDate;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function enrichWithStartedAt(items, settings) {
  const cache = await getStartedAtCache();
  const closedItems = items.filter(i => i.closed);
  const uncached = closedItems.filter(i => !Object.prototype.hasOwnProperty.call(cache, String(i.id)));

  if (uncached.length > 0) {
    const CONCURRENCY = 10;
    const newEntries = {};
    const queue = [...uncached];
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
        while (queue.length > 0) {
          const item = queue.shift();
          const result = await getItemStartedAt(item.id, settings);
          if (result !== null) {
            newEntries[String(item.id)] = result;
          } else {
            newEntries[String(item.id)] = '__none__';
          }
        }
      })
    );
    if (Object.keys(newEntries).length > 0) {
      const freshCache = await getStartedAtCache();
      Object.assign(freshCache, newEntries);
      await new Promise(resolve => chrome.storage.local.set({ startedAtCache: freshCache }, resolve));
      Object.assign(cache, newEntries);
    }
  }

  return items.map(item => {
    const startedAt = cache[String(item.id)];
    return { ...item, startedAt: startedAt && startedAt !== '__none__' ? startedAt : null };
  });
}

// ─── Cycle Time Calculation ───────────────────────────────────────────────────

function calcCycleTimes(items) {
  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

  return items
    .filter(i => i.closed && new Date(i.closed) >= ninetyDaysAgo)
    .map(i => {
      const closedDate = new Date(i.closed);
      const arrivalToClose = i.arrivedAt
        ? Math.max(0, Math.round((closedDate - new Date(i.arrivedAt)) / 86400000))
        : null;
      const inProgressToClose = i.startedAt
        ? Math.max(0, Math.round((closedDate - new Date(i.startedAt)) / 86400000))
        : null;
      return { id: i.id, type: i.type, url: i.url, assignee: i.assignee, arrivalToClose, inProgressToClose, closedDate };
    })
    .filter(i => i.arrivalToClose !== null || i.inProgressToClose !== null);
}

// ─── Burndown Calculation ─────────────────────────────────────────────────────

function calcBurndown(items, targetPI) {
  const piItems = items.filter(i => i.targetPI === targetPI);
  if (!piItems.length) return [];

  const total = piItems.length;
  const buckets = weekBuckets(12);
  const data = buckets.map(({ end, label }, i) => {
    const remaining = piItems.filter(item => {
      if (!item.closed && !item.resolved) return true;
      return new Date(item.closed || item.resolved) > end;
    }).length;
    const ideal = Math.round(total * (1 - (i + 1) / buckets.length));
    return { label, remaining, ideal };
  });
  return data;
}

// ─── Simple SVG bar chart ──────────────────────────────────────────────────────

function renderBarChart(container, datasets, opts = {}) {
  const W = opts.width || 600;
  const H = opts.height || 160;
  const PAD = { top: 16, right: opts.avgLine ? 40 : 10, bottom: 46, left: 28 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;
  const stacked = opts.stacked && datasets.length > 1;

  // For stacked bars, max is the sum of all datasets per bucket
  const maxVal = stacked
    ? Math.max(1, ...datasets[0].data.map((_, i) => datasets.reduce((s, ds) => s + ds.data[i].count, 0)))
    : Math.max(1, ...datasets.flatMap(ds => ds.data.map(d => d.count)));
  const labels = datasets[0].data.map(d => d.label);
  const n = labels.length;
  const ds = datasets.length;
  const groupW = chartW / n;
  const barW = stacked ? Math.max(4, groupW - 8) : Math.max(4, (groupW - 8) / ds);

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" style="width:100%;height:auto">`;

  // Grid lines
  for (let i = 0; i <= 4; i++) {
    const y = PAD.top + (chartH * (1 - i / 4));
    const val = Math.round((maxVal * i) / 4);
    svg += `<line x1="${PAD.left}" y1="${y}" x2="${PAD.left + chartW}" y2="${y}" stroke="#334155" stroke-width="0.5" stroke-dasharray="4,4" opacity="0.6"/>`;
    svg += `<text x="${PAD.left - 4}" y="${y + 4}" text-anchor="end" font-size="9" fill="#64748b">${val}</text>`;
  }

  // Bars + labels
  if (stacked) {
    for (let i = 0; i < n; i++) {
      const x = PAD.left + i * groupW + 4
      let cumY = PAD.top + chartH
      const total = datasets.reduce((s, ds_item) => s + ds_item.data[i].count, 0)
      // Draw from bottom up
      datasets.forEach(ds_item => {
        const val = ds_item.data[i].count
        if (val <= 0) return
        const barH = (val / maxVal) * chartH
        cumY -= barH
        svg += `<rect x="${x}" y="${cumY}" width="${barW}" height="${barH}" rx="2" fill="${ds_item.color}" opacity="0.85"><title>${ds_item.data[i].label}: ${ds_item.label} ${val}</title></rect>`
      })
      if (total > 0) {
        const totalH = (total / maxVal) * chartH
        const topY = PAD.top + chartH - totalH
        svg += `<text x="${x + barW / 2}" y="${topY - 3}" text-anchor="middle" font-size="9" fill="#94a3b8">${total}</text>`
      }
    }
  } else {
    datasets.forEach((ds_item, di) => {
      ds_item.data.forEach((d, i) => {
        const barH = (d.count / maxVal) * chartH;
        const x = PAD.left + i * groupW + di * barW + 4;
        const y = PAD.top + chartH - barH;
        svg += `<rect x="${x}" y="${y}" width="${barW}" height="${barH}" rx="3" fill="${ds_item.color}" opacity="0.85"><title>${d.label}: ${d.count}</title></rect>`;
        if (d.count > 0) {
          svg += `<text x="${x + barW / 2}" y="${y - 3}" text-anchor="middle" font-size="9" fill="${ds_item.color}">${d.count}</text>`;
        }
      });
    });
  }

  // X-axis labels — one per week, rotated 45° to fit 8 labels without crowding
  labels.forEach((label, i) => {
    const cx = PAD.left + i * groupW + groupW / 2;
    const cy = PAD.top + chartH + 8;
    svg += `<text transform="rotate(-45,${cx},${cy})" x="${cx}" y="${cy}" text-anchor="end" font-size="8" fill="#64748b">${label}</text>`;
  });

  // Average line (optional — pass opts.avgLine = { value, label, color })
  if (opts.avgLine && opts.avgLine.value > 0) {
    const avgY = PAD.top + chartH * (1 - opts.avgLine.value / maxVal)
    const col = opts.avgLine.color || '#64748b'
    svg += `<line x1="${PAD.left}" y1="${avgY}" x2="${PAD.left + chartW}" y2="${avgY}" stroke="${col}" stroke-width="1.5" stroke-dasharray="6,3" opacity="0.8"/>`
    svg += `<text x="${PAD.left + chartW + 3}" y="${avgY + 3}" font-size="8" fill="${col}">${opts.avgLine.label || 'avg'} ${opts.avgLine.value}</text>`
  }

  // Legend
  datasets.forEach((ds_item, di) => {
    const lx = PAD.left + di * 100;
    const ly = H - 8;
    svg += `<rect x="${lx}" y="${ly - 8}" width="10" height="10" rx="2" fill="${ds_item.color}"/>`;
    svg += `<text x="${lx + 14}" y="${ly}" font-size="10" fill="#64748b">${ds_item.label}</text>`;
  });

  svg += '</svg>';
  container.innerHTML = svg;
}

// ─── SVG scatter chart (cycle time) ───────────────────────────────────────────

function renderScatterChart(container, dataPoints, opts = {}) {
  const W = opts.width || 600;
  const H = opts.height || 200;
  const PAD = { top: 10, right: 15, bottom: 46, left: 36 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;

  if (!dataPoints.length) {
    container.innerHTML = '<div style="font-size:.75rem;color:var(--muted, #64748b);padding:.5rem">No cycle time data available</div>';
    return;
  }

  const maxDays = Math.max(1, ...dataPoints.map(d => d.days));
  const dates = dataPoints.map(d => d.closedDate.getTime());
  const minDate = Math.min(...dates);
  const maxDate = Math.max(...dates);
  const dateRange = maxDate - minDate || 1;

  // Percentiles
  const sorted = [...dataPoints.map(d => d.days)].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)] || 0;
  const p85 = sorted[Math.floor(sorted.length * 0.85)] || 0;
  const avg = Math.round(sorted.reduce((s, v) => s + v, 0) / sorted.length);

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" style="width:100%;height:auto">`;

  // Grid lines
  const ySteps = 4;
  for (let i = 0; i <= ySteps; i++) {
    const y = PAD.top + chartH * (1 - i / ySteps);
    const val = Math.round((maxDays * i) / ySteps);
    svg += `<line x1="${PAD.left}" y1="${y}" x2="${PAD.left + chartW}" y2="${y}" stroke="#334155" stroke-width="0.5" stroke-dasharray="4,4" opacity="0.6"/>`;
    svg += `<text x="${PAD.left - 4}" y="${y + 4}" text-anchor="end" font-size="9" fill="#64748b">${val}d</text>`;
  }

  // Percentile lines
  const p50y = PAD.top + chartH * (1 - p50 / maxDays);
  const p85y = PAD.top + chartH * (1 - p85 / maxDays);
  svg += `<line x1="${PAD.left}" y1="${p50y}" x2="${PAD.left + chartW}" y2="${p50y}" stroke="#22c55e" stroke-width="1" stroke-dasharray="4,3"/>`;
  svg += `<text x="${PAD.left + chartW + 2}" y="${p50y + 3}" font-size="8" fill="#22c55e">p50</text>`;
  svg += `<line x1="${PAD.left}" y1="${p85y}" x2="${PAD.left + chartW}" y2="${p85y}" stroke="#f59e0b" stroke-width="1" stroke-dasharray="4,3"/>`;
  svg += `<text x="${PAD.left + chartW + 2}" y="${p85y + 3}" font-size="8" fill="#f59e0b">p85</text>`;

  // Dots (clickable links to ADO work items)
  dataPoints.forEach(d => {
    const x = PAD.left + ((d.closedDate.getTime() - minDate) / dateRange) * chartW;
    const y = PAD.top + chartH * (1 - d.days / maxDays);
    const color = d.type === 'Bug' ? '#ef4444' : '#3b82f6';
    const dot = `<circle cx="${x}" cy="${y}" r="3.5" fill="${color}" opacity="0.65" stroke="${color}" stroke-width="0.75" stroke-opacity="0.9"><title>#${d.id}: ${d.days}d</title></circle>`;
    if (d.url) {
      svg += `<a href="${d.url}" target="_blank" style="cursor:pointer">${dot}</a>`;
    } else {
      svg += dot;
    }
  });

  // X-axis date labels
  const labelCount = Math.min(6, dataPoints.length);
  for (let i = 0; i < labelCount; i++) {
    const t = minDate + (dateRange * i) / (labelCount - 1 || 1);
    const x = PAD.left + (i / (labelCount - 1 || 1)) * chartW;
    const label = new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    svg += `<text x="${x}" y="${PAD.top + chartH + 14}" text-anchor="middle" font-size="8" fill="#64748b">${label}</text>`;
  }

  // Legend
  svg += `<circle cx="${PAD.left}" cy="${H - 10}" r="3.5" fill="#ef4444"/>`;
  svg += `<text x="${PAD.left + 8}" y="${H - 7}" font-size="9" fill="#64748b">Bug</text>`;
  svg += `<circle cx="${PAD.left + 40}" cy="${H - 10}" r="3.5" fill="#3b82f6"/>`;
  svg += `<text x="${PAD.left + 48}" y="${H - 7}" font-size="9" fill="#64748b">Story</text>`;
  svg += `<text x="${PAD.left + 100}" y="${H - 7}" font-size="9" fill="#64748b">avg: ${avg}d · p50: ${p50}d · p85: ${p85}d</text>`;

  svg += '</svg>';
  container.innerHTML = svg;
}

// ─── SVG line chart (burndown) ────────────────────────────────────────────────

function renderLineChart(container, datasets, opts = {}) {
  const W = opts.width || 600;
  const H = opts.height || 200;
  const PAD = { top: 10, right: 15, bottom: 46, left: 36 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;

  if (!datasets.length || !datasets[0].data.length) {
    container.innerHTML = '<div style="font-size:.75rem;color:var(--muted, #64748b);padding:.5rem">No burndown data available</div>';
    return;
  }

  const allVals = datasets.flatMap(ds => ds.data.map(d => d.value));
  const maxVal = Math.max(1, ...allVals);
  const labels = datasets[0].data.map(d => d.label);
  const n = labels.length;

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" style="width:100%;height:auto">`;

  // Grid lines
  for (let i = 0; i <= 4; i++) {
    const y = PAD.top + chartH * (1 - i / 4);
    const val = Math.round((maxVal * i) / 4);
    svg += `<line x1="${PAD.left}" y1="${y}" x2="${PAD.left + chartW}" y2="${y}" stroke="#334155" stroke-width="0.5" stroke-dasharray="4,4" opacity="0.6"/>`;
    svg += `<text x="${PAD.left - 4}" y="${y + 4}" text-anchor="end" font-size="9" fill="#64748b">${val}</text>`;
  }

  // Lines
  datasets.forEach(ds => {
    const points = ds.data.map((d, i) => {
      const x = PAD.left + (i / (n - 1 || 1)) * chartW;
      const y = PAD.top + chartH * (1 - d.value / maxVal);
      return `${x},${y}`;
    });

    // Area fill — explicit via ds.fill, or auto for non-dashed lines
    if (ds.fill || !ds.dashed) {
      const firstX = PAD.left;
      const lastX = PAD.left + ((n - 1) / (n - 1 || 1)) * chartW;
      const baseY = PAD.top + chartH;
      svg += `<polygon points="${firstX},${baseY} ${points.join(' ')} ${lastX},${baseY}" fill="${ds.color}" opacity="${ds.fill ? 0.1 : 0.06}"/>`;
    }

    svg += `<polyline points="${points.join(' ')}" fill="none" stroke="${ds.color}" stroke-width="${ds.dashed ? 1.5 : 2}" stroke-linecap="round" stroke-linejoin="round" ${ds.dashed ? 'stroke-dasharray="6,4"' : ''}/>`;

    // Dots with tooltips
    ds.data.forEach((d, i) => {
      const x = PAD.left + (i / (n - 1 || 1)) * chartW;
      const y = PAD.top + chartH * (1 - d.value / maxVal);
      svg += `<circle cx="${x}" cy="${y}" r="2.5" fill="${ds.color}"><title>${d.label}: ${d.value}</title></circle>`;
    });
  });

  // X-axis labels
  labels.forEach((label, i) => {
    const cx = PAD.left + (i / (n - 1 || 1)) * chartW;
    const cy = PAD.top + chartH + 8;
    svg += `<text transform="rotate(-45,${cx},${cy})" x="${cx}" y="${cy}" text-anchor="end" font-size="8" fill="#64748b">${label}</text>`;
  });

  // Legend
  datasets.forEach((ds, di) => {
    const lx = PAD.left + di * 120;
    const ly = H - 8;
    svg += `<line x1="${lx}" y1="${ly - 3}" x2="${lx + 12}" y2="${ly - 3}" stroke="${ds.color}" stroke-width="2" ${ds.dashed ? 'stroke-dasharray="4,3"' : ''}/>`;
    svg += `<text x="${lx + 16}" y="${ly}" font-size="9" fill="#64748b">${ds.label}</text>`;
  });

  svg += '</svg>';
  container.innerHTML = svg;
}

// ─── SVG stacked bar chart (throughput by person) ────────────────────────────

function renderStackedBarChart(container, labels, people, opts = {}) {
  const W = opts.width || 600;
  const H = opts.height || 200;
  const PAD = { top: 16, right: 10, bottom: 46, left: 28 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;

  if (!people.length) {
    container.innerHTML = '<div style="font-size:.75rem;color:var(--muted, #64748b);padding:.5rem">No per-person throughput data</div>';
    return;
  }

  const n = labels.length;
  const stackedTotals = new Array(n).fill(0);
  for (const p of people) {
    for (let i = 0; i < n; i++) stackedTotals[i] += p.counts[i];
  }
  const maxVal = Math.max(1, ...stackedTotals);
  const groupW = chartW / n;
  const barW = Math.max(12, groupW - 8);

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" style="width:100%;height:auto">`;

  for (let i = 0; i <= 4; i++) {
    const y = PAD.top + (chartH * (1 - i / 4));
    const val = Math.round((maxVal * i) / 4);
    svg += `<line x1="${PAD.left}" y1="${y}" x2="${PAD.left + chartW}" y2="${y}" stroke="#334155" stroke-width="0.5" stroke-dasharray="4,4" opacity="0.6"/>`;
    svg += `<text x="${PAD.left - 4}" y="${y + 4}" text-anchor="end" font-size="9" fill="#64748b">${val}</text>`;
  }

  for (let i = 0; i < n; i++) {
    let yOffset = 0;
    const x = PAD.left + i * groupW + (groupW - barW) / 2;
    for (let pi = 0; pi < people.length; pi++) {
      const count = people[pi].counts[i];
      if (count === 0) continue;
      const barH = (count / maxVal) * chartH;
      const y = PAD.top + chartH - yOffset - barH;
      const color = assigneeColor(people[pi].name);
      svg += `<rect x="${x}" y="${y}" width="${barW}" height="${barH}" rx="2" fill="${color}" opacity="0.85"><title>${people[pi].name.split(' ')[0]}: ${count}</title></rect>`;
      yOffset += barH;
    }
    if (stackedTotals[i] > 0) {
      svg += `<text x="${x + barW / 2}" y="${PAD.top + chartH - yOffset - 3}" text-anchor="middle" font-size="9" fill="#64748b">${stackedTotals[i]}</text>`;
    }
  }

  labels.forEach((label, i) => {
    const cx = PAD.left + i * groupW + groupW / 2;
    const cy = PAD.top + chartH + 8;
    svg += `<text transform="rotate(-45,${cx},${cy})" x="${cx}" y="${cy}" text-anchor="end" font-size="8" fill="#64748b">${label}</text>`;
  });

  const legendPeople = people.slice(0, 8);
  const legendY = H - 8;
  let lx = PAD.left;
  legendPeople.forEach(p => {
    const color = assigneeColor(p.name);
    const short = p.name.split(' ')[0];
    svg += `<rect x="${lx}" y="${legendY - 8}" width="8" height="8" rx="2" fill="${color}"/>`;
    svg += `<text x="${lx + 11}" y="${legendY}" font-size="9" fill="#64748b">${short}</text>`;
    lx += short.length * 6 + 20;
  });

  svg += '</svg>';
  container.innerHTML = svg;
}

// ─── SVG horizontal bar chart (closed by person with history) ────────────────

function renderClosedByPersonChart(container, data, opts = {}) {
  if (!data.length) {
    container.innerHTML = '<div style="font-size:.75rem;color:var(--muted, #64748b);padding:.5rem">No items closed by assignees</div>';
    return;
  }

  const ROW_H = 28;
  const W = opts.width || 500;
  const PAD = { top: 18, right: 90, bottom: 10, left: 100 };
  const LABEL_GAP = 30; // reserve space for count label after bar
  const chartW = W - PAD.left - PAD.right;
  const barMaxW = chartW - LABEL_GAP; // max bar width so label never overlaps avg/wk
  const H = PAD.top + data.length * ROW_H + PAD.bottom;
  const maxVal = Math.max(1, ...data.flatMap(d => [d.thisWeek, ...d.weekly]));

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" style="width:100%;height:auto">`;

  // Column headers
  svg += `<text x="${PAD.left}" y="11" font-size="8" fill="#64748b">this week</text>`;
  svg += `<text x="${PAD.left + chartW + 6}" y="11" font-size="8" fill="#64748b">avg/wk</text>`;

  data.forEach((d, i) => {
    const y = PAD.top + i * ROW_H;
    const color = assigneeColor(d.name);
    const short = d.name.split(' ').slice(0, 2).join(' ');
    const barH = ROW_H - 10;

    // Name
    svg += `<text x="${PAD.left - 6}" y="${y + ROW_H / 2 + 3}" text-anchor="end" font-size="10" fill="currentColor">${short}</text>`;

    // This week bar
    const barW = Math.max(1, (d.thisWeek / maxVal) * barMaxW);
    svg += `<rect x="${PAD.left}" y="${y + 5}" width="${barW}" height="${barH}" rx="3" fill="${color}" opacity="0.75"/>`;

    // This week count label
    svg += `<text x="${PAD.left + barW + 4}" y="${y + ROW_H / 2 + 3}" font-size="10" font-weight="600" fill="${color}">${d.thisWeek}</text>`;

    // Average marker line (dashed vertical)
    const avgX = PAD.left + (d.avg / maxVal) * barMaxW;
    svg += `<line x1="${avgX}" y1="${y + 3}" x2="${avgX}" y2="${y + ROW_H - 3}" stroke="#64748b" stroke-width="1.5" stroke-dasharray="3,2"><title>avg ${d.avg}/wk</title></line>`;

    // Avg/wk label on right
    svg += `<text x="${PAD.left + chartW + 6}" y="${y + ROW_H / 2 + 3}" font-size="9" fill="#64748b">${d.avg}</text>`;

    // Sparkline (8-week trend) — small inline in the right margin
    const spkW = 40;
    const spkH = 12;
    const spkX = PAD.left + chartW + 30;
    const spkY = y + (ROW_H - spkH) / 2;
    const spkMax = Math.max(1, ...d.weekly);
    const spkPoints = d.weekly.map((v, wi) => {
      const px = spkX + (wi / (d.weekly.length - 1 || 1)) * spkW;
      const py = spkY + spkH - (v / spkMax) * spkH;
      return `${px},${py}`;
    }).join(' ');
    svg += `<polyline points="${spkPoints}" fill="none" stroke="${color}" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" opacity="0.6"/>`;
  });

  svg += '</svg>';
  container.innerHTML = svg;
}

// ─── SVG horizontal bar chart (stale items by column) ────────────────────────

function renderStaleItemsChart(container, staleData, opts = {}) {
  if (!staleData.total) {
    container.innerHTML = '<div style="font-size:.75rem;color:#22c55e;padding:.25rem">No stale items</div>';
    return;
  }
  const data = staleData.byColumn;
  const ROW_H = 22;
  const W = opts.width || 500;
  const PAD = { top: 8, right: 35, bottom: 6, left: 90 };
  const chartW = W - PAD.left - PAD.right;
  const H = PAD.top + data.length * ROW_H + PAD.bottom;
  const maxCount = Math.max(1, ...data.map(d => d.count));

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" style="width:100%;height:auto">`;
  data.forEach((d, i) => {
    const y = PAD.top + i * ROW_H;
    const barW = Math.max(1, (d.count / maxCount) * chartW);
    svg += `<text x="${PAD.left - 6}" y="${y + ROW_H / 2 + 3}" text-anchor="end" font-size="9" fill="currentColor">${d.col}</text>`;
    svg += `<rect x="${PAD.left}" y="${y + 3}" width="${barW}" height="${ROW_H - 6}" rx="3" fill="#ef4444" opacity="0.6"/>`;
    svg += `<text x="${PAD.left + barW + 4}" y="${y + ROW_H / 2 + 3}" font-size="9" font-weight="600" fill="#fca5a5">${d.count}</text>`;
  });
  svg += '</svg>';
  container.innerHTML = svg;
}

// ─── Simple metric card renderer ─────────────────────────────────────────────

function renderMetricCard(container, metrics) {
  container.innerHTML = metrics.map(m =>
    `<div style="text-align:center;padding:.25rem .5rem">
      <div style="font-size:1.4rem;font-weight:700;color:${m.color || 'var(--text)'};line-height:1">${m.value}</div>
      <div style="font-size:.625rem;color:var(--muted);margin-top:.1rem">${m.label}</div>
      ${m.sub ? `<div style="font-size:.625rem;color:var(--muted);margin-top:.05rem">${m.sub}</div>` : ''}
    </div>`
  ).join('');
  container.style.cssText = 'display:flex;gap:.75rem;flex-wrap:wrap;justify-content:center';
}

// ─── Priority Age chart: stacked bars — age bands × priority ─────────────────

function renderPriorityAgeChart(container, data, opts = {}) {
  if (!data.priorities.length) {
    container.innerHTML = '<div style="font-size:.75rem;color:var(--muted, #64748b);padding:.5rem">No active items</div>';
    return;
  }

  const W = opts.width || 500;
  const H = opts.height || 150;
  const PAD = { top: 16, right: 80, bottom: 46, left: 28 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;

  const n = data.bands.length;
  const groupW = chartW / n;
  const barW = Math.max(8, groupW - 10);

  // Stacked totals per band
  const totals = data.bands.map((_, bi) =>
    data.priorities.reduce((s, p) => s + p.counts[bi], 0)
  );
  const maxVal = Math.max(1, ...totals);

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" style="width:100%;height:auto">`;

  // Grid lines
  for (let i = 0; i <= 4; i++) {
    const y = PAD.top + chartH * (1 - i / 4);
    const val = Math.round((maxVal * i) / 4);
    svg += `<line x1="${PAD.left}" y1="${y}" x2="${PAD.left + chartW}" y2="${y}" stroke="#334155" stroke-width="0.5" stroke-dasharray="4,4" opacity="0.6"/>`;
    svg += `<text x="${PAD.left - 4}" y="${y + 4}" text-anchor="end" font-size="9" fill="#64748b">${val}</text>`;
  }

  // Stacked bars — bottom to top: P3, P2, P1
  const reversed = [...data.priorities].reverse();
  data.bands.forEach((_, bi) => {
    const x = PAD.left + bi * groupW + (groupW - barW) / 2;
    let yOffset = 0;
    for (const row of reversed) {
      const count = row.counts[bi];
      if (!count) continue;
      const barH = (count / maxVal) * chartH;
      const y = PAD.top + chartH - yOffset - barH;
      svg += `<rect x="${x}" y="${y}" width="${barW}" height="${barH}" rx="2" fill="${row.color}" opacity="0.85"><title>${row.label}: ${count}</title></rect>`;
      yOffset += barH;
    }
    if (totals[bi] > 0) {
      svg += `<text x="${x + barW / 2}" y="${PAD.top + chartH - yOffset - 3}" text-anchor="middle" font-size="9" fill="#64748b">${totals[bi]}</text>`;
    }
  });

  // X-axis labels
  data.bands.forEach((label, i) => {
    const cx = PAD.left + i * groupW + groupW / 2;
    const cy = PAD.top + chartH + 8;
    svg += `<text transform="rotate(-35,${cx},${cy})" x="${cx}" y="${cy}" text-anchor="end" font-size="9" fill="#64748b">${label}</text>`;
  });

  // Legend (right side)
  data.priorities.forEach((row, i) => {
    const lx = PAD.left + chartW + 6;
    const ly = PAD.top + i * 16 + 10;
    svg += `<rect x="${lx}" y="${ly - 7}" width="9" height="9" rx="2" fill="${row.color}"/>`;
    svg += `<text x="${lx + 13}" y="${ly}" font-size="9" fill="#64748b">${row.label}</text>`;
  });

  svg += '</svg>';
  container.innerHTML = svg;
}

// ─── CFD chart: cumulative arrivals vs cumulative closures ────────────────────

function renderCFDChart(container, data, opts = {}) {
  if (!data.length) {
    container.innerHTML = '<div style="font-size:.75rem;color:var(--muted, #64748b);padding:.5rem">No data available</div>';
    return;
  }

  const W = opts.width || 500;
  const H = opts.height || 160;
  const PAD = { top: 10, right: 15, bottom: 46, left: 36 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;
  const n = data.length;

  const maxVal = Math.max(1, ...data.map(d => d.arrived));

  function px(i) { return PAD.left + (i / (n - 1 || 1)) * chartW; }
  function py(v) { return PAD.top + chartH * (1 - v / maxVal); }

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" style="width:100%;height:auto">`;

  // Grid lines
  for (let i = 0; i <= 4; i++) {
    const y = PAD.top + chartH * (1 - i / 4);
    const val = Math.round((maxVal * i) / 4);
    svg += `<line x1="${PAD.left}" y1="${y}" x2="${PAD.left + chartW}" y2="${y}" stroke="#334155" stroke-width="0.5" stroke-dasharray="4,4" opacity="0.6"/>`;
    svg += `<text x="${PAD.left - 4}" y="${y + 4}" text-anchor="end" font-size="9" fill="#64748b">${val}</text>`;
  }

  // Filled WIP band between arrival and closed lines
  const arrPts = data.map((d, i) => `${px(i)},${py(d.arrived)}`).join(' ');
  const clsPtsRev = [...data].reverse().map((d, i) => `${px(n - 1 - i)},${py(d.closed)}`).join(' ');
  svg += `<polygon points="${arrPts} ${clsPtsRev}" fill="#f59e0b" opacity="0.12"/>`;

  // Closed line
  const closedPts = data.map((d, i) => `${px(i)},${py(d.closed)}`).join(' ');
  svg += `<polyline points="${closedPts}" fill="none" stroke="#10b981" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;

  // Arrival line
  const arrivedPts = data.map((d, i) => `${px(i)},${py(d.arrived)}`).join(' ');
  svg += `<polyline points="${arrivedPts}" fill="none" stroke="#6366f1" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;

  // Dots with tooltips
  data.forEach((d, i) => {
    svg += `<circle cx="${px(i)}" cy="${py(d.arrived)}" r="2.5" fill="#6366f1"><title>${d.label}: ${d.arrived} arrived</title></circle>`;
    svg += `<circle cx="${px(i)}" cy="${py(d.closed)}" r="2.5" fill="#10b981"><title>${d.label}: ${d.closed} closed</title></circle>`;
  });

  // Current WIP annotation (last point gap)
  const last = data[data.length - 1];
  const wip = last.arrived - last.closed;
  if (wip > 0) {
    const lx = px(n - 1) + 4;
    const midY = (py(last.arrived) + py(last.closed)) / 2;
    svg += `<line x1="${px(n - 1)}" y1="${py(last.arrived)}" x2="${px(n - 1)}" y2="${py(last.closed)}" stroke="#f59e0b" stroke-width="1.5" stroke-dasharray="3,2"/>`;
    svg += `<text x="${lx}" y="${midY + 3}" font-size="9" fill="#f59e0b" font-weight="600">WIP ${wip}</text>`;
  }

  // X-axis labels
  data.forEach((d, i) => {
    const cx = px(i);
    const cy = PAD.top + chartH + 8;
    svg += `<text transform="rotate(-45,${cx},${cy})" x="${cx}" y="${cy}" text-anchor="end" font-size="8" fill="#64748b">${d.label}</text>`;
  });

  // Legend
  const ly = H - 8;
  svg += `<line x1="${PAD.left}" y1="${ly - 3}" x2="${PAD.left + 12}" y2="${ly - 3}" stroke="#6366f1" stroke-width="2"/>`;
  svg += `<text x="${PAD.left + 16}" y="${ly}" font-size="9" fill="#64748b">Arrived (cumul.)</text>`;
  svg += `<line x1="${PAD.left + 110}" y1="${ly - 3}" x2="${PAD.left + 122}" y2="${ly - 3}" stroke="#10b981" stroke-width="2"/>`;
  svg += `<text x="${PAD.left + 126}" y="${ly}" font-size="9" fill="#64748b">Closed (cumul.)</text>`;
  svg += `<rect x="${PAD.left + 230}" y="${ly - 9}" width="9" height="9" rx="2" fill="#f59e0b" opacity="0.4"/>`;
  svg += `<text x="${PAD.left + 243}" y="${ly}" font-size="9" fill="#64748b">WIP band</text>`;

  svg += '</svg>';
  container.innerHTML = svg;
}

// ─── Theme helpers ────────────────────────────────────────────────────────────

function getTheme() {
  return new Promise(resolve =>
    chrome.storage.local.get('theme', r => resolve(r.theme || 'dark'))
  )
}

function setTheme(theme) {
  return new Promise(resolve =>
    chrome.storage.local.set({ theme }, resolve)
  )
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme)
}

async function initTheme() {
  const theme = await getTheme()
  applyTheme(theme)
  return theme
}

async function toggleTheme() {
  const current = await getTheme()
  const next = current === 'dark' ? 'light' : 'dark'
  await setTheme(next)
  applyTheme(next)
  return next
}

// Ctrl+Shift+T keyboard shortcut for theme toggle (on pages with a document)
if (typeof document !== 'undefined') {
  document.addEventListener('keydown', e => {
    if (e.ctrlKey && e.shiftKey && e.key === 'T') {
      e.preventDefault()
      toggleTheme().then(next => {
        const btn = document.getElementById('theme-btn')
        if (btn) btn.textContent = next === 'dark' ? '☀' : '☾'
      })
    }
  })
}
