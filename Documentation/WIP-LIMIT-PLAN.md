# WIP Limit Feature — Implementation Plan

## Overview

Display per-column WIP limits sourced from the **Azure DevOps board policy** for each pod.
When a column's live item count exceeds the ADO-configured limit, the column header turns
red and shows an `X / limit` badge, giving teams an immediate visual signal during standups
and planning.

WIP limits are **not** stored in the extension's settings — they come directly from ADO,
providing a single source of truth that stays in sync with the team's board configuration.

---

## Data Source — ADO Board Columns API

### How ADO exposes WIP limits

Each ADO team has one or more boards (e.g. "Stories", "Bugs"). Each board has columns,
and each column has an `itemLimit` field (integer, `0` = no limit).

**Endpoint:**
```
GET https://dev.azure.com/{org}/{project}/{team}/_apis/work/boards/{board}?api-version=7.1
```

**Relevant response fields per column:**
```json
{
  "name": "In Progress",
  "itemLimit": 4,
  "columnType": "inProgress",
  "isSplit": false,
  "stateMappings": { "User Story": "Active", "Bug": "Committed" }
}
```

- `itemLimit` is the WIP limit. `0` means no limit is configured.
- `columnType` is one of `incoming`, `inProgress`, `outgoing`.
- Column names here match `System.BoardColumn` values already used by the extension.

### Resolving area path → team → board

The Boards API is **team-scoped** — there is no "get board by area path" shortcut.
To find the right team for each pod, we use the Team Field Values API:

```
GET https://dev.azure.com/{org}/_apis/projects/{project}/teams?api-version=7.1
GET https://dev.azure.com/{org}/{project}/{team}/_apis/work/teamsettings/teamfieldvalues?api-version=7.1
```

The team field values response lists area paths owned by the team:
```json
{
  "values": [
    { "value": "Project\\Team A", "includeChildren": true }
  ]
}
```

**Resolution algorithm:**
1. Fetch all teams for the project (once, cached).
2. For each team, fetch its team field values (area paths).
3. Match each pod's `areaPath` to the team whose area path values contain it
   (respecting `includeChildren`).
4. For the matched team, fetch the board (typically "Stories" for Agile, "Backlog items"
   for Scrum — discovered via `GET .../_apis/work/boards`).
5. Read `columns[].itemLimit` from the board response.

### Board name discovery

The board name depends on the ADO process template:
- **Agile:** "Stories"
- **Scrum:** "Backlog items"
- **CMMI:** "Requirements"

Use the List Boards endpoint to discover valid board names:
```
GET https://dev.azure.com/{org}/{project}/{team}/_apis/work/boards?api-version=7.1
```

Pick the first board of type "Stories" / "Backlog items" / "Requirements", or
fall back to the first board in the list.

### PAT scope

The existing `vso.work` (Work Items Read) scope is sufficient for all these
read-only endpoints. No additional permissions needed.

---

## Data Model

WIP limits are fetched at runtime and attached to the pod's cached data — **not** stored
in `settings`. The cached pod data gains a `wipLimits` map:

```javascript
// cachedData.pods[podId]
{
  id: "pod-abc",
  name: "Team A",
  areaPath: "Platform\\Team A",
  items: [ /* ... */ ],
  wipLimits: {          // populated from ADO board columns
    "In Progress": 4,
    "Code Review": 3,
    "Ready for Test": 2
  },
  teamId: "guid",       // resolved team ID (cached for reuse)
  boardName: "Stories",  // resolved board name (cached for reuse)
  fetchedAt: "2026-03-17T..."
}
```

- Keys are exact board column names (matching `System.BoardColumn`).
- Only columns with `itemLimit > 0` are included.
- The `teamId` and `boardName` are cached so subsequent refreshes skip the resolution step.

---

## No Options Page Changes

Since WIP limits come from ADO, there is **no settings UI** for WIP limits. Teams configure
their limits on the ADO board directly. The extension simply reads and displays them.

---

## shared.js Changes

### New function: `fetchTeamForPod(pod, settings)`

Resolves a pod's area path to an ADO team ID:

```javascript
async function fetchTeamForPod(pod, settings) {
  // 1. Fetch all teams for the project
  const teamsResp = await adoFetch(
    `https://dev.azure.com/${settings.org}/_apis/projects/${settings.project}/teams?api-version=7.1`,
    settings
  )
  // 2. For each team, fetch team field values and match against pod.areaPath
  for (const team of teamsResp.value) {
    const fields = await adoFetch(
      `https://dev.azure.com/${settings.org}/${settings.project}/${team.id}/_apis/work/teamsettings/teamfieldvalues?api-version=7.1`,
      settings
    )
    for (const v of fields.values) {
      if (v.value === pod.areaPath) return team
      if (v.includeChildren && pod.areaPath.startsWith(v.value + '\\')) return team
    }
  }
  return null
}
```

### New function: `fetchWipLimits(pod, settings)`

Fetches WIP limits for a pod from its team's board:

```javascript
async function fetchWipLimits(pod, settings) {
  // 1. Resolve team (use cached teamId if available)
  const team = pod.teamId
    ? { id: pod.teamId }
    : await fetchTeamForPod(pod, settings)
  if (!team) return { wipLimits: {}, teamId: null, boardName: null }

  // 2. Discover board name (use cached boardName if available)
  let boardName = pod.boardName
  if (!boardName) {
    const boards = await adoFetch(
      `https://dev.azure.com/${settings.org}/${settings.project}/${team.id}/_apis/work/boards?api-version=7.1`,
      settings
    )
    boardName = boards.value[0]?.name || 'Stories'
  }

  // 3. Fetch board with columns
  const board = await adoFetch(
    `https://dev.azure.com/${settings.org}/${settings.project}/${team.id}/_apis/work/boards/${encodeURIComponent(boardName)}?api-version=7.1`,
    settings
  )

  // 4. Extract limits
  const wipLimits = {}
  for (const col of board.columns || []) {
    if (col.itemLimit > 0) wipLimits[col.name] = col.itemLimit
  }

  return { wipLimits, teamId: team.id, boardName }
}
```

### Update `fetchPodData()`

Call `fetchWipLimits()` alongside the existing WIQL/batch fetches and merge the result
into the returned pod data:

```javascript
// Inside fetchPodData, after fetching items:
const { wipLimits, teamId, boardName } = await fetchWipLimits(pod, settings)
return {
  id: pod.id,
  name: pod.name,
  areaPath: pod.areaPath,
  items,
  wipLimits,
  teamId,
  boardName,
  fetchedAt: new Date().toISOString()
}
```

### Caching strategy

- **Team mapping** changes rarely. Cache `teamId` and `boardName` in the pod's cached data
  so subsequent refreshes skip the team resolution (saving N+1 API calls).
- **WIP limits** are re-fetched on every data refresh (single API call per pod) to stay in
  sync with any board config changes.
- If team resolution fails (no matching team found), `wipLimits` is `{}` and the pod
  displays as it does today — no limits shown.

---

## Board Display Changes (`board.js`)

### Column header

Current:
```html
<div class="col-header">
  <div class="col-title"><div class="col-dot"></div>In Progress</div>
  <span class="col-count">5</span>
</div>
```

Proposed when limit is configured:
```html
<div class="col-header wip-exceeded">   <!-- class added when over limit -->
  <div class="col-title"><div class="col-dot"></div>In Progress</div>
  <span class="col-count">5 / 4</span>  <!-- "current / limit" -->
</div>
```

### CSS

```css
.col-header.wip-exceeded .col-count {
  color: #ef4444;
  font-weight: 700;
}
.col-header.wip-exceeded .col-title {
  color: #fca5a5;
}
/* Optional: subtle border on the whole column */
.column.wip-exceeded {
  border-top-color: #ef4444;
  box-shadow: 0 0 0 1px rgba(239,68,68,.3);
}
```

### buildPodPanel changes

When generating the column HTML, read `pod.wipLimits` and check each column against its
limit:

```javascript
const limit = (pod.wipLimits || {})[col]
const count = byCol[col].length
const overLimit = limit && count > limit
const countLabel = limit ? `${count} / ${limit}` : count
const exceededClass = overLimit ? ' wip-exceeded' : ''
```

Apply `exceededClass` to both `.col-header` and `.column`.

### Live update after drag-drop

`updateColCounts()` (called after every drag-drop) currently only updates the count number.
It needs to also recheck and toggle the `wip-exceeded` class on `.col-header` and `.column`
for both the source and destination columns.

Proposed `updateColCounts` update:
```javascript
function updateColCounts() {
  panel.querySelectorAll('.column').forEach(col => {
    const colName = col.querySelector('.col-body')?.dataset.column
    const limit = (pod.wipLimits || {})[colName]
    const visible = col.querySelectorAll('.card:not(.hidden)').length
    col.querySelector('.col-count').textContent = limit ? `${visible} / ${limit}` : visible
    const exceeded = limit && visible > limit
    col.querySelector('.col-header').classList.toggle('wip-exceeded', exceeded)
    col.classList.toggle('wip-exceeded', exceeded)
  })
}
```

---

## Overview Panel Changes

Add a "WIP Limits" summary widget to the pod summary cards in the Overview tab.
If any pod has limits configured and any column is over-limit, show a small warning
indicator on that pod's card:

```
Team A  Triage: 2  WIP: 5  Ready: 1  Aged >90d: 0
                   ^^^
                   ⚠ over WIP limit (4)
```

This is a small inline badge — low effort, high visibility.

---

## Scope Not Included

- **Enforcement**: WIP limits are **advisory only** — drag-and-drop is not blocked when a limit
  is breached. Blocking drag would frustrate users; warnings achieve the desired behaviour change.
- **Per-item-type limits**: Only total column count is checked, not limits per work item type.
- **WIP limit editing**: The extension does not provide UI to change WIP limits — teams manage
  this directly on their ADO board settings page.
- **Split column support**: If a column has `isSplit: true` in ADO, the limit applies to the
  whole column (Doing + Done). This matches ADO's own behaviour.

---

## Error Handling

- If team resolution fails (no team matches the pod's area path), log a warning and
  display the board with no WIP limits — same as today.
- If the Boards API call fails (e.g. permissions, network), capture the error silently
  and proceed without limits. WIP limits are a nice-to-have overlay, not a blocking feature.
- Do not let a WIP limit fetch failure prevent the rest of the pod data from loading.

---

## Estimated Change Surface

| File | Change |
|---|---|
| `shared.js` | Add `fetchTeamForPod()`, `fetchWipLimits()` (~40 lines); update `fetchPodData()` (~5 lines) |
| `board.js` | Update column header HTML, `updateColCounts`, overview pod card (~40 lines) |

Approximately **~85 lines** across two files. No new dependencies. Two new API call patterns
(teams + board columns) using the existing `adoFetch()` helper.

No changes to `options.html`, `options.js`, or `DEFAULT_SETTINGS`.

---

## Suggested Implementation Order

1. `shared.js` — add `fetchTeamForPod()` and `fetchWipLimits()` helpers
2. `shared.js` — integrate into `fetchPodData()` to populate `wipLimits` in cached data
3. `board.js` — column header rendering with `count / limit` and `wip-exceeded` class
4. `board.js` — update `updateColCounts()` for live drag-drop WIP checking
5. `board.js` — overview pod card warning badge
