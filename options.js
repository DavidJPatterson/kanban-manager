// options.js

function $(id) { return document.getElementById(id); }

function setStatus(msg, ok) {
  const el = $('status');
  el.textContent = msg;
  el.className = 'status ' + (ok ? 'ok' : 'err');
  setTimeout(() => { el.textContent = ''; el.className = 'status'; }, 5000);
}

function podColorForIndex(i) {
  return POD_PALETTE[i % POD_PALETTE.length];
}

// ─── Pod list rendering ───────────────────────────────────────────────────────

function renderPodList(pods) {
  const list = $('pods-list');
  list.innerHTML = '';
  pods.forEach((pod, i) => {
    const color = podColorForIndex(i);
    const row = document.createElement('div');
    row.className = 'pod-row';
    row.dataset.podId = pod.id;
    row.innerHTML = `
      <div class="pod-color-dot" style="background:${color}"></div>
      <input class="pod-name-input" type="text" placeholder="Pod name" value="${escAttr(pod.name)}" data-field="name" />
      <input class="pod-path-input" type="text" placeholder="Platform\\Team\\Pod X" value="${escAttr(pod.areaPath)}" data-field="areaPath" />
      <button class="pod-remove-btn" title="Remove pod">✕</button>
      <textarea class="pod-desc-input" placeholder="Brief description for executive summary" data-field="description" rows="1">${escAttr(pod.description || '')}</textarea>
    `;
    row.querySelector('.pod-remove-btn').addEventListener('click', () => {
      row.remove();
    });
    list.appendChild(row);
  });
}

function escAttr(s) {
  return (s || '').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function readPods() {
  return Array.from($('pods-list').querySelectorAll('.pod-row')).map(row => ({
    id: row.dataset.podId || ('pod-' + Date.now().toString(36)),
    name: row.querySelector('[data-field="name"]').value.trim(),
    areaPath: row.querySelector('[data-field="areaPath"]').value.trim(),
    description: (row.querySelector('[data-field="description"]')?.value || '').trim()
  })).filter(p => p.name && p.areaPath);
}

// ─── Load settings ────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // Load saved settings first — this is the critical path
  chrome.storage.local.get(STORAGE_KEYS.settings, result => {
    let s = result[STORAGE_KEYS.settings] || {};
    // Migrate old single-areaPath format
    if (s.areaPath && (!s.pods || s.pods.length === 0)) {
      s.pods = [{ id: 'pod-migrated', name: 'Pod 1', areaPath: s.areaPath }];
    }
    $('org').value = s.org || '';
    $('project').value = s.project || '';
    $('pat').value = s.pat || '';
    $('refreshInterval').value = String(s.refreshInterval || 15);
    $('staleDays').value = String(s.staleDays || 2);
    renderPodList(s.pods || []);

    // Executive summary toggle
    $('exec-summary').checked = !!s.executiveSummary;

    // Overview chart toggles
    const oc = s.overviewCharts || {};
    $('ct-in-progress').checked = !!oc.cycleTimeInProgress;
    $('ct-arrival').checked = !!oc.cycleTimeArrival;
    $('tp-by-person').checked = !!oc.throughputByPerson;
    $('ct-by-person').checked = !!oc.cycleTimeByPerson;
    $('resolved-by-person').checked = !!oc.resolvedByPerson;
    $('burndown-pi').checked = !!oc.burndownByPI;
    $('wip-trend').checked = !!oc.wipTrend;
    $('age-distribution').checked = !!oc.ageDistribution;
    $('flow-efficiency').checked = !!oc.flowEfficiency;
    $('stale-items').checked = !!oc.staleItems;
    $('bug-ratio-trend').checked = !!oc.bugRatioTrend;
    $('tp-predictability').checked = !!oc.throughputPredictability;
    $('priority-age-dist').checked = !!oc.priorityAgeDistribution;
    $('cfd-chart').checked = !!oc.cfdChart;
  });

  document.getElementById('save-btn').addEventListener('click', save);
  document.getElementById('test-btn').addEventListener('click', testConnection);

  // Theme toggle (guarded in case shared.js hasn't loaded yet)
  const themeBtn = document.getElementById('theme-btn')
  if (typeof initTheme === 'function') {
    initTheme().then(t => { themeBtn.textContent = t === 'dark' ? '☀' : '☾' })
    themeBtn.addEventListener('click', () => toggleTheme().then(t => { themeBtn.textContent = t === 'dark' ? '☀' : '☾' }))
  }

  document.getElementById('pods-export-btn').addEventListener('click', exportPods);
  document.getElementById('pods-import-btn').addEventListener('click', importPods);

  document.getElementById('add-pod-btn').addEventListener('click', () => {
    const list = $('pods-list');
    const idx = list.children.length;
    const color = podColorForIndex(idx);
    const row = document.createElement('div');
    row.className = 'pod-row';
    row.dataset.podId = 'pod-' + Date.now().toString(36);
    row.innerHTML = `
      <div class="pod-color-dot" style="background:${color}"></div>
      <input class="pod-name-input" type="text" placeholder="Pod name" data-field="name" />
      <input class="pod-path-input" type="text" placeholder="Platform\\Team\\Pod X" data-field="areaPath" />
      <button class="pod-remove-btn" title="Remove pod">✕</button>
      <textarea class="pod-desc-input" placeholder="Brief description for executive summary" data-field="description" rows="1"></textarea>
    `;
    row.querySelector('.pod-remove-btn').addEventListener('click', () => row.remove());
    list.appendChild(row);
    row.querySelector('.pod-name-input').focus();
  });
});

// ─── Save ─────────────────────────────────────────────────────────────────────

function save() {
  const pods = readPods();
  const settings = {
    org: $('org').value.trim(),
    project: $('project').value.trim(),
    pat: $('pat').value.trim(),
    refreshInterval: parseInt($('refreshInterval').value, 10),
    staleDays: parseInt($('staleDays').value, 10) || 2,
    pods,
    executiveSummary: $('exec-summary').checked,
    overviewCharts: {
      cycleTimeInProgress: $('ct-in-progress').checked,
      cycleTimeArrival: $('ct-arrival').checked,
      throughputByPerson: $('tp-by-person').checked,
      cycleTimeByPerson: $('ct-by-person').checked,
      resolvedByPerson: $('resolved-by-person').checked,
      burndownByPI: $('burndown-pi').checked,
      wipTrend: $('wip-trend').checked,
      ageDistribution: $('age-distribution').checked,
      flowEfficiency: $('flow-efficiency').checked,
      staleItems: $('stale-items').checked,
      bugRatioTrend: $('bug-ratio-trend').checked,
      throughputPredictability: $('tp-predictability').checked,
      priorityAgeDistribution: $('priority-age-dist').checked,
      cfdChart: $('cfd-chart').checked
    }
  };

  if (!settings.org || !settings.project) {
    setStatus('Organisation and Project are required.', false); return;
  }
  if (!settings.pat) {
    setStatus('A Personal Access Token is required.', false); return;
  }
  if (!pods.length) {
    setStatus('Add at least one pod to track.', false); return;
  }

  chrome.storage.local.set({ [STORAGE_KEYS.settings]: settings }, () => {
    setStatus(`Saved ${pods.length} pod${pods.length !== 1 ? 's' : ''}. Triggering refresh…`, true);
    chrome.storage.local.remove([STORAGE_KEYS.cachedData, STORAGE_KEYS.arrivedAtCache], () => {
      chrome.runtime.sendMessage({ type: 'REFRESH' });
    });
  });
}

// ─── Pods import / export ─────────────────────────────────────────────────────

function exportPods() {
  const pods = readPods();
  if (!pods.length) { setStatus('No pods to export.', false); return; }
  const payload = {
    type: 'kanban-manager-pods',
    version: 1,
    exportedAt: new Date().toISOString(),
    pods
  };
  const stamp = new Date().toISOString().slice(0, 10);
  downloadJson(`kanban-manager-pods-${stamp}.json`, payload);
  setStatus(`Exported ${pods.length} pod${pods.length !== 1 ? 's' : ''}.`, true);
}

async function importPods() {
  let payload;
  try { payload = await pickJsonFile(); }
  catch (err) {
    if (err.message !== 'No file selected') setStatus(err.message, false);
    return;
  }
  if (payload?.type !== 'kanban-manager-pods' || !Array.isArray(payload.pods)) {
    setStatus('Not a valid pods export file.', false); return;
  }
  const incoming = payload.pods
    .filter(p => p && typeof p.name === 'string' && typeof p.areaPath === 'string')
    .map(p => ({
      id: typeof p.id === 'string' && p.id ? p.id : '',
      name: p.name.trim(),
      areaPath: p.areaPath.trim(),
      description: typeof p.description === 'string' ? p.description : ''
    }))
    .filter(p => p.name && p.areaPath);
  if (!incoming.length) { setStatus('No valid pods found in file.', false); return; }

  const existing = readPods();
  const mode = await pickImportMode(`File contains ${incoming.length} pod${incoming.length !== 1 ? 's' : ''}. You currently have ${existing.length}. Replace overwrites everything; Merge keeps existing pods and adds/updates by area path.`);
  if (mode === 'cancel') return;

  if (mode === 'replace') {
    const final = incoming.map(p => ({
      ...p,
      id: p.id || 'pod-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    }));
    renderPodList(final);
    setStatus(`Loaded ${final.length} pod${final.length !== 1 ? 's' : ''} (replace mode). Click Save Settings to persist.`, true);
  } else {
    const { result, added, updated } = mergePods(existing, incoming);
    renderPodList(result);
    setStatus(`Merged: ${added} added, ${updated} updated, ${existing.length - updated} unchanged. Click Save Settings to persist.`, true);
  }
}

// ─── Test connection ──────────────────────────────────────────────────────────

async function testConnection() {
  const pods = readPods();
  const org = $('org').value.trim();
  const project = $('project').value.trim();
  const pat = $('pat').value.trim();

  const resultEl = $('test-result');
  resultEl.style.display = 'block';
  resultEl.style.color = '#94a3b8';

  if (!pat) { resultEl.textContent = '❌ Enter a PAT first.'; return; }
  if (!pods.length) { resultEl.textContent = '❌ Add at least one pod first.'; return; }

  resultEl.textContent = `Testing ${pods.length} pod${pods.length !== 1 ? 's' : ''}…`;

  const tempSettings = { org, project, pat };
  const lines = [];
  for (const pod of pods) {
    try {
      const ap = pod.areaPath.replace(/'/g, "''");
      const ids = await runWiql(
        `SELECT [System.Id] FROM WorkItems WHERE [System.AreaPath] UNDER '${ap}' AND [System.State] NOT IN ('Closed','Removed')`,
        tempSettings
      );
      lines.push(`✅ ${pod.name}: ${ids.length} active items`);
    } catch (err) {
      lines.push(`❌ ${pod.name}: ${err.message}`);
    }
  }

  resultEl.textContent = lines.join('\n');
  resultEl.style.color = lines.every(l => l.startsWith('✅')) ? '#22c55e' : '#fcd34d';
}
