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
  // Active WIP: items currently in In Progress / Active / In Review columns.
  // Match the on-screen Exec Summary KPI card definition in board.js — NOT
  // "everything alive" (which would also include the backlog: Triage/New/etc.).
  const totalActive = allItems.filter(i => !['Closed', 'Removed', 'Resolved'].includes(i.state))
  const wipItems = totalActive.filter(i => {
    const col = (i.boardColumn || i.state || '').toLowerCase()
    return col.includes('progress') || col.includes('active') || col.includes('review')
  })
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

  function escHtml(s) {
    return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
  }

  function kpiDelta(curr, prev, upIsBad) {
    if (prev == null || curr === '—') return ''
    const d = curr - prev
    if (d === 0) return `<div class="kpi-delta">→ vs prev wk</div>`
    const cls = (upIsBad ? d > 0 : d < 0) ? 'down' : 'up'
    return `<div class="kpi-delta ${cls}">${d > 0 ? '↑' : '↓'}${Math.abs(d)} vs prev wk</div>`
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
        <div class="kpi"><div class="kpi-label">Arrival</div><div class="kpi-value">${arrLast}</div>${kpiDelta(arrLast, arrPrev, true)}</div>
        <div class="kpi"><div class="kpi-label">Throughput</div><div class="kpi-value">${tpLast}</div>${kpiDelta(tpLast, tpPrev, false)}</div>
        <div class="kpi"><div class="kpi-label">Active WIP</div><div class="kpi-value">${wip}</div></div>
        <div class="kpi"><div class="kpi-label">Stale / Blocked</div><div class="kpi-value">${stale.total}</div></div>
      </div>
      <div class="actions-by-lead">
        <span class="label">Actions next week by lead:</span>
        ${Object.entries(byOwner).map(([k, n]) =>
          `<span class="lead-tag ${k === 'Unassigned' ? 'unassigned' : ''}">${escHtml(k)} ${n}</span>`).join(' ') || 'no actions'}
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
