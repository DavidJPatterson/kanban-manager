/* team.js — Team management: holiday scheduling per pod */

const $ = id => document.getElementById(id)
function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') }
function escAttr(s) { return (s || '').replace(/"/g, '&quot;').replace(/</g, '&lt;') }

let _holidays = {}   // { podId: { memberId: [{ start, end }] } }
let _settings = null
let _cachedData = null

// ─── Render ──────────────────────────────────────────────────────────────────

function renderPods(pods) {
  const container = $('pods-container')
  container.innerHTML = ''

  if (!pods.length) {
    container.innerHTML = '<div class="empty-msg">No pods configured. Go to Settings to add pods first.</div>'
    return
  }

  for (const pod of pods) {
    const podData = _cachedData?.pods?.[pod.id]
    const teamId = podData?.teamId
    const color = podColor(pod.id)
    const podHols = _holidays[pod.id] || {}
    const memberCount = Object.keys(podHols).filter(k => k !== '_podPaused').length

    const podPause = _holidays[pod.id]?._podPaused || {}
    const isPaused = !!podPause.paused

    const section = document.createElement('div')
    section.className = 'pod-section'
    section.innerHTML = `
      <div class="pod-section-header" style="border-left-color:${color}" data-pod-id="${escAttr(pod.id)}">
        <span class="pod-section-name">${escHtml(pod.name)}</span>
        <span class="pod-section-count" data-count-pod="${escAttr(pod.id)}">${memberCount} members</span>
        <button class="sync-btn" data-sync-pod="${escAttr(pod.id)}" data-team-id="${escAttr(teamId || '')}" title="Sync members from Azure DevOps">↻ Sync from ADO</button>
        <span class="pod-section-toggle collapsed">▼</span>
      </div>
      <div class="pod-section-body collapsed" data-body-pod="${escAttr(pod.id)}">
        <div class="pod-pause-row">
          <label class="pause-toggle">
            <input type="checkbox" ${isPaused ? 'checked' : ''} data-pause-pod="${escAttr(pod.id)}" />
            Pod paused <span style="color:var(--muted);font-size:.75rem">(not producing — skip alerts)</span>
          </label>
          <div class="pause-dates" data-pause-dates="${escAttr(pod.id)}" style="display:${isPaused ? 'flex' : 'none'}">
            <span style="font-size:.75rem;color:var(--muted)">Resumes</span>
            <input type="date" class="pause-resume-input" data-pause-resume="${escAttr(pod.id)}" value="${escAttr(podPause.resumeDate || '')}" />
          </div>
        </div>
        <div class="member-list" data-members-pod="${escAttr(pod.id)}"></div>
      </div>
    `
    container.appendChild(section)

    // Pause toggle
    const pauseCheck = section.querySelector(`[data-pause-pod="${pod.id}"]`)
    const pauseDates = section.querySelector(`[data-pause-dates="${pod.id}"]`)
    const resumeInput = section.querySelector(`[data-pause-resume="${pod.id}"]`)

    pauseCheck.addEventListener('change', () => {
      if (!_holidays[pod.id]) _holidays[pod.id] = {}
      if (pauseCheck.checked) {
        _holidays[pod.id]._podPaused = { paused: true, resumeDate: resumeInput.value || '' }
        pauseDates.style.display = 'flex'
      } else {
        _holidays[pod.id]._podPaused = { paused: false, resumeDate: '' }
        pauseDates.style.display = 'none'
      }
      save()
    })

    resumeInput.addEventListener('change', () => {
      if (!_holidays[pod.id]) _holidays[pod.id] = {}
      if (!_holidays[pod.id]._podPaused) _holidays[pod.id]._podPaused = { paused: true }
      _holidays[pod.id]._podPaused.resumeDate = resumeInput.value
      save()
    })

    // Render members
    renderMembers(pod.id)

    // Collapse/expand
    const header = section.querySelector('.pod-section-header')
    header.addEventListener('click', (e) => {
      if (e.target.closest('.sync-btn')) return
      const body = section.querySelector('.pod-section-body')
      const toggle = section.querySelector('.pod-section-toggle')
      body.classList.toggle('collapsed')
      toggle.classList.toggle('collapsed')
    })

    // Sync button
    const syncBtn = section.querySelector('.sync-btn')
    if (!teamId) {
      syncBtn.disabled = true
      syncBtn.title = 'No team ID resolved — check pod area path in Settings'
    }
    syncBtn.addEventListener('click', () => syncMembers(pod.id, teamId, syncBtn))
  }
}

function renderMembers(podId) {
  const list = document.querySelector(`[data-members-pod="${podId}"]`)
  const podHols = _holidays[podId] || {}
  const memberIds = Object.keys(podHols).filter(k => k !== '_podPaused')
  const countEl = document.querySelector(`[data-count-pod="${podId}"]`)
  if (countEl) countEl.textContent = `${memberIds.length} member${memberIds.length !== 1 ? 's' : ''}`

  if (!memberIds.length) {
    list.innerHTML = '<div class="empty-msg">No team members synced yet. Click "↻ Sync from ADO" to fetch the team.</div>'
    return
  }

  list.innerHTML = ''
  for (const memberId of memberIds) {
    const member = podHols[memberId]
    const name = member.name || memberId
    const holidays = member.holidays || []
    const hasHolidays = holidays.length > 0

    const row = document.createElement('div')
    row.className = 'member-row'

    row.innerHTML = `
      <div class="member-avatar" style="background:${assigneeColor(name)}">${initials(name)}</div>
      <div class="member-name">${escHtml(name)}</div>
      <label class="holiday-toggle">
        <input type="checkbox" ${hasHolidays ? 'checked' : ''} data-hol-toggle="${escAttr(podId)}:${escAttr(memberId)}" />
        On holiday
      </label>
    `

    // Holiday dates container
    const datesDiv = document.createElement('div')
    datesDiv.className = 'holiday-dates'
    datesDiv.style.display = hasHolidays ? 'flex' : 'none'
    datesDiv.dataset.holDates = `${podId}:${memberId}`

    if (hasHolidays) {
      for (let i = 0; i < holidays.length; i++) {
        datesDiv.appendChild(makeDateRow(podId, memberId, i, holidays[i]))
      }
    }

    // Add period button
    const addBtn = document.createElement('button')
    addBtn.className = 'holiday-add-btn'
    addBtn.textContent = '+ Add period'
    addBtn.addEventListener('click', () => {
      const hols = (_holidays[podId]?.[memberId]?.holidays) || []
      const today = new Date().toISOString().split('T')[0]
      hols.push({ start: today, end: today })
      _holidays[podId][memberId].holidays = hols
      save()
      renderMembers(podId)
    })
    datesDiv.appendChild(addBtn)

    row.appendChild(datesDiv)
    list.appendChild(row)

    // Toggle handler
    const toggle = row.querySelector(`[data-hol-toggle="${podId}:${memberId}"]`)
    toggle.addEventListener('change', () => {
      if (toggle.checked) {
        const today = new Date().toISOString().split('T')[0]
        _holidays[podId][memberId].holidays = [{ start: today, end: today }]
      } else {
        _holidays[podId][memberId].holidays = []
      }
      save()
      renderMembers(podId)
    })
  }
}

function makeDateRow(podId, memberId, idx, hol) {
  const row = document.createElement('div')
  row.className = 'holiday-date-row'

  const startInput = document.createElement('input')
  startInput.type = 'date'
  startInput.value = hol.start || ''
  startInput.addEventListener('change', () => {
    _holidays[podId][memberId].holidays[idx].start = startInput.value
    if (!endInput.value || endInput.value < startInput.value) {
      endInput.value = startInput.value
      _holidays[podId][memberId].holidays[idx].end = startInput.value
    }
    save()
  })

  const toLabel = document.createElement('span')
  toLabel.textContent = 'to'
  toLabel.style.color = 'var(--muted)'
  toLabel.style.fontSize = '0.75rem'

  const endInput = document.createElement('input')
  endInput.type = 'date'
  endInput.value = hol.end || ''
  endInput.addEventListener('change', () => {
    _holidays[podId][memberId].holidays[idx].end = endInput.value
    save()
  })

  const removeBtn = document.createElement('button')
  removeBtn.className = 'holiday-remove-btn'
  removeBtn.textContent = '✕'
  removeBtn.title = 'Remove this period'
  removeBtn.addEventListener('click', () => {
    _holidays[podId][memberId].holidays.splice(idx, 1)
    save()
    renderMembers(podId)
  })

  row.append(startInput, toLabel, endInput, removeBtn)
  return row
}

// ─── Sync from ADO ───────────────────────────────────────────────────────────

async function syncMembers(podId, teamId, btn) {
  if (!teamId || !_settings) return
  btn.disabled = true
  btn.textContent = '↻ Syncing…'
  setStatus('Fetching team members from Azure DevOps…')

  try {
    const members = await fetchTeamMembers(teamId, _settings)
    if (!members.length) {
      setStatus('No team members found for this team.', 'err')
      btn.textContent = '↻ Sync from ADO'
      btn.disabled = false
      return
    }

    // Merge: keep existing holidays for known members, add new members
    if (!_holidays[podId]) _holidays[podId] = {}
    const existingIds = new Set(Object.keys(_holidays[podId]))
    const fetchedIds = new Set()

    for (const m of members) {
      fetchedIds.add(m.id)
      if (!_holidays[podId][m.id]) {
        _holidays[podId][m.id] = { name: m.name, uniqueName: m.uniqueName, holidays: [] }
      } else {
        // Update name in case it changed
        _holidays[podId][m.id].name = m.name
        _holidays[podId][m.id].uniqueName = m.uniqueName
      }
    }

    // Remove members no longer in the team (but keep ones with active holidays)
    for (const id of existingIds) {
      if (!fetchedIds.has(id) && !(_holidays[podId][id]?.holidays?.length)) {
        delete _holidays[podId][id]
      }
    }

    await save()
    renderMembers(podId)
    setStatus(`Synced ${members.length} members for this pod.`, 'ok')
  } catch (err) {
    setStatus(`Sync failed: ${err.message}`, 'err')
  } finally {
    btn.textContent = '↻ Sync from ADO'
    btn.disabled = false
  }
}

async function syncAllPods() {
  const btn = $('sync-all-btn')
  btn.disabled = true
  btn.textContent = '↻ Syncing all…'
  const pods = _settings?.pods || []
  let synced = 0
  let failed = 0

  for (const pod of pods) {
    const teamId = _cachedData?.pods?.[pod.id]?.teamId
    if (!teamId) { failed++; continue }

    try {
      const members = await fetchTeamMembers(teamId, _settings)
      if (!members.length) { failed++; continue }

      if (!_holidays[pod.id]) _holidays[pod.id] = {}
      const existingIds = new Set(Object.keys(_holidays[pod.id]))
      const fetchedIds = new Set()

      for (const m of members) {
        fetchedIds.add(m.id)
        if (!_holidays[pod.id][m.id]) {
          _holidays[pod.id][m.id] = { name: m.name, uniqueName: m.uniqueName, holidays: [] }
        } else {
          _holidays[pod.id][m.id].name = m.name
          _holidays[pod.id][m.id].uniqueName = m.uniqueName
        }
      }

      for (const id of existingIds) {
        if (!fetchedIds.has(id) && !(_holidays[pod.id][id]?.holidays?.length)) {
          delete _holidays[pod.id][id]
        }
      }

      synced++
      renderMembers(pod.id)
    } catch (_) {
      failed++
    }
  }

  await save()
  btn.textContent = '↻ Sync All Pods'
  btn.disabled = false
  const msg = failed ? `Synced ${synced} pods (${failed} failed or skipped)` : `Synced all ${synced} pods`
  setStatus(msg, failed ? 'err' : 'ok')
}

// ─── Persistence ─────────────────────────────────────────────────────────────

async function save() {
  await setTeamHolidays(_holidays)
}

// ─── Holidays import / export ────────────────────────────────────────────────

function exportHolidays() {
  const podCount = Object.keys(_holidays).length
  if (!podCount) { setStatus('No holidays to export.', 'err'); return }
  // Pod metadata so cross-install merge can match by areaPath rather than
  // the random local pod.id (which differs on every install).
  const podMeta = {}
  for (const pod of (_settings?.pods || [])) {
    if (pod?.id) podMeta[pod.id] = { areaPath: pod.areaPath, name: pod.name }
  }
  const payload = {
    type: 'kanban-manager-holidays',
    version: 1,
    exportedAt: new Date().toISOString(),
    pods: podMeta,
    holidays: _holidays
  }
  const stamp = new Date().toISOString().slice(0, 10)
  downloadJson(`kanban-manager-holidays-${stamp}.json`, payload)
  setStatus(`Exported holidays for ${podCount} pod${podCount !== 1 ? 's' : ''}.`, 'ok')
}

async function importHolidays() {
  let payload
  try { payload = await pickJsonFile() }
  catch (err) {
    if (err.message !== 'No file selected') setStatus(err.message, 'err')
    return
  }
  if (payload?.type !== 'kanban-manager-holidays' || !payload.holidays || typeof payload.holidays !== 'object' || !payload.pods || typeof payload.pods !== 'object') {
    setStatus('Not a valid holidays export file.', 'err'); return
  }
  const remapped = remapHolidaysToLocalPodIds(payload.holidays, payload.pods, _settings?.pods || [])

  const incomingPods = Object.keys(payload.holidays).length
  const matchedByPath = Object.keys(remapped).filter(localId => (_settings?.pods || []).some(p => p.id === localId)).length
  const existingPods = Object.keys(_holidays).length

  const mode = await pickImportMode(`File contains holidays for ${incomingPods} pod${incomingPods !== 1 ? 's' : ''}. ${matchedByPath} of ${incomingPods} matched a local pod by area path. You currently have data for ${existingPods}. Replace wipes existing; Merge keeps existing and unions holiday entries by member email.`)
  if (mode === 'cancel') return

  if (mode === 'replace') {
    _holidays = remapped
    await save()
    renderPods(_settings.pods || [])
    setStatus(`Replaced holidays with data for ${incomingPods} pod${incomingPods !== 1 ? 's' : ''}.`, 'ok')
  } else {
    const { result, podsTouched, membersAdded, membersMerged } = mergeHolidays(_holidays, remapped)
    _holidays = result
    await save()
    renderPods(_settings.pods || [])
    setStatus(`Merged ${podsTouched} pod${podsTouched !== 1 ? 's' : ''}: ${membersAdded} member(s) added, ${membersMerged} member(s) updated.`, 'ok')
  }
}

function setStatus(msg, cls) {
  const el = $('status')
  el.textContent = msg
  el.className = 'status' + (cls ? ` ${cls}` : '')
  if (cls === 'ok') setTimeout(() => { el.textContent = '' }, 3000)
}

// ─── Init ────────────────────────────────────────────────────────────────────

;(async () => {
  // Theme
  const themeBtn = $('theme-btn')
  initTheme().then(t => { themeBtn.textContent = t === 'dark' ? '☀' : '☾' })
  themeBtn.addEventListener('click', () => toggleTheme().then(t => { themeBtn.textContent = t === 'dark' ? '☀' : '☾' }))

  // Back button
  $('back-btn').addEventListener('click', () => {
    chrome.tabs.update({ url: 'board.html' })
  })

  // Sync all
  $('sync-all-btn').addEventListener('click', syncAllPods)

  // Holidays import / export
  $('export-holidays-btn').addEventListener('click', exportHolidays)
  $('import-holidays-btn').addEventListener('click', importHolidays)

  // Load data
  _settings = await getSettings()
  _cachedData = await getCachedData()
  _holidays = await getTeamHolidays()

  const pods = _settings.pods || []
  if (!pods.length) {
    $('pods-container').innerHTML = '<div class="empty-msg">No pods configured. Go to Settings to add pods first.</div>'
    return
  }

  renderPods(pods)
})()
