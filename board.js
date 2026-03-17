// board.js — Multi-pod tabbed kanban board

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('refresh-btn').addEventListener('click', triggerRefresh);
  document.getElementById('settings-btn').addEventListener('click', () => chrome.runtime.openOptionsPage());
});

// ─── Constants ────────────────────────────────────────────────────────────────

// Column ordering and colours — columns are discovered dynamically from items
const DEFAULT_COLUMN_ORDER = [
  'New', 'Intake/Triage', 'Ready', 'In Progress', 'Active',
  'Code Review', 'Ready for Test', 'Ready for Demo', 'Ready for Release'
];
const COLUMN_COLORS = {
  'New': '#64748b',          'Intake/Triage': '#6366f1',
  'Ready': '#10b981',        'In Progress': '#f59e0b',
  'Active': '#f59e0b',       'Code Review': '#8b5cf6',
  'Ready for Test': '#06b6d4','Ready for Demo': '#f97316',
  'Ready for Release': '#10b981', 'Resolved': '#22c55e'
};
function getColumnColor(name) { return COLUMN_COLORS[name] || '#64748b'; }
function getColumnOrder(name) { const i = DEFAULT_COLUMN_ORDER.indexOf(name); return i >= 0 ? i : DEFAULT_COLUMN_ORDER.length; }


function $(id) { return document.getElementById(id); }

// Persisted filter state per pod — loaded from storage during init
let _boardFilters = {};

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtDate(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  return 'Updated ' + d.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' }) +
         ' · ' + d.toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' });
}

function showBanner(msg, type) {
  const el = $('banner'); el.textContent = msg; el.className = `banner ${type}`;
}
function hideBanner() { $('banner').className = 'banner'; }

// ─── Tab management ───────────────────────────────────────────────────────────

let _activeTab = 'overview';

function buildTabs(pods) {
  const bar = $('tab-bar');
  bar.style.display = '';
  bar.innerHTML = '';

  // Overview tab
  const ovBtn = document.createElement('button');
  ovBtn.className = 'tab-btn active';
  ovBtn.dataset.tab = 'overview';
  ovBtn.textContent = '📊 Overview';
  ovBtn.addEventListener('click', () => switchTab('overview'));
  bar.appendChild(ovBtn);

  // One tab per pod
  pods.forEach(pod => {
    const btn = document.createElement('button');
    btn.className = 'tab-btn';
    btn.dataset.tab = pod.id;
    btn.innerHTML = `<span class="tab-dot" style="background:${podColor(pod.id)}"></span>${escHtml(pod.name)}`;
    btn.addEventListener('click', () => switchTab(pod.id));
    bar.appendChild(btn);
  });
}

function switchTab(tabId) {
  _activeTab = tabId;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tabId));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.dataset.tab === tabId));
}

// ─── Overview panel ───────────────────────────────────────────────────────────

async function buildOverviewPanel(cachedData) {
  const container = $('panels-container');
  let panel = container.querySelector('[data-tab="overview"]');
  if (!panel) {
    panel = document.createElement('div');
    panel.className = 'tab-panel active';
    panel.dataset.tab = 'overview';
    container.appendChild(panel);
  }

  const pods = Object.values(cachedData.pods);
  const allItems = getAllItems(cachedData);
  const arrival = calcWeeklyArrival(allItems, 8);
  const throughput = calcWeeklyThroughput(allItems, 8);
  const stats = arrivalStats(allItems);
  const diff = stats.last7 - stats.prev7;
  const trendClass = diff > 0 ? 'trend-up-bad' : diff < 0 ? 'trend-down-good' : 'trend-neutral';
  const trendText  = diff > 0 ? `↑${diff} vs prev wk` : diff < 0 ? `↓${Math.abs(diff)} vs prev wk` : '→ same';

  panel.innerHTML = `
    <div class="overview-grid" id="overview-grid"></div>
    <div class="metrics-section">
      <h2>📈 Aggregate Flow — All Pods</h2>
      <div class="metrics-grid" id="ov-charts-grid">
        <div class="metric-chart">
          <h3 class="chart-title">Arrival Rate (items/week) <span class="chart-info">?<span class="chart-tip">How many new items entered the board each week. A rising arrival rate with flat throughput signals growing WIP and potential bottlenecks.</span></span></h3>
          <div class="metric-kpis">
            <div class="kpi"><div class="kv" style="color:#60a5fa">${stats.last7}</div><div class="kl">this wk</div></div>
            <div class="kpi"><div class="kv" style="color:#94a3b8">${stats.last30}</div><div class="kl">30d</div></div>
            <div class="kpi"><div class="kv" style="color:#94a3b8">${stats.avgPerWeek}</div><div class="kl">avg/wk</div></div>
            <div class="kpi" style="align-self:center"><span class="trend-badge ${trendClass}">${trendText}</span></div>
          </div>
          <div id="ov-arrival-chart"></div>
        </div>
        <div class="metric-chart">
          <h3 class="chart-title">Throughput (resolved/week) <span class="chart-info">?<span class="chart-tip">Items closed or resolved per week (excludes Spikes). Compare against arrival rate — throughput should match or exceed arrivals to keep WIP stable.</span></span></h3>
          <div class="metric-kpis" id="ov-tp-kpis"></div>
          <div id="ov-throughput-chart"></div>
        </div>
      </div>
      <div id="ov-burndown-row" style="display:none;margin-top:.35rem"></div>
    </div>
  `;

  // Pod summary cards
  const grid = panel.querySelector('#overview-grid');
  pods.forEach(pod => {
    const pActive = (pod.items || []).filter(i => !['Closed','Removed','Resolved'].includes(i.state));
    const pCols   = columnCounts(pActive);
    const pTriage = colCount(pCols, 'Triage', 'Intake');
    const pWip    = colCount(pCols, 'In Progress', 'Active') + colCount(pCols, 'Code Review', 'Review');
    const pRelease= colCount(pCols, 'Ready');
    const pAged   = pActive.filter(x => ageDays(x) >= 90).length;
    const pStats  = arrivalStats(pod.items || []);
    const color   = podColor(pod.id);
    const pDiff   = pStats.last7 - pStats.prev7;
    const pTrend  = pDiff > 0 ? `↑${pDiff}` : pDiff < 0 ? `↓${Math.abs(pDiff)}` : '→';

    const card = document.createElement('div');
    card.className = 'pod-card';
    card.style.borderTopColor = color;
    card.innerHTML = `
      <div class="pod-card-name">${escHtml(pod.name)}</div>
      <div class="pod-card-stats">
        <div class="pod-stat"><div class="ps-label">Triage</div><div class="ps-val" style="color:#6366f1">${pTriage}</div></div>
        <div class="pod-stat"><div class="ps-label">WIP</div><div class="ps-val" style="color:#f59e0b">${pWip}</div></div>
        <div class="pod-stat"><div class="ps-label">Ready</div><div class="ps-val" style="color:#10b981">${pRelease}</div></div>
        <div class="pod-stat"><div class="ps-label">Aged >90d</div><div class="ps-val" style="color:#ef4444">${pAged}</div></div>
      </div>
      <div class="pod-card-footer">
        <span class="pod-arr">↑${pStats.last7} this wk &nbsp;${pTrend} vs prev &nbsp;·&nbsp; avg ${pStats.avgPerWeek}/wk</span>
        ${pod.error ? `<span class="pod-err">⚠ error</span>` : ''}
        ${(() => {
          const wl = pod.wipLimits || {}
          const breaches = Object.entries(wl).filter(([col, lim]) => {
            const cnt = pActive.filter(i => (i.boardColumn || i.state) === col).length
            return cnt > lim
          }).map(([col, lim]) => {
            const cnt = pActive.filter(i => (i.boardColumn || i.state) === col).length
            return `${col}: ${cnt}/${lim}`
          })
          return breaches.length ? `<span class="pod-wip-warn">⚠ WIP over: ${breaches.join(', ')}</span>` : ''
        })()}
      </div>
    `;
    card.addEventListener('click', () => switchTab(pod.id));
    grid.appendChild(card);
  });

  // Aggregate charts — total across all pods
  renderBarChart(panel.querySelector('#ov-arrival-chart'), [
    { label: 'Items arrived', color: '#6366f1', data: arrival }
  ], { width: 500, height: 140 });

  const tpLast7  = throughput[throughput.length-1]?.count || 0;
  const tpPrev7  = throughput[throughput.length-2]?.count || 0;
  const tpLast30 = throughput.slice(-4).reduce((s,w) => s+w.count, 0);
  const tpAvg    = throughput.length ? +(throughput.reduce((s,w) => s+w.count, 0) / throughput.length).toFixed(1) : 0;
  const tpDiff   = tpLast7 - tpPrev7;
  panel.querySelector('#ov-tp-kpis').innerHTML = `
    <div class="kpi"><div class="kv" style="color:#10b981">${tpLast7}</div><div class="kl">this week</div></div>
    <div class="kpi"><div class="kv" style="color:#94a3b8">${tpLast30}</div><div class="kl">last 30d</div></div>
    <div class="kpi"><div class="kv" style="color:#94a3b8">${tpAvg}</div><div class="kl">avg/wk</div></div>
    <div class="kpi" style="align-self:center"><span class="trend-badge ${tpDiff>0?'trend-up-good':tpDiff<0?'trend-up-bad':'trend-neutral'}">${tpDiff>0?`↑${tpDiff}`:tpDiff<0?`↓${Math.abs(tpDiff)}`:'→'} vs prev</span></div>
  `;
  renderBarChart(panel.querySelector('#ov-throughput-chart'), [
    { label: 'Items resolved', color: '#10b981', data: throughput }
  ], { width: 500, height: 140 });

  // Per-pod flow charts — one arrival + throughput chart per pod
  const perPodSection = document.createElement('div');
  perPodSection.style.cssText = 'margin:.35rem 1.25rem .75rem';
  perPodSection.innerHTML = '<h2 style="font-size:.85rem;font-weight:700;margin-bottom:.4rem;color:#e2e8f0">📊 Flow by Pod</h2><div id="per-pod-charts"></div>';
  panel.appendChild(perPodSection);

  const perPodContainer = perPodSection.querySelector('#per-pod-charts');
  pods.forEach(pod => {
    const color = podColor(pod.id);
    const pItems = pod.items || [];
    const pArrival    = calcWeeklyArrival(pItems, 8);
    const pThroughput = calcWeeklyThroughput(pItems, 8);
    const pStats      = arrivalStats(pItems);
    const pTpLast7    = pThroughput[pThroughput.length-1]?.count || 0;
    const pTpLast30   = pThroughput.slice(-4).reduce((s,w) => s+w.count, 0);
    const pTpAvg      = pThroughput.length ? Math.round(pThroughput.reduce((s,w)=>s+w.count,0)/pThroughput.length) : 0;

    const block = document.createElement('div');
    block.dataset.podId = pod.id;
    block.style.cssText = `background:var(--surface);border:1px solid var(--border);border-left:3px solid ${color};border-radius:10px;padding:.5rem .75rem;margin-bottom:.4rem`;
    block.innerHTML = `
      <div class="pod-block-header">
        <div style="font-size:.82rem;font-weight:700;color:#e2e8f0">${escHtml(pod.name)}</div>
        <span class="pod-toggle collapsed">▼</span>
      </div>
      <div class="pod-block-body collapsed">
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:.5rem" class="pod-charts-grid">
          <div>
            <div style="font-size:.68rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:.2rem">Arrival Rate</div>
            <div style="display:flex;gap:.5rem;margin-bottom:.2rem;flex-wrap:wrap">
              <div class="kpi"><div class="kv" style="color:#60a5fa">${pStats.last7}</div><div class="kl">this wk</div></div>
              <div class="kpi"><div class="kv" style="color:#94a3b8">${pStats.last30}</div><div class="kl">30d</div></div>
              <div class="kpi"><div class="kv" style="color:#94a3b8">${pStats.avgPerWeek}</div><div class="kl">avg/wk</div></div>
            </div>
            <div class="pod-arr-chart-${pod.id}"></div>
          </div>
          <div>
            <div style="font-size:.68rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:.2rem">Throughput</div>
            <div style="display:flex;gap:.5rem;margin-bottom:.2rem;flex-wrap:wrap">
              <div class="kpi"><div class="kv" style="color:#10b981">${pTpLast7}</div><div class="kl">this wk</div></div>
              <div class="kpi"><div class="kv" style="color:#94a3b8">${pTpLast30}</div><div class="kl">30d</div></div>
              <div class="kpi"><div class="kv" style="color:#94a3b8">${pTpAvg}</div><div class="kl">avg/wk</div></div>
            </div>
            <div class="pod-tp-chart-${pod.id}"></div>
          </div>
        </div>
      </div>
    `;
    // Wire toggle
    block.querySelector('.pod-block-header').addEventListener('click', () => {
      const body = block.querySelector('.pod-block-body');
      const toggle = block.querySelector('.pod-toggle');
      body.classList.toggle('collapsed');
      toggle.classList.toggle('collapsed');
    });
    perPodContainer.appendChild(block);

    renderBarChart(block.querySelector(`.pod-arr-chart-${pod.id}`), [
      { label: 'Arrived', color, data: pArrival }
    ], { width: 420, height: 110 });
    renderBarChart(block.querySelector(`.pod-tp-chart-${pod.id}`), [
      { label: 'Resolved', color: '#10b981', data: pThroughput }
    ], { width: 420, height: 110 });
  });

  // ── Optional charts ──
  const settings = await getSettings();
  const oc = settings.overviewCharts || {};

  const chartsGrid = panel.querySelector('#ov-charts-grid');

  function tip(title, explanation) {
    return `<div class="chart-title"><span>${escHtml(title)}</span><span class="chart-info">?<span class="chart-tip">${explanation}</span></span></div>`;
  }

  // ── Optional: Throughput by Person (aggregate + per-pod) ──
  if (oc.throughputByPerson) {
    const div = document.createElement('div');
    div.className = 'metric-chart';
    div.innerHTML = tip('Throughput per Person', 'Stacked bars showing each person\'s weekly throughput (closed + resolved, excluding Spikes). Helps identify load imbalances and single points of failure.') + '<div class="tp-person-chart"></div>';
    chartsGrid.appendChild(div);
    const tpByPerson = calcWeeklyThroughputByPerson(allItems, 8);
    renderStackedBarChart(div.querySelector('.tp-person-chart'), tpByPerson.labels, tpByPerson.people, { width: 500, height: 150 });

    // Per-pod throughput by person
    const podBlocks = perPodContainer.querySelectorAll('[data-pod-id]');
    for (const block of podBlocks) {
      const podId = block.dataset.podId;
      const pod = pods.find(p => p.id === podId);
      if (!pod) continue;
      const podTpByPerson = calcWeeklyThroughputByPerson(pod.items || [], 8);
      if (!podTpByPerson.people.length) continue;
      const tpDiv = document.createElement('div');
      tpDiv.innerHTML = '<div style="font-size:.68rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:.2rem">Throughput per Person</div><div class="pod-tp-person"></div>';
      block.querySelector('.pod-charts-grid').appendChild(tpDiv);
      renderStackedBarChart(tpDiv.querySelector('.pod-tp-person'), podTpByPerson.labels, podTpByPerson.people, { width: 400, height: 140 });
    }
  }

  // Shared enrichment for any cycle-time-based chart (avoid double API calls)
  let _enrichedItems = null;
  let _ctData = null;
  async function getEnrichedCycleTimeData() {
    if (!_enrichedItems) {
      _enrichedItems = await enrichWithStartedAt(allItems, settings);
      _ctData = calcCycleTimes(_enrichedItems);
    }
    return _ctData;
  }

  // ── Optional: Items Closed by Person (aggregate + per-pod) ──
  if (oc.cycleTimeByPerson) {
    const closedByPerson = calcClosedByPerson(allItems);
    if (closedByPerson.length) {
      const div = document.createElement('div');
      div.className = 'metric-chart';
      div.innerHTML = tip('Items Closed by Person', 'Items moved to Closed state per person over the last 8 weeks. Shows this week\'s count, 8-week average, and a sparkline trend.') + '<div class="closed-person-chart"></div>';
      chartsGrid.appendChild(div);
      renderClosedByPersonChart(div.querySelector('.closed-person-chart'), closedByPerson, { width: 500 });
    }

    // Per-pod closed by person
    const podBlocks = perPodContainer.querySelectorAll('[data-pod-id]');
    for (const block of podBlocks) {
      const podId = block.dataset.podId;
      const pod = pods.find(p => p.id === podId);
      if (!pod) continue;
      const podClosedByPerson = calcClosedByPerson(pod.items || []);
      if (!podClosedByPerson.length) continue;
      const cbpDiv = document.createElement('div');
      cbpDiv.innerHTML = '<div style="font-size:.68rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:.2rem">Items Closed by Person</div><div class="pod-closed-person"></div>';
      block.querySelector('.pod-charts-grid').appendChild(cbpDiv);
      renderClosedByPersonChart(cbpDiv.querySelector('.pod-closed-person'), podClosedByPerson, { width: 400 });
    }
  }

  // ── Optional: Items Resolved by Person (aggregate + per-pod) ──
  if (oc.resolvedByPerson) {
    const resolvedByPerson = calcResolvedByPerson(allItems);
    if (resolvedByPerson.length) {
      const div = document.createElement('div');
      div.className = 'metric-chart';
      div.innerHTML = tip('Items Resolved by Person', 'Items moved to Resolved state per person over the last 8 weeks. Resolved differs from Closed — an item can be resolved (dev done) but not yet closed (verified/deployed).') + '<div class="resolved-person-chart"></div>';
      chartsGrid.appendChild(div);
      renderClosedByPersonChart(div.querySelector('.resolved-person-chart'), resolvedByPerson, { width: 500 });
    }

    // Per-pod resolved by person
    const podBlocks = perPodContainer.querySelectorAll('[data-pod-id]');
    for (const block of podBlocks) {
      const podId = block.dataset.podId;
      const pod = pods.find(p => p.id === podId);
      if (!pod) continue;
      const podResolvedByPerson = calcResolvedByPerson(pod.items || []);
      if (!podResolvedByPerson.length) continue;
      const rbpDiv = document.createElement('div');
      rbpDiv.innerHTML = '<div style="font-size:.68rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:.2rem">Items Resolved by Person</div><div class="pod-resolved-person"></div>';
      block.querySelector('.pod-charts-grid').appendChild(rbpDiv);
      renderClosedByPersonChart(rbpDiv.querySelector('.pod-resolved-person'), podResolvedByPerson, { width: 400 });
    }
  }

  if (oc.cycleTimeInProgress || oc.cycleTimeArrival) {
    const ctData = await getEnrichedCycleTimeData();

    if (oc.cycleTimeInProgress) {
      const div = document.createElement('div');
      div.className = 'metric-chart';
      div.innerHTML = tip('Cycle: In Progress → Closed', 'Scatter plot of days from first move to In Progress until Closed, per item. Lower and tighter clusters indicate predictable flow. Outliers highlight blocked or stalled work.') + '<div class="ct-ip-chart"></div>';
      chartsGrid.appendChild(div);
      const ipData = ctData.filter(d => d.inProgressToClose != null).map(d => ({
        id: d.id, type: d.type, url: d.url, days: d.inProgressToClose, closedDate: d.closedDate
      }));
      renderScatterChart(div.querySelector('.ct-ip-chart'), ipData, { width: 500, height: 160 });
    }

    if (oc.cycleTimeArrival) {
      const div = document.createElement('div');
      div.className = 'metric-chart';
      div.innerHTML = tip('Cycle: Arrival → Closed', 'Scatter plot of total lead time — days from when an item arrived on the board until it was Closed. Includes wait time in Triage/backlog, so it\'s always >= the In Progress cycle time.') + '<div class="ct-arr-chart"></div>';
      chartsGrid.appendChild(div);
      const arrData = ctData.filter(d => d.arrivalToClose != null).map(d => ({
        id: d.id, type: d.type, url: d.url, days: d.arrivalToClose, closedDate: d.closedDate
      }));
      renderScatterChart(div.querySelector('.ct-arr-chart'), arrData, { width: 500, height: 160 });
    }

    // Per-pod cycle time — inject into each "Flow by Pod" block
    const podBlocks = perPodContainer.querySelectorAll('[data-pod-id]');
    for (const block of podBlocks) {
      const podId = block.dataset.podId;
      const pod = pods.find(p => p.id === podId);
      if (!pod) continue;
      const podItemIds = new Set((pod.items || []).map(i => i.id));
      const podCtData = ctData.filter(d => podItemIds.has(d.id));
      if (!podCtData.length) continue;

      const podGrid = block.querySelector('.pod-charts-grid');

      if (oc.cycleTimeInProgress) {
        const div = document.createElement('div');
        div.innerHTML = '<div style="font-size:.68rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:.2rem">Cycle: In Progress → Closed</div><div class="pod-ct-ip"></div>';
        podGrid.appendChild(div);
        const ipData = podCtData.filter(d => d.inProgressToClose != null).map(d => ({
          id: d.id, type: d.type, url: d.url, days: d.inProgressToClose, closedDate: d.closedDate
        }));
        renderScatterChart(div.querySelector('.pod-ct-ip'), ipData, { width: 400, height: 140 });
      }

      if (oc.cycleTimeArrival) {
        const div = document.createElement('div');
        div.innerHTML = '<div style="font-size:.68rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:.2rem">Cycle: Arrival → Closed</div><div class="pod-ct-arr"></div>';
        podGrid.appendChild(div);
        const arrData = podCtData.filter(d => d.arrivalToClose != null).map(d => ({
          id: d.id, type: d.type, url: d.url, days: d.arrivalToClose, closedDate: d.closedDate
        }));
        renderScatterChart(div.querySelector('.pod-ct-arr'), arrData, { width: 400, height: 140 });
      }
    }
  }

  // ── Optional: WIP Trend ──
  if (oc.wipTrend) {
    const wipData = calcWeeklyWIP(allItems, 8);
    const div = document.createElement('div');
    div.className = 'metric-chart';
    div.innerHTML = tip('WIP Trend', 'Number of active (non-closed, non-removed) items at the end of each week. Rising WIP without rising throughput signals a bottleneck. Aim to keep WIP stable or declining.') + '<div class="wip-trend-chart"></div>';
    chartsGrid.appendChild(div);
    renderLineChart(div.querySelector('.wip-trend-chart'), [
      { label: 'WIP', color: '#f59e0b', data: wipData }
    ], { width: 500, height: 140 });

    for (const block of perPodContainer.querySelectorAll('[data-pod-id]')) {
      const pod = pods.find(p => p.id === block.dataset.podId);
      if (!pod) continue;
      const podWip = calcWeeklyWIP(pod.items || [], 8);
      const d = document.createElement('div');
      d.innerHTML = '<div style="font-size:.68rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:.2rem">WIP Trend</div><div class="pod-wip"></div>';
      block.querySelector('.pod-charts-grid').appendChild(d);
      renderLineChart(d.querySelector('.pod-wip'), [{ label: 'WIP', color: '#f59e0b', data: podWip }], { width: 400, height: 120 });
    }
  }

  // ── Optional: Age Distribution ──
  if (oc.ageDistribution) {
    const ageDist = calcAgeDistribution(allItems);
    const div = document.createElement('div');
    div.className = 'metric-chart';
    div.innerHTML = tip('Age Distribution', 'Groups all active items by how long they\'ve been open (0-7d, 7-14d, etc.). A healthy board has most items in the younger buckets. Heavy right-side weight means items are ageing and may need attention.') + '<div class="age-dist-chart"></div>';
    chartsGrid.appendChild(div);
    renderBarChart(div.querySelector('.age-dist-chart'), [
      { label: 'Items', color: '#8b5cf6', data: ageDist }
    ], { width: 500, height: 140 });

    for (const block of perPodContainer.querySelectorAll('[data-pod-id]')) {
      const pod = pods.find(p => p.id === block.dataset.podId);
      if (!pod) continue;
      const podAge = calcAgeDistribution(pod.items || []);
      const d = document.createElement('div');
      d.innerHTML = '<div style="font-size:.68rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:.2rem">Age Distribution</div><div class="pod-age"></div>';
      block.querySelector('.pod-charts-grid').appendChild(d);
      renderBarChart(d.querySelector('.pod-age'), [{ label: 'Items', color: '#8b5cf6', data: podAge }], { width: 400, height: 120 });
    }
  }

  // ── Optional: Flow Efficiency ──
  if (oc.flowEfficiency) {
    const ctForEff = await getEnrichedCycleTimeData();
    const eff = calcFlowEfficiency(ctForEff);
    const div = document.createElement('div');
    div.className = 'metric-chart';
    div.innerHTML = tip('Flow Efficiency', 'Ratio of active work time (In Progress → Closed) to total lead time (Arrival → Closed). Higher is better — 40%+ is good, below 20% means items spend most of their life waiting, not being worked on.') + '<div class="flow-eff-metrics"></div>';
    chartsGrid.appendChild(div);
    if (eff) {
      renderMetricCard(div.querySelector('.flow-eff-metrics'), [
        { label: 'avg efficiency', value: eff.pct + '%', color: eff.pct >= 40 ? '#22c55e' : eff.pct >= 20 ? '#f59e0b' : '#ef4444' },
        { label: 'median', value: eff.median + '%', color: '#94a3b8' },
        { label: 'items measured', value: eff.count, color: '#94a3b8' }
      ]);
    } else {
      div.querySelector('.flow-eff-metrics').innerHTML = '<div style="font-size:.75rem;color:#64748b;padding:.25rem">Insufficient data</div>';
    }

    for (const block of perPodContainer.querySelectorAll('[data-pod-id]')) {
      const pod = pods.find(p => p.id === block.dataset.podId);
      if (!pod) continue;
      const podItemIds = new Set((pod.items || []).map(i => i.id));
      const podCtData = ctForEff.filter(d => podItemIds.has(d.id));
      const podEff = calcFlowEfficiency(podCtData);
      if (!podEff) continue;
      const d = document.createElement('div');
      d.innerHTML = '<div style="font-size:.68rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:.2rem">Flow Efficiency</div><div class="pod-eff"></div>';
      block.querySelector('.pod-charts-grid').appendChild(d);
      renderMetricCard(d.querySelector('.pod-eff'), [
        { label: 'avg', value: podEff.pct + '%', color: podEff.pct >= 40 ? '#22c55e' : podEff.pct >= 20 ? '#f59e0b' : '#ef4444' },
        { label: 'median', value: podEff.median + '%', color: '#94a3b8' }
      ]);
    }
  }

  // ── Optional: Stale Items ──
  if (oc.staleItems) {
    const stale = calcStaleItems(allItems);
    const div = document.createElement('div');
    div.className = 'metric-chart';
    div.innerHTML = tip(`Stale Items (no change 14d+) — ${stale.total} total`, 'Active items with no field changes in 14+ days, grouped by board column. These may be blocked, forgotten, or need re-prioritisation. Check with the assignee.') + '<div class="stale-chart"></div>';
    chartsGrid.appendChild(div);
    renderStaleItemsChart(div.querySelector('.stale-chart'), stale, { width: 500 });

    for (const block of perPodContainer.querySelectorAll('[data-pod-id]')) {
      const pod = pods.find(p => p.id === block.dataset.podId);
      if (!pod) continue;
      const podStale = calcStaleItems(pod.items || []);
      const d = document.createElement('div');
      d.innerHTML = `<div style="font-size:.68rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:.2rem">Stale Items (14d+) — ${podStale.total}</div><div class="pod-stale"></div>`;
      block.querySelector('.pod-charts-grid').appendChild(d);
      renderStaleItemsChart(d.querySelector('.pod-stale'), podStale, { width: 400 });
    }
  }

  // ── Optional: Bug Ratio Trend ──
  if (oc.bugRatioTrend) {
    const bugRatio = calcBugRatioTrend(allItems, 8);
    const div = document.createElement('div');
    div.className = 'metric-chart';
    div.innerHTML = tip('Bug Ratio Trend (%)', 'Bugs as a percentage of weekly throughput. A rising ratio may indicate quality issues or increasing tech debt. Aim to keep this stable or declining over time.') + '<div class="bug-ratio-chart"></div>';
    chartsGrid.appendChild(div);
    renderBarChart(div.querySelector('.bug-ratio-chart'), [
      { label: 'Bug %', color: '#ef4444', data: bugRatio.map(d => ({ label: d.label, count: d.pct })) }
    ], { width: 500, height: 140 });

    for (const block of perPodContainer.querySelectorAll('[data-pod-id]')) {
      const pod = pods.find(p => p.id === block.dataset.podId);
      if (!pod) continue;
      const podBug = calcBugRatioTrend(pod.items || [], 8);
      const d = document.createElement('div');
      d.innerHTML = '<div style="font-size:.68rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:.2rem">Bug Ratio Trend (%)</div><div class="pod-bug"></div>';
      block.querySelector('.pod-charts-grid').appendChild(d);
      renderBarChart(d.querySelector('.pod-bug'), [{ label: 'Bug %', color: '#ef4444', data: podBug.map(r => ({ label: r.label, count: r.pct })) }], { width: 400, height: 120 });
    }
  }

  // ── Optional: Throughput Predictability ──
  if (oc.throughputPredictability) {
    const pred = calcThroughputPredictability(allItems, 8);
    const div = document.createElement('div');
    div.className = 'metric-chart';
    div.innerHTML = tip('Throughput Predictability', 'Coefficient of Variation (CV) measures how consistent weekly throughput is. CV = std dev / mean. Below 0.3 is Stable (predictable delivery), 0.3-0.6 is Moderate, above 0.6 is Volatile (hard to forecast). The weekly breakdown shows the raw counts driving the calculation.') + '<div class="tp-pred-metrics"></div><div class="tp-pred-weekly"></div>';
    chartsGrid.appendChild(div);
    if (pred) {
      renderMetricCard(div.querySelector('.tp-pred-metrics'), [
        { label: 'rating', value: pred.rating, color: pred.ratingColor },
        { label: 'avg/wk', value: pred.mean, color: '#94a3b8' },
        { label: 'std dev', value: pred.stdDev, color: '#94a3b8' },
        { label: 'CV', value: pred.cv, color: '#94a3b8', sub: '< 0.3 = stable' }
      ]);
      const weeklyHtml = pred.weekly.map(w => {
        const diff = w.count - pred.mean;
        const col = Math.abs(diff) > pred.stdDev ? '#ef4444' : '#94a3b8';
        return `<div style="display:flex;justify-content:space-between;padding:.1rem .3rem;font-size:.68rem"><span style="color:#64748b">${w.label}</span><span style="color:${col};font-weight:600">${w.count}</span></div>`;
      }).join('');
      div.querySelector('.tp-pred-weekly').innerHTML = `<div style="margin-top:.35rem;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:.25rem .1rem;max-width:200px;margin-left:auto;margin-right:auto">${weeklyHtml}</div>`;
    } else {
      div.querySelector('.tp-pred-metrics').innerHTML = '<div style="font-size:.75rem;color:#64748b;padding:.25rem">Insufficient data</div>';
    }

    for (const block of perPodContainer.querySelectorAll('[data-pod-id]')) {
      const pod = pods.find(p => p.id === block.dataset.podId);
      if (!pod) continue;
      const podPred = calcThroughputPredictability(pod.items || [], 8);
      if (!podPred) continue;
      const d = document.createElement('div');
      d.innerHTML = '<div style="font-size:.68rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:.2rem">Predictability</div><div class="pod-pred"></div><div class="pod-pred-weekly"></div>';
      block.querySelector('.pod-charts-grid').appendChild(d);
      renderMetricCard(d.querySelector('.pod-pred'), [
        { label: 'rating', value: podPred.rating, color: podPred.ratingColor },
        { label: 'avg/wk', value: podPred.mean, color: '#94a3b8' },
        { label: 'CV', value: podPred.cv, color: '#94a3b8' }
      ]);
      const podWeeklyHtml = podPred.weekly.map(w => {
        const diff = w.count - podPred.mean;
        const col = Math.abs(diff) > podPred.stdDev ? '#ef4444' : '#94a3b8';
        return `<div style="display:flex;justify-content:space-between;padding:.1rem .3rem;font-size:.68rem"><span style="color:#64748b">${w.label}</span><span style="color:${col};font-weight:600">${w.count}</span></div>`;
      }).join('');
      d.querySelector('.pod-pred-weekly').innerHTML = `<div style="margin-top:.25rem;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:.25rem .1rem">${podWeeklyHtml}</div>`;
    }
  }

  // ── Optional: Priority Age Distribution ──
  if (oc.priorityAgeDistribution) {
    const prioAge = calcPriorityAgeDistribution(allItems);
    const div = document.createElement('div');
    div.className = 'metric-chart';
    div.innerHTML = tip('Priority Age Distribution', 'Active items grouped by age band and priority (P1/P2/P3). Red bars are P1 — any P1 items in the 60d+ buckets need immediate attention. Helps identify aged high-priority debt before it becomes critical.') + '<div class="prio-age-chart"></div>';
    chartsGrid.appendChild(div);
    renderPriorityAgeChart(div.querySelector('.prio-age-chart'), prioAge, { width: 500, height: 150 });

    for (const block of perPodContainer.querySelectorAll('[data-pod-id]')) {
      const pod = pods.find(p => p.id === block.dataset.podId);
      if (!pod) continue;
      const podPrioAge = calcPriorityAgeDistribution(pod.items || []);
      if (!podPrioAge.priorities.length) continue;
      const d = document.createElement('div');
      d.innerHTML = '<div style="font-size:.68rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:.2rem">Priority Age Distribution</div><div class="pod-prio-age"></div>';
      block.querySelector('.pod-charts-grid').appendChild(d);
      renderPriorityAgeChart(d.querySelector('.pod-prio-age'), podPrioAge, { width: 400, height: 130 });
    }
  }

  // ── Optional: Cumulative Flow Diagram ──
  if (oc.cfdChart) {
    const cfd = calcCumulativeFlow(allItems, 12);
    const div = document.createElement('div');
    div.className = 'metric-chart';
    div.innerHTML = tip('Cumulative Flow Diagram', 'Cumulative arrival and closure counts over 12 weeks. The amber band between the two lines is your live WIP. A widening band means work is arriving faster than it is being closed — a leading indicator of future delays.') + '<div class="cfd-chart"></div>';
    chartsGrid.appendChild(div);
    renderCFDChart(div.querySelector('.cfd-chart'), cfd, { width: 500, height: 160 });

    for (const block of perPodContainer.querySelectorAll('[data-pod-id]')) {
      const pod = pods.find(p => p.id === block.dataset.podId);
      if (!pod) continue;
      const podCfd = calcCumulativeFlow(pod.items || [], 12);
      const d = document.createElement('div');
      d.innerHTML = '<div style="font-size:.68rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:.2rem">Cumulative Flow Diagram</div><div class="pod-cfd"></div>';
      block.querySelector('.pod-charts-grid').appendChild(d);
      renderCFDChart(d.querySelector('.pod-cfd'), podCfd, { width: 400, height: 140 });
    }
  }

  if (oc.burndownByPI) {
    const piValues = [...new Set(allItems.map(i => i.targetPI).filter(Boolean))].sort();
    if (piValues.length > 0) {
      // Aggregate burndown — inject into "Aggregate Flow — All Pods" panel
      const bdRow = panel.querySelector('#ov-burndown-row');
      if (bdRow) {
        bdRow.style.display = '';
        bdRow.innerHTML = `
          <h3 style="font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:.25rem">Burndown by Target PI</h3>
          <div style="margin-bottom:.5rem">
            <select class="pi-selector" id="ov-pi-selector">
              ${piValues.map(pi => `<option value="${escHtml(pi)}">${escHtml(pi)}</option>`).join('')}
            </select>
          </div>
          <div id="ov-burndown-chart"></div>
        `;

        function renderAggregateBurndown(selectedPI) {
          const data = calcBurndown(allItems, selectedPI);
          renderLineChart(bdRow.querySelector('#ov-burndown-chart'), [
            { label: 'Remaining', color: '#3b82f6', fill: true, data: data.map(d => ({ label: d.label, value: d.remaining })) },
            { label: 'Ideal', color: '#64748b', dashed: true, data: data.map(d => ({ label: d.label, value: d.ideal })) }
          ], { width: 600, height: 200 });
        }

        renderAggregateBurndown(piValues[0]);
        bdRow.querySelector('#ov-pi-selector').addEventListener('change', e => renderAggregateBurndown(e.target.value));
      }

      // Per-pod burndown — inject into each "Flow by Pod" block
      const podBlocks = perPodContainer.querySelectorAll('[data-pod-id]');
      for (const block of podBlocks) {
        const podId = block.dataset.podId;
        const pod = pods.find(p => p.id === podId);
        if (!pod) continue;
        const podPIValues = [...new Set((pod.items || []).map(i => i.targetPI).filter(Boolean))].sort();
        if (!podPIValues.length) continue;

        const bdDiv = document.createElement('div');
        bdDiv.innerHTML = `
          <div style="font-size:.68rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:.2rem">Burndown by Target PI</div>
          <div style="margin-bottom:.3rem">
            <select class="pi-selector pod-pi-selector">
              ${podPIValues.map(pi => `<option value="${escHtml(pi)}">${escHtml(pi)}</option>`).join('')}
            </select>
          </div>
          <div class="pod-burndown-chart"></div>
        `;
        block.querySelector('.pod-charts-grid').appendChild(bdDiv);

        function renderPodBurndown(selectedPI) {
          const data = calcBurndown(pod.items || [], selectedPI);
          renderLineChart(bdDiv.querySelector('.pod-burndown-chart'), [
            { label: 'Remaining', color: '#3b82f6', fill: true, data: data.map(d => ({ label: d.label, value: d.remaining })) },
            { label: 'Ideal', color: '#64748b', dashed: true, data: data.map(d => ({ label: d.label, value: d.ideal })) }
          ], { width: 420, height: 160 });
        }

        renderPodBurndown(podPIValues[0]);
        bdDiv.querySelector('.pod-pi-selector').addEventListener('change', e => renderPodBurndown(e.target.value));
      }
    }
  }
}

// ─── Per-pod panel ────────────────────────────────────────────────────────────

// Returns the display column name for an item (boardColumn from ADO, or state fallback)
function itemColumn(item) {
  return item.boardColumn || item.state || 'Unknown';
}

function makeCard(item) {
  const days = ageDays(item);
  const typeCls = item.type === 'Bug' ? 'type-bug' : 'type-story';
  const typeBadge = item.type === 'Bug' ? '<span class="badge badge-bug">Bug</span>' : '<span class="badge badge-story">Story</span>';
  const spBadge  = item.sp ? `<span class="badge badge-sp">${item.sp}sp</span>` : '';
  const priBadge = `<span class="badge badge-p${item.priority}">P${item.priority}</span>`;
  const asgn = item.assignee
    ? `<div class="mini-avatar" style="background:${assigneeColor(item.assignee)}">${initials(item.assignee)}</div><span>${item.assignee.split(' ')[0]}</span>`
    : `<span style="opacity:.45">Unassigned</span>`;
  const tagsHtml = item.tags.length
    ? `<div class="card-tags">${item.tags.map(t=>`<span class="tag">${escHtml(t)}</span>`).join('')}</div>` : '';

  return `<a class="card ${typeCls}" href="${item.url}" target="_blank"
      draggable="true" data-item-id="${item.id}" data-stack-rank="${item.stackRank || 0}"
      data-assignee="${item.assignee||'__unassigned__'}" data-age="${days}" data-type="${item.type}"
      data-title="${escHtml(item.title.toLowerCase())}" data-id="${item.id}"
      data-tags="${escHtml(item.tags.join(' ').toLowerCase())}">
    <div class="card-top">
      <span class="card-id">#${item.id}</span>
      <div class="card-badges">${priBadge}${typeBadge}${spBadge}</div>
    </div>
    <div class="card-title">${escHtml(item.title)}</div>
    ${tagsHtml}
    <div class="card-footer">
      <div class="card-assignee">${asgn}</div>
      <span class="age-pill ${ageClass(days)}">${ageLabel(days)}</span>
    </div>
  </a>`;
}

function buildPodPanel(pod) {
  const container = $('panels-container');
  let panel = container.querySelector(`[data-tab="${pod.id}"]`);
  if (!panel) {
    panel = document.createElement('div');
    panel.className = 'tab-panel';
    panel.dataset.tab = pod.id;
    container.appendChild(panel);
  }

  const items = pod.items || [];
  const active = items.filter(i => !['Closed','Removed'].includes(i.state));

  // Discover columns dynamically from items' boardColumn values
  const colSet = new Set();
  for (const item of active) colSet.add(itemColumn(item));
  const columnNames = [...colSet].sort((a, b) => getColumnOrder(a) - getColumnOrder(b));

  const byCol = {};
  for (const col of columnNames) byCol[col] = [];
  for (const item of active) byCol[itemColumn(item)].push(item);
  for (const col of columnNames) {
    byCol[col].sort((a, b) => {
      // Sort by StackRank if available (lowest first), fallback to assignee+age
      if (a.stackRank && b.stackRank) return a.stackRank - b.stackRank;
      if (a.stackRank) return -1;
      if (b.stackRank) return 1;
      if (!!a.assignee !== !!b.assignee) return a.assignee ? -1 : 1;
      return ageDays(b) - ageDays(a);
    });
  }

  const load = teamLoad(active);
  const arrival = calcWeeklyArrival(items, 8);
  const throughput = calcWeeklyThroughput(items, 8);
  const stats = arrivalStats(items);
  const diff = stats.last7 - stats.prev7;

  // Team cards HTML
  const teamCardsHtml = Object.entries(load).sort((a,b)=>b[1].total-a[1].total).map(([name,info]) => {
    const dots = Object.entries(info.columns).flatMap(([col,cnt])=>Array(cnt).fill(`<span class="wip-dot" style="background:${getColumnColor(col)}" title="${col}"></span>`)).join('');
    return `<div class="team-card"><div class="avatar" style="background:${assigneeColor(name)}">${initials(name)}</div><div><div class="t-name">${escHtml(name.split(' ').slice(0,2).join(' '))}</div><div class="t-sub">${info.total} item${info.total!==1?'s':''} &nbsp;${dots}</div></div></div>`;
  }).join('');

  // Assignee filter buttons
  const assigneeBtns = Object.keys(load).map(name =>
    `<button class="filter-btn" data-filter="assignee:${escHtml(name)}">${escHtml(name.split(' ')[0])}</button>`
  ).join('');

  const trendClass = diff>0?'trend-up-bad':diff<0?'trend-down-good':'trend-neutral';
  const trendText  = diff>0?`↑${diff} vs prev wk`:diff<0?`↓${Math.abs(diff)} vs prev wk`:'→ same';
  const tpLast7    = throughput[throughput.length-1]?.count||0;
  const tpPrev7    = throughput[throughput.length-2]?.count||0;
  const tpLast30   = throughput.slice(-4).reduce((s,w)=>s+w.count,0);
  const tpAvgPod   = throughput.length ? +(throughput.reduce((s,w)=>s+w.count,0)/throughput.length).toFixed(1) : 0;
  const tpDiff     = tpLast7-tpPrev7;

  panel.innerHTML = `
    <div class="filters">
      <input type="text" class="search-input" placeholder="Search by title, ID, or tag\u2026" />
      <span class="filter-label">Filter:</span>
      <button class="filter-btn active" data-filter="all">All</button>
      ${assigneeBtns}
      <button class="filter-btn" data-filter="unassigned">Unassigned</button>
      <button class="filter-btn" data-filter="aged">🔴 Aged &gt;90d</button>
      <button class="filter-btn" data-filter="bugs">Bugs only</button>
    </div>
    <div class="stats-row">
      ${columnNames.map(col => `<div class="stat-card"><div class="label">${escHtml(col)}</div><div class="value" style="color:${getColumnColor(col)}">${byCol[col].length}</div></div>`).join('')}
      <div class="stat-card"><div class="label">Aged &gt;90d</div><div class="value" style="color:#ef4444">${active.filter(i=>ageDays(i)>=90).length}</div></div>
      <div class="stat-card"><div class="label">Total</div><div class="value" style="color:#e2e8f0">${active.length}</div></div>
    </div>
    <div class="team-row">${teamCardsHtml}</div>
    <div class="metrics-section">
      <h2>📈 Flow Metrics — ${escHtml(pod.name)}</h2>
      <div class="metrics-grid">
        <div class="metric-chart">
          <h3>Arrival Rate</h3>
          <div class="metric-kpis">
            <div class="kpi"><div class="kv" style="color:#60a5fa">${stats.last7}</div><div class="kl">this week</div></div>
            <div class="kpi"><div class="kv" style="color:#94a3b8">${stats.last30}</div><div class="kl">last 30d</div></div>
            <div class="kpi"><div class="kv" style="color:#94a3b8">${stats.avgPerWeek}</div><div class="kl">avg/wk</div></div>
            <div class="kpi" style="align-self:center"><span class="trend-badge ${trendClass}">${trendText}</span></div>
          </div>
          <div class="pod-arrival-chart"></div>
        </div>
        <div class="metric-chart">
          <h3>Throughput</h3>
          <div class="metric-kpis">
            <div class="kpi"><div class="kv" style="color:#10b981">${tpLast7}</div><div class="kl">this week</div></div>
            <div class="kpi"><div class="kv" style="color:#94a3b8">${tpLast30}</div><div class="kl">last 30d</div></div>
            <div class="kpi"><div class="kv" style="color:#94a3b8">${tpAvgPod}</div><div class="kl">avg/wk</div></div>
            <div class="kpi" style="align-self:center"><span class="trend-badge ${tpDiff>0?'trend-up-good':tpDiff<0?'trend-up-bad':'trend-neutral'}">${tpDiff>0?`↑${tpDiff}`:tpDiff<0?`↓${Math.abs(tpDiff)}`:'→'} vs prev</span></div>
          </div>
          <div class="pod-throughput-chart"></div>
        </div>
      </div>
    </div>
    <div class="section-label">Board</div>
    <div class="board">
      ${columnNames.map(col => {
        const dotColor = getColumnColor(col);
        const wipLimit = (pod.wipLimits || {})[col];
        const colCount = byCol[col].length;
        const wipExceeded = wipLimit && colCount > wipLimit;
        const countLabel = wipLimit ? `${colCount} / ${wipLimit}` : colCount;
        return `<div class="column${wipExceeded ? ' wip-exceeded' : ''}">
          <div class="col-header${wipExceeded ? ' wip-exceeded' : ''}">
            <div class="col-title"><div class="col-dot" style="background:${dotColor}"></div>${escHtml(col)}</div>
            <span class="col-count">${countLabel}</span>
          </div>
          <div class="col-body" data-column="${escHtml(col)}">${byCol[col].map(makeCard).join('')}</div>
        </div>`;
      }).join('')}
    </div>
    ${pod.error ? `<div style="margin:0 1.25rem 1rem;padding:.5rem .85rem;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);border-radius:8px;font-size:.78rem;color:#fca5a5">⚠ Last fetch failed: ${escHtml(pod.error)}</div>` : ''}
  `;

  // ── Helper: update column counts ──
  function updateColCounts() {
    panel.querySelectorAll('.column').forEach(colEl => {
      const colName = colEl.querySelector('.col-body')?.dataset.column
      const wipLimit = (pod.wipLimits || {})[colName]
      const visible = colEl.querySelectorAll('.card:not(.hidden)').length
      colEl.querySelector('.col-count').textContent = wipLimit ? `${visible} / ${wipLimit}` : visible
      const exceeded = wipLimit && visible > wipLimit
      colEl.querySelector('.col-header').classList.toggle('wip-exceeded', exceeded)
      colEl.classList.toggle('wip-exceeded', exceeded)
    })
  }

  // ── Helper: apply search + filter together ──
  function applyFilters() {
    const query = (panel.querySelector('.search-input')?.value || '').trim().toLowerCase();
    const activeBtn = panel.querySelector('.filter-btn.active');
    const v = activeBtn?.dataset.filter || 'all';
    panel.querySelectorAll('.card').forEach(card => {
      let filterShow = v === 'all' ? true
        : v === 'unassigned' ? card.dataset.assignee === '__unassigned__'
        : v === 'aged'       ? parseInt(card.dataset.age, 10) >= 90
        : v === 'bugs'       ? card.dataset.type === 'Bug'
        : v.startsWith('assignee:') ? card.dataset.assignee === v.slice(9)
        : true;
      let searchShow = true;
      if (query) {
        searchShow = (card.dataset.title || '').includes(query)
          || (card.dataset.id || '').includes(query)
          || (card.dataset.tags || '').includes(query);
      }
      card.classList.toggle('hidden', !(filterShow && searchShow));
    });
    updateColCounts();
    // Persist filter state for this pod
    _boardFilters[pod.id] = { filter: v, search: query };
    chrome.storage.local.set({ boardFilters: _boardFilters });
  }

  // Wire search input
  const searchInput = panel.querySelector('.search-input');
  if (searchInput) {
    searchInput.addEventListener('input', applyFilters);
  }

  // Wire delegated filter listener
  panel.querySelector('.filters').addEventListener('click', e => {
    const btn = e.target.closest('.filter-btn');
    if (!btn) return;
    panel.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    applyFilters();
  });

  // Restore previously saved filter state for this pod
  const savedFilter = _boardFilters[pod.id];
  if (savedFilter) {
    if (savedFilter.search) {
      const si = panel.querySelector('.search-input');
      if (si) si.value = savedFilter.search;
    }
    if (savedFilter.filter && savedFilter.filter !== 'all') {
      const btn = panel.querySelector(`.filter-btn[data-filter="${CSS.escape(savedFilter.filter)}"]`);
      if (btn) {
        panel.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      }
    }
    if (savedFilter.search || (savedFilter.filter && savedFilter.filter !== 'all')) {
      applyFilters();
    }
  }

  // ── Drag-and-drop ──
  let _draggedCard = null;

  panel.querySelectorAll('.col-body').forEach(colBody => {
    colBody.addEventListener('dragstart', e => {
      const card = e.target.closest('.card');
      if (!card) return;
      _draggedCard = card;
      card.classList.add('dragging');
      e.dataTransfer.setData('text/plain', card.dataset.itemId);
      e.dataTransfer.effectAllowed = 'move';
    });

    colBody.addEventListener('dragend', e => {
      const card = e.target.closest('.card');
      if (card) card.classList.remove('dragging');
      panel.querySelectorAll('.drop-indicator').forEach(el => el.remove());
      panel.querySelectorAll('.col-body.drag-over').forEach(el => el.classList.remove('drag-over'));
      _draggedCard = null;
    });

    colBody.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      colBody.classList.add('drag-over');

      // Remove existing indicators
      panel.querySelectorAll('.drop-indicator').forEach(el => el.remove());

      // Find insertion point
      const cards = [...colBody.querySelectorAll('.card:not(.dragging)')];
      let insertBefore = null;
      for (const c of cards) {
        const rect = c.getBoundingClientRect();
        if (e.clientY < rect.top + rect.height / 2) { insertBefore = c; break; }
      }

      const indicator = document.createElement('div');
      indicator.className = 'drop-indicator';
      if (insertBefore) colBody.insertBefore(indicator, insertBefore);
      else colBody.appendChild(indicator);
    });

    colBody.addEventListener('dragleave', e => {
      if (!colBody.contains(e.relatedTarget)) {
        colBody.classList.remove('drag-over');
        colBody.querySelectorAll('.drop-indicator').forEach(el => el.remove());
      }
    });

    colBody.addEventListener('drop', async e => {
      e.preventDefault();
      colBody.classList.remove('drag-over');
      panel.querySelectorAll('.drop-indicator').forEach(el => el.remove());

      if (!_draggedCard) return;
      const card = _draggedCard;
      const itemId = parseInt(card.dataset.itemId, 10);

      // Capture original position and rank before any DOM mutation (for revert on failure)
      const originalParent = card.parentElement;
      const originalNextSibling = card.nextSibling;
      const originalStackRank = card.dataset.stackRank;

      // Find insertion point
      const cards = [...colBody.querySelectorAll('.card:not(.dragging)')];
      let insertBefore = null;
      for (const c of cards) {
        const rect = c.getBoundingClientRect();
        if (e.clientY < rect.top + rect.height / 2) { insertBefore = c; break; }
      }

      // Move DOM element
      if (insertBefore) colBody.insertBefore(card, insertBefore);
      else colBody.appendChild(card);

      // Calculate new StackRank
      const prevCard = card.previousElementSibling?.classList.contains('card') ? card.previousElementSibling : null;
      const nextCard = card.nextElementSibling?.classList.contains('card') ? card.nextElementSibling : null;
      const aboveRank = prevCard ? parseFloat(prevCard.dataset.stackRank) || null : null;
      const belowRank = nextCard ? parseFloat(nextCard.dataset.stackRank) || null : null;
      const newRank = calcNewStackRank(aboveRank, belowRank);
      card.dataset.stackRank = newRank;

      // Detect cross-column move
      const newColumn = colBody.dataset.column;
      const crossColumn = originalParent !== colBody ? newColumn : null;

      // Save to ADO
      card.classList.add('saving');
      try {
        const settings = await getSettings();
        await reorderWorkItem(itemId, newRank, crossColumn, settings);
        card.classList.remove('saving');
        updateColCounts();
      } catch (err) {
        card.classList.remove('saving');
        // Revert card to its original position and rank
        originalParent.insertBefore(card, originalNextSibling);
        card.dataset.stackRank = originalStackRank;
        updateColCounts();
        showBanner(`⚠ Failed to save card reorder: ${err.message}`, 'err');
      }
    });
  });

  // Render charts
  renderBarChart(panel.querySelector('.pod-arrival-chart'), [{ label:'Items arrived', color:'#6366f1', data:arrival }], { width:500, height:120 });
  renderBarChart(panel.querySelector('.pod-throughput-chart'), [{ label:'Items resolved', color:'#10b981', data:throughput }], { width:500, height:120 });
}

// ─── Main render ──────────────────────────────────────────────────────────────

async function renderAll(data) {
  if (!data?.pods) return;
  const pods = Object.values(data.pods);
  if (!pods.length) { showBanner('No pods configured. Click ⚙ Settings to add pods.', 'err'); return; }

  buildTabs(pods);
  await buildOverviewPanel(data);
  pods.forEach(pod => buildPodPanel(pod));

  // Restore previously active tab
  switchTab(_activeTab in data.pods || _activeTab === 'overview' ? _activeTab : 'overview');

  $('last-updated').textContent = fmtDate(data.fetchedAt);
  const podErrors = pods.filter(p => p.error);
  if (podErrors.length) showBanner(`⚠ ${podErrors.map(p=>p.name).join(', ')} failed to refresh`, 'err');
  else hideBanner();
}

// ─── Refresh + init ───────────────────────────────────────────────────────────

async function triggerRefresh() {
  const btn = $('refresh-btn');
  btn.textContent = '↻'; btn.classList.add('spinning'); btn.disabled = true;
  showBanner('Refreshing data from Azure DevOps…', 'info');
  try {
    await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'REFRESH' }, resp => {
        if (resp?.ok) resolve(); else reject(new Error(resp?.error || 'Refresh failed'));
      });
    });
    renderAll(await getCachedData());
    hideBanner();
  } catch (err) {
    showBanner(`❌ Refresh failed: ${err.message}`, 'err');
  } finally {
    btn.textContent = '↻ Refresh'; btn.classList.remove('spinning'); btn.disabled = false;
  }
}

chrome.runtime.onMessage.addListener(msg => {
  if (msg.type === 'DATA_UPDATED') renderAll(msg.data);
});

(async () => {
  // Load persisted filter state before first render so panels restore correctly
  const stored = await new Promise(r => chrome.storage.local.get('boardFilters', r));
  _boardFilters = stored.boardFilters || {};

  const settings = await getSettings();
  $('refresh-interval').textContent = settings.refreshInterval || 15;

  if (!settings.pat || !settings.pods?.length) {
    showBanner('⚠ No pods configured. Click ⚙ Settings to get started.', 'err');
    return;
  }

  const data = await getCachedData();
  if (data?.pods) renderAll(data);
  else { showBanner('No cached data — fetching from Azure DevOps…', 'info'); triggerRefresh(); }
})();
