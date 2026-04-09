// board.js — Multi-pod tabbed kanban board

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('refresh-btn').addEventListener('click', triggerRefresh);
  document.getElementById('settings-btn').addEventListener('click', () => chrome.runtime.openOptionsPage());
  document.getElementById('team-btn').addEventListener('click', () => chrome.tabs.update({ url: 'team.html' }));

  // Theme toggle
  const themeBtn = document.getElementById('theme-btn')
  initTheme().then(t => { themeBtn.textContent = t === 'dark' ? '☀' : '☾' })
  themeBtn.addEventListener('click', () => toggleTheme().then(t => { themeBtn.textContent = t === 'dark' ? '☀' : '☾' }))
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

function buildTabs(pods, showExecSummary) {
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

  // Executive Summary tab (optional)
  if (showExecSummary) {
    const esBtn = document.createElement('button');
    esBtn.className = 'tab-btn';
    esBtn.dataset.tab = 'exec-summary';
    esBtn.textContent = '📋 Executive Summary';
    esBtn.addEventListener('click', () => switchTab('exec-summary'));
    bar.appendChild(esBtn);
  }

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

/**
 * Build or rebuild the Overview tab. Aggregates all pod items, computes KPI metrics
 * (triage, WIP, aged, arrival rate, throughput), then conditionally renders each
 * optional chart based on settings.overviewCharts toggle flags.
 * @param {{ fetchedAt: string, pods: Object }} cachedData - Full cached pod data
 * @param {Array} sortedPods - Pods pre-sorted by settings order
 */
async function buildOverviewPanel(cachedData, sortedPods) {
  const container = $('panels-container');
  let panel = container.querySelector('[data-tab="overview"]');
  if (!panel) {
    panel = document.createElement('div');
    panel.className = 'tab-panel active';
    panel.dataset.tab = 'overview';
    container.appendChild(panel);
  }

  const pods = sortedPods;
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
            <div class="kpi"><div class="kv kv-arrival">${stats.last7}</div><div class="kl">this wk</div></div>
            <div class="kpi"><div class="kv kv-secondary">${stats.last30}</div><div class="kl">30d</div></div>
            <div class="kpi"><div class="kv kv-secondary">${stats.avgPerWeek}</div><div class="kl">avg/wk</div></div>
            <div class="kpi kpi-center"><span class="trend-badge ${trendClass}">${trendText}</span></div>
          </div>
          <div id="ov-arrival-chart"></div>
        </div>
        <div class="metric-chart">
          <h3 class="chart-title">Throughput (closed/week) <span class="chart-info">?<span class="chart-tip">Items closed per week (excludes Spikes). Compare against arrival rate — throughput should match or exceed arrivals to keep WIP stable.</span></span></h3>
          <div class="metric-kpis" id="ov-tp-kpis"></div>
          <div id="ov-throughput-chart"></div>
        </div>
      </div>
      <div id="ov-burndown-row" class="burndown-hidden"></div>
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
        <div class="pod-stat"><div class="ps-label">Triage</div><div class="ps-val kv-triage">${pTriage}</div></div>
        <div class="pod-stat"><div class="ps-label">WIP</div><div class="ps-val kv-wip">${pWip}</div></div>
        <div class="pod-stat"><div class="ps-label">Ready</div><div class="ps-val kv-throughput">${pRelease}</div></div>
        <div class="pod-stat"><div class="ps-label">Aged >90d</div><div class="ps-val kv-aged">${pAged}</div></div>
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
  ], { width: 500, height: 140, avgLine: { value: +stats.avgPerWeek, label: 'avg', color: '#60a5fa' } });

  const tpLast7  = throughput[throughput.length-1]?.count || 0;
  const tpPrev7  = throughput[throughput.length-2]?.count || 0;
  const tpLast30 = throughput.slice(-4).reduce((s,w) => s+w.count, 0);
  const tpAvg    = throughput.length ? +(throughput.reduce((s,w) => s+w.count, 0) / throughput.length).toFixed(1) : 0;
  const tpDiff   = tpLast7 - tpPrev7;
  panel.querySelector('#ov-tp-kpis').innerHTML = `
    <div class="kpi"><div class="kv kv-throughput">${tpLast7}</div><div class="kl">this week</div></div>
    <div class="kpi"><div class="kv kv-secondary">${tpLast30}</div><div class="kl">last 30d</div></div>
    <div class="kpi"><div class="kv kv-secondary">${tpAvg}</div><div class="kl">avg/wk</div></div>
    <div class="kpi kpi-center"><span class="trend-badge ${tpDiff>0?'trend-up-good':tpDiff<0?'trend-up-bad':'trend-neutral'}">${tpDiff>0?`↑${tpDiff}`:tpDiff<0?`↓${Math.abs(tpDiff)}`:'→'} vs prev</span></div>
  `;
  renderBarChart(panel.querySelector('#ov-throughput-chart'), [
    { label: 'Closed', color: '#10b981', data: throughput.map(w => ({ label: w.label, count: w.closed || 0 })) },
    { label: 'Resolved', color: '#60a5fa', data: throughput.map(w => ({ label: w.label, count: w.resolved || 0 })) }
  ], { width: 500, height: 140, stacked: true, avgLine: { value: +tpAvg, label: 'avg', color: '#10b981' } });

  // Per-pod flow charts — one arrival + throughput chart per pod
  const perPodSection = document.createElement('div');
  perPodSection.className = 'per-pod-section'
  perPodSection.innerHTML = '<h2 class="per-pod-heading">📊 Flow by Pod</h2><div id="per-pod-charts"></div>';
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
    block.className = 'pod-flow-block'
    block.style.borderLeftColor = color
    block.innerHTML = `
      <div class="pod-block-header">
        <div class="pod-block-name">${escHtml(pod.name)}</div>
        <span class="pod-toggle collapsed">▼</span>
      </div>
      <div class="pod-block-body collapsed">
        <div class="pod-charts-grid">
          <div>
            <div class="chart-subtitle">Arrival Rate</div>
            <div class="kpi-row">
              <div class="kpi"><div class="kv kv-arrival">${pStats.last7}</div><div class="kl">this wk</div></div>
              <div class="kpi"><div class="kv kv-secondary">${pStats.last30}</div><div class="kl">30d</div></div>
              <div class="kpi"><div class="kv kv-secondary">${pStats.avgPerWeek}</div><div class="kl">avg/wk</div></div>
            </div>
            <div class="pod-arr-chart-${pod.id}"></div>
          </div>
          <div>
            <div class="chart-subtitle">Throughput</div>
            <div class="kpi-row">
              <div class="kpi"><div class="kv kv-throughput">${pTpLast7}</div><div class="kl">this wk</div></div>
              <div class="kpi"><div class="kv kv-secondary">${pTpLast30}</div><div class="kl">30d</div></div>
              <div class="kpi"><div class="kv kv-secondary">${pTpAvg}</div><div class="kl">avg/wk</div></div>
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
    ], { width: 420, height: 110, avgLine: { value: +pStats.avgPerWeek, label: 'avg', color } });
    renderBarChart(block.querySelector(`.pod-tp-chart-${pod.id}`), [
      { label: 'Closed', color: '#10b981', data: pThroughput.map(w => ({ label: w.label, count: w.closed || 0 })) },
      { label: 'Resolved', color: '#60a5fa', data: pThroughput.map(w => ({ label: w.label, count: w.resolved || 0 })) }
    ], { width: 420, height: 110, stacked: true, avgLine: { value: pTpAvg, label: 'avg', color: '#10b981' } });
  });

  // ── Optional charts ──
  const settings = await getSettings();
  const oc = settings.overviewCharts || {};

  const chartsGrid = panel.querySelector('#ov-charts-grid');

  function tip(title, explanation) {
    return `<div class="chart-title"><span>${escHtml(title)}</span><span class="chart-info">?<span class="chart-tip">${explanation}</span></span></div>`;
  }

  // ── Optional: Throughput per Person (aggregate + per-pod) ──
  if (oc.throughputByPerson) {
    const div = document.createElement('div')
    div.className = 'metric-chart'
    div.innerHTML = tip('Throughput per Person', 'Weekly items closed divided by the number of people who closed items that week. Shows average output per contributor. Excludes unassigned items — totals may differ from the throughput chart.') + '<div class="tp-person-chart"></div>'
    chartsGrid.appendChild(div)
    const tpPerPerson = calcWeeklyThroughputPerPerson(allItems, 8)
    renderThroughputPerPersonChart(div.querySelector('.tp-person-chart'), tpPerPerson, { width: 500, height: 150 })

    // Per-pod throughput per person
    const podBlocks = perPodContainer.querySelectorAll('[data-pod-id]')
    for (const block of podBlocks) {
      const podId = block.dataset.podId
      const pod = pods.find(p => p.id === podId)
      if (!pod) continue
      const podTpPerPerson = calcWeeklyThroughputPerPerson(pod.items || [], 8)
      if (podTpPerPerson.every(d => d.perPerson === 0)) continue
      const tpDiv = document.createElement('div')
      tpDiv.innerHTML = '<div class="chart-subtitle">Throughput per Person</div><div class="pod-tp-person"></div>'
      block.querySelector('.pod-charts-grid').appendChild(tpDiv)
      renderThroughputPerPersonChart(tpDiv.querySelector('.pod-tp-person'), podTpPerPerson, { width: 400, height: 140, color: pod.color })
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
      cbpDiv.innerHTML = '<div class="chart-subtitle">Items Closed by Person</div><div class="pod-closed-person"></div>';
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
      rbpDiv.innerHTML = '<div class="chart-subtitle">Items Resolved by Person</div><div class="pod-resolved-person"></div>';
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
        div.innerHTML = '<div class="chart-subtitle">Cycle: In Progress → Closed</div><div class="pod-ct-ip"></div>';
        podGrid.appendChild(div);
        const ipData = podCtData.filter(d => d.inProgressToClose != null).map(d => ({
          id: d.id, type: d.type, url: d.url, days: d.inProgressToClose, closedDate: d.closedDate
        }));
        renderScatterChart(div.querySelector('.pod-ct-ip'), ipData, { width: 400, height: 140 });
      }

      if (oc.cycleTimeArrival) {
        const div = document.createElement('div');
        div.innerHTML = '<div class="chart-subtitle">Cycle: Arrival → Closed</div><div class="pod-ct-arr"></div>';
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
      d.innerHTML = '<div class="chart-subtitle">WIP Trend</div><div class="pod-wip"></div>';
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
      d.innerHTML = '<div class="chart-subtitle">Age Distribution</div><div class="pod-age"></div>';
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
      div.querySelector('.flow-eff-metrics').innerHTML = '<div class="no-data-msg">Insufficient data</div>';
    }

    for (const block of perPodContainer.querySelectorAll('[data-pod-id]')) {
      const pod = pods.find(p => p.id === block.dataset.podId);
      if (!pod) continue;
      const podItemIds = new Set((pod.items || []).map(i => i.id));
      const podCtData = ctForEff.filter(d => podItemIds.has(d.id));
      const podEff = calcFlowEfficiency(podCtData);
      if (!podEff) continue;
      const d = document.createElement('div');
      d.innerHTML = '<div class="chart-subtitle">Flow Efficiency</div><div class="pod-eff"></div>';
      block.querySelector('.pod-charts-grid').appendChild(d);
      renderMetricCard(d.querySelector('.pod-eff'), [
        { label: 'avg', value: podEff.pct + '%', color: podEff.pct >= 40 ? '#22c55e' : podEff.pct >= 20 ? '#f59e0b' : '#ef4444' },
        { label: 'median', value: podEff.median + '%', color: '#94a3b8' }
      ]);
    }
  }

  // ── Optional: Stale Items ──
  if (oc.staleItems) {
    const staleDays = settings.staleDays || 2
    const stale = calcStaleItems(allItems, staleDays);
    const div = document.createElement('div');
    div.className = 'metric-chart';
    const blockedNote = stale.blocked > 0 ? ` · ${stale.blocked} blocked` : ''
    div.innerHTML = tip(`Stale & Blocked Items — ${stale.total} total${blockedNote}`, `Active items with no field changes in ${staleDays}+ days, plus any blocked items (detected via column, swim lane, or Blocked tag) regardless of age. These need attention — check with the assignee.`) + '<div class="stale-chart"></div>';
    chartsGrid.appendChild(div);
    renderStaleItemsTable(div.querySelector('.stale-chart'), stale);

    for (const block of perPodContainer.querySelectorAll('[data-pod-id]')) {
      const pod = pods.find(p => p.id === block.dataset.podId);
      if (!pod) continue;
      const podStale = calcStaleItems(pod.items || [], staleDays);
      const podBlockedNote = podStale.blocked > 0 ? ` · ${podStale.blocked} blocked` : ''
      const d = document.createElement('div');
      d.innerHTML = `<div class="chart-subtitle">Stale & Blocked — ${podStale.total}${podBlockedNote}</div><div class="pod-stale"></div>`;
      block.querySelector('.pod-charts-grid').appendChild(d);
      renderStaleItemsTable(d.querySelector('.pod-stale'), podStale);
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
      d.innerHTML = '<div class="chart-subtitle">Bug Ratio Trend (%)</div><div class="pod-bug"></div>';
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
        return `<div class="pred-weekly-row"><span class="pred-weekly-label">${w.label}</span><span class="pred-weekly-val" style="color:${col}">${w.count}</span></div>`;
      }).join('');
      div.querySelector('.tp-pred-weekly').innerHTML = `<div class="pred-weekly-container">${weeklyHtml}</div>`;
    } else {
      div.querySelector('.tp-pred-metrics').innerHTML = '<div class="no-data-msg">Insufficient data</div>';
    }

    for (const block of perPodContainer.querySelectorAll('[data-pod-id]')) {
      const pod = pods.find(p => p.id === block.dataset.podId);
      if (!pod) continue;
      const podPred = calcThroughputPredictability(pod.items || [], 8);
      if (!podPred) continue;
      const d = document.createElement('div');
      d.innerHTML = '<div class="chart-subtitle">Predictability</div><div class="pod-pred"></div><div class="pod-pred-weekly"></div>';
      block.querySelector('.pod-charts-grid').appendChild(d);
      renderMetricCard(d.querySelector('.pod-pred'), [
        { label: 'rating', value: podPred.rating, color: podPred.ratingColor },
        { label: 'avg/wk', value: podPred.mean, color: '#94a3b8' },
        { label: 'CV', value: podPred.cv, color: '#94a3b8' }
      ]);
      const podWeeklyHtml = podPred.weekly.map(w => {
        const diff = w.count - podPred.mean;
        const col = Math.abs(diff) > podPred.stdDev ? '#ef4444' : '#94a3b8';
        return `<div class="pred-weekly-row"><span class="pred-weekly-label">${w.label}</span><span class="pred-weekly-val" style="color:${col}">${w.count}</span></div>`;
      }).join('');
      d.querySelector('.pod-pred-weekly').innerHTML = `<div class="pred-weekly-container-sm">${podWeeklyHtml}</div>`;
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
      d.innerHTML = '<div class="chart-subtitle">Priority Age Distribution</div><div class="pod-prio-age"></div>';
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
      d.innerHTML = '<div class="chart-subtitle">Cumulative Flow Diagram</div><div class="pod-cfd"></div>';
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
          <h3 class="burndown-heading">Burndown by Target PI</h3>
          <div class="burndown-selector-wrap">
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
          <div class="chart-subtitle">Burndown by Target PI</div>
          <div class="burndown-selector-wrap-sm">
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

// ─── Prediction rendering for Executive Summary ──────────────────────────────

function renderExecPredictions(pred, heading, coverageNote, podSpread) {
  if (!pred.ready) {
    const bar = pred.weeksNeeded > 0 ? Math.round((pred.weeksCollected / pred.weeksNeeded) * 100) : 0
    return `
      <div class="exec-predictions pending">
        ${heading ? `<div class="exec-pred-heading">${escHtml(heading)} — Predictions</div>` : ''}
        <div class="exec-pred-pending">
          <div class="exec-pred-pending-text">Predictions available in ${pred.weeksUntilReady} more week${pred.weeksUntilReady === 1 ? '' : 's'}</div>
          <div class="exec-pred-bar-track"><div class="exec-pred-bar-fill" style="width:${bar}%"></div></div>
          <div class="exec-pred-pending-sub">${pred.weeksCollected} of ${pred.weeksNeeded} weeks collected</div>
        </div>
      </div>
    `
  }

  const tp = pred.throughput
  const nf = pred.netFlow
  const bd = pred.backlogDrain
  const fc = pred.forecast
  const nfColor = nf.direction === 'growing' ? 'var(--red)' : nf.direction === 'shrinking' ? 'var(--green)' : 'var(--muted)'
  const nfIcon = nf.direction === 'growing' ? '↑' : nf.direction === 'shrinking' ? '↓' : '→'
  const nfLabel = nf.direction === 'growing' ? 'WIP growing' : nf.direction === 'shrinking' ? 'WIP shrinking' : 'WIP stable'

  function fmtWks(w) {
    if (w === null) return 'Not draining'
    if (w < 1) return '< 1 wk'
    return w.toFixed(1) + ' wks'
  }

  const drainColor = (w) => w === null ? '#ef4444' : '#94a3b8'

  // Pod spread footnote for aggregate view
  const spreadNote = podSpread
    ? `<div class="exec-pred-footnote">Pod range: ${podSpread.min}–${podSpread.max}/wk${podSpread.max > podSpread.min * 3 ? ' <span style="color:#f59e0b">· wide spread</span>' : ''}</div>`
    : ''

  return `
    <div class="exec-predictions">
      ${heading ? `<div class="exec-pred-heading">${escHtml(heading)} — Predictions</div>` : '<div class="exec-pred-heading">Predictions</div>'}
      <div class="exec-pred-grid">
        <div class="exec-pred-card">
          <div class="exec-pred-label">Throughput Forecast /wk</div>
          <div class="exec-pred-row">
            <div class="exec-pred-val"><div class="exec-pred-num" style="color:#ef4444">${tp.pessimistic}</div><div class="exec-pred-sub">pessimistic</div></div>
            <div class="exec-pred-val"><div class="exec-pred-num" style="color:#10b981">${tp.likely}</div><div class="exec-pred-sub">likely</div></div>
            <div class="exec-pred-val"><div class="exec-pred-num" style="color:#3b82f6">${tp.optimistic}</div><div class="exec-pred-sub">optimistic</div></div>
          </div>
          <div class="exec-pred-footnote">25th / 50th / 75th percentile</div>
          ${spreadNote}
        </div>
        <div class="exec-pred-card">
          <div class="exec-pred-label">Backlog Drain</div>
          <div class="exec-pred-backlog-count">${bd.backlogSize} active items</div>
          ${bd.draining ? `
            <div class="exec-pred-row">
              <div class="exec-pred-val"><div class="exec-pred-num" style="color:#ef4444">${fmtWks(bd.pessimisticWeeks)}</div><div class="exec-pred-sub">pessimistic</div></div>
              <div class="exec-pred-val"><div class="exec-pred-num" style="color:#10b981">${fmtWks(bd.likelyWeeks)}</div><div class="exec-pred-sub">likely</div></div>
              <div class="exec-pred-val"><div class="exec-pred-num" style="color:#3b82f6">${fmtWks(bd.optimisticWeeks)}</div><div class="exec-pred-sub">optimistic</div></div>
            </div>
            <div class="exec-pred-footnote">accounting for continued arrivals</div>
          ` : `
            <div class="exec-pred-not-draining">Not draining</div>
            <div class="exec-pred-footnote">arrivals meet or exceed throughput — backlog will not clear at current rates</div>
          `}
        </div>
        <div class="exec-pred-card">
          <div class="exec-pred-label">Net Flow</div>
          <div class="exec-pred-net">
            <div class="exec-pred-net-val" style="color:${nfColor}">${nfIcon} ${Math.abs(nf.perWeek)}</div>
            <div class="exec-pred-net-label" style="color:${nfColor}">${nfLabel}</div>
            <div class="exec-pred-sub">items/wk (arrivals − throughput)</div>
            ${!bd.draining ? '<div class="exec-pred-net-context">Backlog clears only if throughput increases</div>' : ''}
          </div>
        </div>
      </div>
      <div class="exec-pred-forecast">
        <div class="exec-pred-fc-block">
          <div class="exec-pred-fc-label">Next 2 weeks</div>
          <div class="exec-pred-fc-range"><span style="color:#ef4444">${fc.twoWeeks.pessimistic}</span> – <span style="color:#3b82f6">${fc.twoWeeks.optimistic}</span> items</div>
          <div class="exec-pred-fc-likely">likely ${fc.twoWeeks.likely}</div>
        </div>
        <div class="exec-pred-fc-block">
          <div class="exec-pred-fc-label">Next 4 weeks</div>
          <div class="exec-pred-fc-range"><span style="color:#ef4444">${fc.fourWeeks.pessimistic}</span> – <span style="color:#3b82f6">${fc.fourWeeks.optimistic}</span> items</div>
          <div class="exec-pred-fc-likely">likely ${fc.fourWeeks.likely}</div>
        </div>
      </div>
      ${coverageNote ? `<div class="exec-pred-coverage">${escHtml(coverageNote)}</div>` : ''}
      <div class="exec-pred-disclaimer">Projections based on ${pred.weeksCollected}-week rolling trends — not a commitment</div>
    </div>
  `
}

// ─── Executive Summary panel ─────────────────────────────────────────────────

async function buildExecutiveSummaryPanel(cachedData, settings, sortedPods) {
  const container = $('panels-container')
  let panel = container.querySelector('[data-tab="exec-summary"]')
  if (!panel) {
    panel = document.createElement('div')
    panel.className = 'tab-panel'
    panel.dataset.tab = 'exec-summary'
    container.appendChild(panel)
  }

  const pods = sortedPods || Object.values(cachedData.pods)
  const allItems = getAllItems(cachedData)
  const staleDays = settings.staleDays || 2
  const podSettings = settings.pods || []
  const notes = await getExecSummaryNotes()
  const holidays = await getTeamHolidays()

  // Week label — show last week's date range (not current incomplete week)
  const now = new Date()
  const thisMonday = new Date(now)
  thisMonday.setDate(now.getDate() - ((now.getDay() + 6) % 7))
  thisMonday.setHours(0, 0, 0, 0)
  const lastMonday = new Date(thisMonday)
  lastMonday.setDate(thisMonday.getDate() - 7)
  const lastSunday = new Date(lastMonday)
  lastSunday.setDate(lastMonday.getDate() + 6)
  const fmtOpts = { day: 'numeric', month: 'short' }
  const weekLabel = `${lastMonday.toLocaleDateString('en-GB', fmtOpts)} – ${lastSunday.toLocaleDateString('en-GB', { ...fmtOpts, year: 'numeric' })}`

  // ── Aggregate stats (last week vs week before, with averages over all data) ──
  const totalArrivalWeekly = calcWeeklyArrival(allItems, 8)
  const totalArrLast = totalArrivalWeekly[totalArrivalWeekly.length - 2]?.count || 0
  const totalArrPrev = totalArrivalWeekly[totalArrivalWeekly.length - 3]?.count || 0
  const totalArrThisWeek = totalArrivalWeekly[totalArrivalWeekly.length - 1]?.count || 0
  const totalArrAvg = totalArrivalWeekly.length > 1
    ? +(totalArrivalWeekly.slice(0, -1).reduce((s, w) => s + w.count, 0) / (totalArrivalWeekly.length - 1)).toFixed(1) : 0

  const totalTp = calcWeeklyThroughput(allItems, 8)
  const totalTpLast = totalTp[totalTp.length - 2]?.count || 0
  const totalTpPrev = totalTp[totalTp.length - 3]?.count || 0
  const totalTpThisWeek = totalTp[totalTp.length - 1]?.count || 0
  const totalTpAvg = totalTp.length > 1
    ? +(totalTp.slice(0, -1).reduce((s, w) => s + w.count, 0) / (totalTp.length - 1)).toFixed(1) : 0

  const totalTpPP = calcWeeklyThroughputPerPerson(allItems, 8)
  const totalTpPPLast = totalTpPP[totalTpPP.length - 2]?.perPerson || 0
  const totalTpPPPrev = totalTpPP[totalTpPP.length - 3]?.perPerson || 0
  const totalTpPPAvg = totalTpPP.length > 1
    ? +(totalTpPP.slice(0, -1).reduce((s, w) => s + w.perPerson, 0) / (totalTpPP.length - 1)).toFixed(1) : 0
  const totalActive = allItems.filter(i => !['Closed', 'Removed', 'Resolved'].includes(i.state))
  const totalWipItems = totalActive.filter(i => {
    const col = (i.boardColumn || i.state || '').toLowerCase()
    return col.includes('progress') || col.includes('active') || col.includes('review')
  })
  const totalWip = totalWipItems.length
  const totalWipBugs = totalWipItems.filter(i => i.type === 'Bug').length
  const totalWipStories = totalWipItems.filter(i => i.type === 'User Story').length
  const totalStale = calcStaleItems(allItems, staleDays)

  // Type splits for arrival & throughput (last week bucket)
  const buckets = weekBuckets(8)
  const lastWeekBucket = buckets[buckets.length - 2]
  const arrSplit = lastWeekBucket ? (() => {
    let bugs = 0, stories = 0
    for (const i of allItems) {
      const d = new Date(i.arrivedAt || i.created)
      if (d >= lastWeekBucket.start && d <= lastWeekBucket.end) {
        if (i.type === 'Bug') bugs++
        else if (i.type === 'User Story') stories++
      }
    }
    return { bugs, stories }
  })() : { bugs: 0, stories: 0 }
  const tpDone = allItems.filter(i => i.closed && i.type !== 'Spike')
  const tpSplit = lastWeekBucket ? (() => {
    let bugs = 0, stories = 0
    for (const i of tpDone) {
      const d = new Date(i.closed)
      if (d >= lastWeekBucket.start && d <= lastWeekBucket.end) {
        if (i.type === 'Bug') bugs++
        else if (i.type === 'User Story') stories++
      }
    }
    return { bugs, stories }
  })() : { bugs: 0, stories: 0 }

  // This-week type splits
  const thisWeekBucket = buckets[buckets.length - 1]
  const arrSplitThisWk = thisWeekBucket ? (() => {
    let bugs = 0, stories = 0
    for (const i of allItems) {
      const d = new Date(i.arrivedAt || i.created)
      if (d >= thisWeekBucket.start && d <= thisWeekBucket.end) {
        if (i.type === 'Bug') bugs++
        else if (i.type === 'User Story') stories++
      }
    }
    return { bugs, stories }
  })() : { bugs: 0, stories: 0 }
  const tpSplitThisWk = thisWeekBucket ? (() => {
    let bugs = 0, stories = 0
    for (const i of tpDone) {
      const d = new Date(i.closed)
      if (d >= thisWeekBucket.start && d <= thisWeekBucket.end) {
        if (i.type === 'Bug') bugs++
        else if (i.type === 'User Story') stories++
      }
    }
    return { bugs, stories }
  })() : { bugs: 0, stories: 0 }

  // ── Auto-insights (per-pod + aggregate) ──
  const { byPod: podInsightsMap, aggregate: aggInsights } = calcExecInsights(cachedData, staleDays, holidays)

  // ── Build HTML ──
  let html = ''

  // Header
  html += `
    <div class="exec-header">
      <div class="exec-title">Executive Summary</div>
      <div class="exec-date">${escHtml(weekLabel)}</div>
    </div>
  `

  // Aggregate KPIs (last week vs week before)
  function deltaHtml(curr, prev, invertColor) {
    const diff = +(curr - prev).toFixed(1)
    if (diff === 0) return '<div class="exec-agg-delta exec-delta-flat">→ same</div>'
    const arrow = diff > 0 ? '↑' : '↓'
    const absDiff = Math.abs(diff) % 1 === 0 ? Math.abs(diff) : Math.abs(diff).toFixed(1)
    const pct = prev > 0 ? ` (${Math.round(Math.abs(diff / prev) * 100)}%)` : ''
    const cls = invertColor
      ? (diff > 0 ? 'exec-delta-down' : 'exec-delta-up')
      : (diff > 0 ? 'exec-delta-up' : 'exec-delta-down')
    return `<div class="exec-agg-delta ${cls}">${arrow}${absDiff}${pct} vs prev wk</div>`
  }

  html += `
    <div class="exec-aggregate">
      <div class="exec-aggregate-title">All Pods — Last Week vs Week Before</div>
      <div class="exec-agg-grid">
        <div class="exec-agg-card">
          <div class="exec-agg-label">Arrival</div>
          <div class="exec-agg-val kv-arrival">${totalArrLast}</div>
          <div class="exec-agg-split">${arrSplit.bugs} bug · ${arrSplit.stories} story</div>
          ${deltaHtml(totalArrLast, totalArrPrev, false)}
          <div class="exec-agg-live">Avg: ${totalArrAvg}/wk · This week: ${totalArrThisWeek} (${arrSplitThisWk.bugs}b ${arrSplitThisWk.stories}s)</div>
        </div>
        <div class="exec-agg-card">
          <div class="exec-agg-label">Throughput</div>
          <div class="exec-agg-val kv-throughput">${totalTpLast}</div>
          <div class="exec-agg-split">${tpSplit.bugs} bug · ${tpSplit.stories} story</div>
          ${deltaHtml(totalTpLast, totalTpPrev, true)}
          <div class="exec-agg-live">Avg: ${totalTpAvg}/wk · This week: ${totalTpThisWeek} (${tpSplitThisWk.bugs}b ${tpSplitThisWk.stories}s)</div>
        </div>
        <div class="exec-agg-card">
          <div class="exec-agg-label">Throughput / Person</div>
          <div class="exec-agg-val kv-throughput">${totalTpPPLast}</div>
          ${deltaHtml(totalTpPPLast, totalTpPPPrev, true)}
          <div class="exec-agg-live">Avg: ${totalTpPPAvg}/wk</div>
        </div>
        <div class="exec-agg-card">
          <div class="exec-agg-label">Active WIP</div>
          <div class="exec-agg-val kv-wip">${totalWip}</div>
          <div class="exec-agg-split">${totalWipBugs} bug · ${totalWipStories} story</div>
          <div class="exec-agg-live">${totalActive.length - totalWip} in backlog (${totalActive.filter(i => i.type === 'Bug').length - totalWipBugs}b ${totalActive.filter(i => i.type === 'User Story').length - totalWipStories}s)</div>
        </div>
        <div class="exec-agg-card">
          <div class="exec-agg-label">Stale / Blocked</div>
          <div class="exec-agg-val kv-aged">${totalStale.total}</div>
          <div class="exec-agg-links">${totalStale.items.map(i =>
            `<a href="${i.url}" target="_blank" class="exec-stale-link ${i.type === 'Bug' ? 'type-bug' : 'type-story'}" title="${escHtml(i.title)}">#${i.id}</a>`
          ).join(' ')}</div>
        </div>
      </div>
  `

  // Aggregate predictions — inside the All Pods box, before closing exec-aggregate
  // Check which pods have enough data for predictions
  const podPredStatus = pods.map(pod => ({
    name: pod.name,
    ready: calcPredictions(pod.items || [], 8).ready
  }))
  const podsReady = podPredStatus.filter(p => p.ready)
  const podsNotReady = podPredStatus.filter(p => !p.ready)

  const aggPred = calcPredictions(allItems, 8)
  let podCoverageNote = ''
  if (podsNotReady.length > 0 && podsReady.length > 0) {
    podCoverageNote = `Based on ${podsReady.length} of ${pods.length} pods (${podsNotReady.length} pod${podsNotReady.length === 1 ? '' : 's'} need more history)`
  } else if (podsNotReady.length > 0 && podsReady.length === 0) {
    podCoverageNote = `No pods have sufficient history yet`
  }

  // Per-pod throughput spread for aggregate context (#2)
  const podTpMedians = podsReady.map(ps => {
    const pod = pods.find(p => p.name === ps.name)
    if (!pod) return null
    const pred = calcPredictions(pod.items || [], 8)
    return pred.ready ? pred.throughput.likely : null
  }).filter(v => v !== null)
  const podSpread = podTpMedians.length >= 2
    ? { min: Math.min(...podTpMedians), max: Math.max(...podTpMedians) }
    : null

  html += renderExecPredictions(aggPred, null, podCoverageNote, podSpread)
  html += '</div>'

  // Aggregate insights (if any)
  if (aggInsights.length) {
    html += '<div class="exec-insights">'
    for (const insight of aggInsights) {
      const icon = insight.type === 'positive' ? '✅' : insight.type === 'warning' ? '⚠️' : insight.type === 'info' ? 'ℹ️' : '🔴'
      html += `<div class="exec-insight ${insight.type}"><span class="exec-insight-icon">${icon}</span>${escHtml(insight.text)}</div>`
    }
    html += '</div>'
  }

  // Per-pod cards
  html += '<div class="exec-pods">'

  for (const pod of pods) {
    const pItems = pod.items || []
    const pActive = pItems.filter(i => !['Closed', 'Removed', 'Resolved'].includes(i.state))

    // Shifted windows: last week vs week before (8 weeks for averages)
    const pArrWeekly = calcWeeklyArrival(pItems, 8)
    const pArrLast = pArrWeekly[pArrWeekly.length - 2]?.count || 0
    const pArrPrev = pArrWeekly[pArrWeekly.length - 3]?.count || 0
    const pArrAvg = pArrWeekly.length > 1
      ? +(pArrWeekly.slice(0, -1).reduce((s, w) => s + w.count, 0) / (pArrWeekly.length - 1)).toFixed(1) : 0

    const pTp = calcWeeklyThroughput(pItems, 8)
    const pTpLast = pTp[pTp.length - 2]?.count || 0
    const pTpPrev = pTp[pTp.length - 3]?.count || 0
    const pTpAvg = pTp.length > 1
      ? +(pTp.slice(0, -1).reduce((s, w) => s + w.count, 0) / (pTp.length - 1)).toFixed(1) : 0

    const pTpPP = calcWeeklyThroughputPerPerson(pItems, 8)
    const pTpPPLast = pTpPP[pTpPP.length - 2]?.perPerson || 0
    const pTpPPPrev = pTpPP[pTpPP.length - 3]?.perPerson || 0
    const pTpPPAvg = pTpPP.length > 1
      ? +(pTpPP.slice(0, -1).reduce((s, w) => s + w.perPerson, 0) / (pTpPP.length - 1)).toFixed(1) : 0

    const pCols = columnCounts(pActive)
    const pTriage = colCount(pCols, 'Triage', 'Intake')
    const pTriagePrev = (() => {
      const prevTriage = pTriage + (pArrPrev - pArrLast)
      return Math.max(0, prevTriage)
    })()
    const pAged = pActive.filter(x => ageDays(x) >= 7).length

    // Work item breakdown
    const pBugs = pActive.filter(x => x.type === 'Bug').length
    const pStories = pActive.filter(x => x.type === 'User Story').length
    const pOther = pActive.length - pBugs - pStories
    const pP1 = pActive.filter(x => x.priority === 1).length
    const pP2 = pActive.filter(x => x.priority === 2).length
    const pP3 = pActive.filter(x => x.priority === 3).length
    const pP4 = pActive.filter(x => x.priority >= 4).length
    const health = calcPodHealthStatus(pod, staleDays)
    const color = podColor(pod.id)
    const podSetting = podSettings.find(p => p.id === pod.id) || {}
    const desc = podSetting.description || ''
    const podNote = notes[pod.id] || ''
    const pred = calcThroughputPredictability(pItems, 8)
    const pInsights = podInsightsMap[pod.id] || []

    // Week-over-week comparison rows (last week vs week before + avg)
    const wowRows = [
      { metric: 'Arrival', curr: pArrLast, prev: pArrPrev, avg: pArrAvg, upIsBad: true },
      { metric: 'Throughput', curr: pTpLast, prev: pTpPrev, avg: pTpAvg, upIsBad: false },
      { metric: 'TP / Person', curr: pTpPPLast, prev: pTpPPPrev, avg: pTpPPAvg, upIsBad: false },
      { metric: 'Triage', curr: pTriage, prev: pTriagePrev, avg: null, upIsBad: true },
      { metric: 'Aged >7d', curr: pAged, prev: null, avg: null, upIsBad: true },
    ]

    const isPaused = !!holidays[pod.id]?._podPaused?.paused
    const pauseResume = holidays[pod.id]?._podPaused?.resumeDate || ''
    const pauseLabel = isPaused
      ? ` <span class="exec-pod-paused">Paused${pauseResume ? ` · resumes ${new Date(pauseResume).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : ''}</span>`
      : ''

    html += `
      <div class="exec-pod-card${isPaused ? ' paused' : ''}" style="border-left-color:${color}">
        <div class="exec-pod-header" data-exec-pod="${escHtml(pod.id)}">
          <div class="exec-health ${health.status}"></div>
          <div class="exec-pod-name">${escHtml(pod.name)}${pauseLabel}</div>
          <span class="exec-pod-toggle${isPaused ? ' collapsed' : ''}">▼</span>
        </div>
        ${desc ? `<div class="exec-pod-desc">${escHtml(desc)}</div>` : ''}
        <div class="exec-pod-body${isPaused ? ' collapsed' : ''}" data-exec-body="${escHtml(pod.id)}">
    `

    // Per-pod insights (health traffic light stays as the dot, text alerts come from insights only)
    if (pInsights.length) {
      html += '<div class="exec-risks">'
      for (const insight of pInsights) {
        const icon = insight.type === 'positive' ? '✅' : insight.type === 'warning' ? '⚠️' : insight.type === 'info' ? 'ℹ️' : '🔴'
        html += `<div class="exec-risk-item ${insight.type}"><span class="exec-risk-icon">${icon}</span>${escHtml(insight.text)}</div>`
      }
      html += '</div>'
    }

    // WoW table
    html += `
          <table class="exec-wow-table">
            <thead><tr><th>Metric</th><th>Last Week</th><th>Week Before</th><th>Change</th><th>Avg</th></tr></thead>
            <tbody>
    `
    for (const row of wowRows) {
      const diff = row.prev != null ? +(row.curr - row.prev).toFixed(1) : null
      let deltaCls = 'exec-wow-delta-neutral'
      let deltaText = '—'
      if (diff != null) {
        if (diff === 0) { deltaText = '→ same' }
        else {
          const arrow = diff > 0 ? '↑' : '↓'
          const absDiff = Math.abs(diff) % 1 === 0 ? Math.abs(diff) : Math.abs(diff).toFixed(1)
          const pct = row.prev > 0 ? ` (${Math.round(Math.abs(diff / row.prev) * 100)}%)` : ''
          deltaText = `${arrow}${absDiff}${pct}`
          if (row.upIsBad) deltaCls = diff > 0 ? 'exec-wow-delta-bad' : 'exec-wow-delta-good'
          else deltaCls = diff > 0 ? 'exec-wow-delta-good' : 'exec-wow-delta-bad'
        }
      }
      html += `<tr>
        <td class="exec-wow-metric">${escHtml(row.metric)}</td>
        <td>${row.curr}</td>
        <td>${row.prev != null ? row.prev : '—'}</td>
        <td class="${deltaCls}">${deltaText}</td>
        <td class="exec-wow-avg">${row.avg != null ? row.avg : '—'}</td>
      </tr>`
    }
    html += '</tbody></table>'

    // Work item breakdown
    html += `
          <div class="exec-breakdown">
            <div class="exec-breakdown-group">
              <span class="exec-breakdown-label">Type</span>
              <span class="badge badge-bug">Bug ${pBugs}</span>
              <span class="badge badge-story">Story ${pStories}</span>
              ${pOther > 0 ? `<span class="badge badge-other">Other ${pOther}</span>` : ''}
            </div>
            <div class="exec-breakdown-group">
              <span class="exec-breakdown-label">Priority</span>
              ${pP1 > 0 ? `<span class="badge badge-p1">P1 ${pP1}</span>` : ''}
              ${pP2 > 0 ? `<span class="badge badge-p2">P2 ${pP2}</span>` : ''}
              ${pP3 > 0 ? `<span class="badge badge-p3">P3 ${pP3}</span>` : ''}
              ${pP4 > 0 ? `<span class="badge badge-p4">P4 ${pP4}</span>` : ''}
              ${pP1 + pP2 + pP3 + pP4 === 0 ? '<span style="color:var(--muted);font-size:.75rem">None set</span>' : ''}
            </div>
          </div>
    `

    // Predictability badge
    if (pred) {
      const predRating = pred.rating.toLowerCase()
      html += `
        <div class="exec-predictability">
          <span class="exec-pred-badge" data-rating="${predRating}">
            Predictability: ${pred.rating} (CV ${pred.cv})
          </span>
          <span class="exec-pred-sub">avg ${pred.mean}/wk ± ${pred.stdDev}</span>
        </div>
      `
    }

    // Pod predictions
    const podPred = calcPredictions(pItems, 8)
    html += renderExecPredictions(podPred)

    // Notes
    html += `
          <div class="exec-notes-label">Meeting Notes</div>
          <textarea class="exec-notes" data-note-pod="${escHtml(pod.id)}" placeholder="Add talking points for ${escHtml(pod.name)}…">${escHtml(podNote)}</textarea>
        </div>
      </div>
    `
  }

  html += '</div>'
  panel.innerHTML = html

  // ── Wire interactions ──

  // Pod card expand/collapse
  panel.querySelectorAll('.exec-pod-header').forEach(header => {
    header.addEventListener('click', () => {
      const podId = header.dataset.execPod
      const body = panel.querySelector(`[data-exec-body="${podId}"]`)
      const toggle = header.querySelector('.exec-pod-toggle')
      body.classList.toggle('collapsed')
      toggle.classList.toggle('collapsed')
    })
  })

  // Auto-save notes on blur
  panel.querySelectorAll('.exec-notes').forEach(textarea => {
    textarea.addEventListener('blur', async () => {
      const podId = textarea.dataset.notePod
      const current = await getExecSummaryNotes()
      current[podId] = textarea.value
      await setExecSummaryNotes(current)
    })
  })
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
    : `<span class="text-faded">Unassigned</span>`;
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
      <div class="stat-card"><div class="label">Aged &gt;90d</div><div class="value kv-aged">${active.filter(i=>ageDays(i)>=90).length}</div></div>
      <div class="stat-card"><div class="label">Total</div><div class="value kv-total">${active.length}</div></div>
    </div>
    <div class="team-row">${teamCardsHtml}</div>
    <div class="metrics-section">
      <h2>📈 Flow Metrics — ${escHtml(pod.name)}</h2>
      <div class="metrics-grid">
        <div class="metric-chart">
          <h3>Arrival Rate</h3>
          <div class="metric-kpis">
            <div class="kpi"><div class="kv kv-arrival">${stats.last7}</div><div class="kl">this week</div></div>
            <div class="kpi"><div class="kv kv-secondary">${stats.last30}</div><div class="kl">last 30d</div></div>
            <div class="kpi"><div class="kv kv-secondary">${stats.avgPerWeek}</div><div class="kl">avg/wk</div></div>
            <div class="kpi kpi-center"><span class="trend-badge ${trendClass}">${trendText}</span></div>
          </div>
          <div class="pod-arrival-chart"></div>
        </div>
        <div class="metric-chart">
          <h3>Throughput</h3>
          <div class="metric-kpis">
            <div class="kpi"><div class="kv kv-throughput">${tpLast7}</div><div class="kl">this week</div></div>
            <div class="kpi"><div class="kv kv-secondary">${tpLast30}</div><div class="kl">last 30d</div></div>
            <div class="kpi"><div class="kv kv-secondary">${tpAvgPod}</div><div class="kl">avg/wk</div></div>
            <div class="kpi kpi-center"><span class="trend-badge ${tpDiff>0?'trend-up-good':tpDiff<0?'trend-up-bad':'trend-neutral'}">${tpDiff>0?`↑${tpDiff}`:tpDiff<0?`↓${Math.abs(tpDiff)}`:'→'} vs prev</span></div>
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
    ${pod.error ? `<div class="pod-error-banner">⚠ Last fetch failed: ${escHtml(pod.error)}</div>` : ''}
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
    chrome.storage.local.set({ [STORAGE_KEYS.boardFilters]: _boardFilters });
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
  renderBarChart(panel.querySelector('.pod-arrival-chart'), [{ label:'Items arrived', color:'#6366f1', data:arrival }], { width:500, height:120, avgLine: { value: +stats.avgPerWeek, label: 'avg', color: '#60a5fa' } });
  renderBarChart(panel.querySelector('.pod-throughput-chart'), [
    { label: 'Closed', color: '#10b981', data: throughput.map(w => ({ label: w.label, count: w.closed || 0 })) },
    { label: 'Resolved', color: '#60a5fa', data: throughput.map(w => ({ label: w.label, count: w.resolved || 0 })) }
  ], { width: 500, height: 120, stacked: true, avgLine: { value: +tpAvgPod, label: 'avg', color: '#10b981' } });
}

// ─── Main render ──────────────────────────────────────────────────────────────

async function renderAll(data) {
  if (!data?.pods) return;
  // Sort pods by the order defined in settings to keep tabs stable across refreshes
  const settings = await getSettings()
  const podOrder = (settings.pods || []).map(p => p.id)
  const pods = Object.values(data.pods).sort((a, b) => {
    const ai = podOrder.indexOf(a.id)
    const bi = podOrder.indexOf(b.id)
    return (ai === -1 ? Infinity : ai) - (bi === -1 ? Infinity : bi)
  })
  if (!pods.length) { showBanner('No pods configured. Click ⚙ Settings to add pods.', 'err'); return; }

  // Remove loading skeleton on first render
  const skel = $('loading-skeleton')
  if (skel) skel.remove()

  const showExecSummary = !!settings.executiveSummary
  buildTabs(pods, showExecSummary);
  await buildOverviewPanel(data, pods);
  if (showExecSummary) await buildExecutiveSummaryPanel(data, settings, pods);
  pods.forEach(pod => buildPodPanel(pod));

  // Restore previously active tab
  const validTabs = ['overview', ...(showExecSummary ? ['exec-summary'] : []), ...Object.keys(data.pods)]
  switchTab(validTabs.includes(_activeTab) ? _activeTab : 'overview');

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
  const stored = await new Promise(r => chrome.storage.local.get(STORAGE_KEYS.boardFilters, r));
  _boardFilters = stored[STORAGE_KEYS.boardFilters] || {};

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
