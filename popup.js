// popup.js

function $(id) { return document.getElementById(id); }

function openBoard() {
  chrome.tabs.create({ url: chrome.runtime.getURL('board.html') });
  window.close();
}

document.addEventListener('DOMContentLoaded', () => {
  $('open-board-btn').addEventListener('click', openBoard);
  $('refresh-btn').addEventListener('click', triggerRefresh);

  // configure-btn only exists in the no-PAT state
  const configureBtn = $('configure-btn');
  if (configureBtn) {
    configureBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());
  }
});

function fmtDate(isoStr) {
  if (!isoStr) return 'never';
  const d = new Date(isoStr);
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) +
         ' · ' + d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

const DOT_COLORS = {
  'In Progress': '#f59e0b', 'Code Review': '#8b5cf6',
  'Ready for Release': '#10b981', 'Intake/Triage': '#6366f1'
};

function render(data) {
  if (!data?.pods) return;

  const allItems = getAllItems(data);
  const allActive = allItems.filter(i => !['Closed', 'Removed', 'Resolved'].includes(i.state));

  // Aggregate stats
  const cols     = columnCounts(allActive);
  const triageCnt  = colCount(cols, 'Triage', 'Intake');
  const wipCnt     = colCount(cols, 'In Progress', 'Active') + colCount(cols, 'Code Review', 'Review');
  const releaseCnt = colCount(cols, 'Ready');
  const agedCnt    = allActive.filter(i => ageDays(i) >= 90).length;

  $('s-triage').textContent  = triageCnt;
  $('s-wip').textContent     = wipCnt;
  $('s-release').textContent = releaseCnt;
  $('s-aged').textContent    = agedCnt;

  // Aggregate arrival rate
  const stats = arrivalStats(allItems);
  $('a-last7').textContent = stats.last7;
  const diff = stats.last7 - stats.prev7;
  $('a-trend').innerHTML = diff === 0
    ? `<span class="trend-same">→ same as prev week</span>`
    : diff > 0
      ? `<span class="trend-up">↑ ${diff} more than prev week</span>`
      : `<span class="trend-down">↓ ${Math.abs(diff)} fewer than prev week</span>`;
  $('a-last30').textContent = `Last 30d: ${stats.last30} items`;
  $('a-avg').textContent    = `Avg/week: ${stats.avgPerWeek}`;

  // Per-pod summary rows
  const podList = $('pod-list');
  const pods = Object.values(data.pods);
  podList.innerHTML = pods.map((pod, i) => {
    const pActive = (pod.items || []).filter(i => !['Closed','Removed','Resolved'].includes(i.state));
    const pCols   = columnCounts(pActive);
    const pWip    = colCount(pCols, 'In Progress', 'Active') + colCount(pCols, 'Code Review', 'Review');
    const pTriage = colCount(pCols, 'Triage', 'Intake');
    const pAged   = pActive.filter(x => ageDays(x) >= 90).length;
    const pStats  = arrivalStats(pod.items || []);
    const color   = podColor(pod.id);
    const errIcon = pod.error ? ' ⚠' : '';
    return `<div class="pod-row">
      <div class="pod-dot" style="background:${color}"></div>
      <div class="pod-name">${pod.name}${errIcon}</div>
      <div class="pod-chips">
        <span class="chip chip-triage" title="Triage">${pTriage}</span>
        <span class="chip chip-wip"    title="WIP">${pWip}</span>
        <span class="chip chip-arr"    title="This week">↑${pStats.last7}/wk</span>
        ${pAged > 0 ? `<span class="chip chip-aged" title="Aged >90d">⚠${pAged}</span>` : ''}
      </div>
    </div>`;
  }).join('');

  // Error bar
  const errorBar = $('error-bar');
  const podErrors = pods.filter(p => p.error);
  if (podErrors.length) {
    errorBar.style.display = 'block';
    errorBar.textContent = `⚠ ${podErrors.map(p => p.name).join(', ')} failed to refresh`;
  } else {
    errorBar.style.display = 'none';
  }

  $('last-updated').textContent = data.fetchedAt ? `Updated ${fmtDate(data.fetchedAt)}` : '';
}

async function triggerRefresh() {
  const btn = $('refresh-btn');
  btn.textContent = '↻';
  btn.classList.add('spinning');
  btn.disabled = true;

  try {
    await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'REFRESH' }, resp => {
        if (resp?.ok) resolve();
        else reject(new Error(resp?.error || 'refresh failed'));
      });
    });
    const data = await getCachedData();
    render(data);
  } catch (err) {
    $('error-bar').style.display = 'block';
    $('error-bar').textContent = `⚠ Refresh failed: ${err.message}`;
  } finally {
    btn.textContent = '↻ Refresh';
    btn.classList.remove('spinning');
    btn.disabled = false;
  }
}

// Listen for background data updates while popup is open
chrome.runtime.onMessage.addListener(msg => {
  if (msg.type === 'DATA_UPDATED') render(msg.data);
});

// Initialise
(async () => {
  const settings = await getSettings();
  if (!settings.pat) {
    $('no-pat').style.display = 'block';
    return;
  }
  $('main').style.display = 'block';
  const data = await getCachedData();
  if (data) {
    render(data);
  } else {
    $('last-updated').textContent = 'No data yet — refreshing…';
    triggerRefresh();
  }
})();
