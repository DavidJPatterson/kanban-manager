# CLAUDE.md — Kanban Manager

## Project Overview

**Kanban Manager** is a Chrome extension (Manifest V3) that provides a multi-pod Kanban dashboard for Azure DevOps. It displays work item boards with analytics, metrics, and trend charts — entirely client-side with no build step and no external dependencies.

## Repository Structure

```
kanban-manager/
├── manifest.json          # Chrome extension manifest v3
├── background.js          # Service worker: polling, caching, alarm scheduling
├── shared.js              # Core library: ADO API, analytics, storage helpers
├── popup.html / popup.js  # Quick-stats popup (triage, WIP, aged, arrival)
├── board.html / board.js  # Full Kanban board with tabs per pod + overview
├── options.html / options.js  # Settings page (org, PAT, pods, chart toggles)
├── icons/                 # SVG + PNG icons (16, 48, 128px)
├── package.sh             # Bash script to bundle .zip for Chrome Web Store
├── Documentation/
│   ├── README.md          # Main readme / feature overview
│   ├── INSTALL.md         # Installation and first-run guide
│   ├── PRIVACY.md         # Privacy policy
│   └── STORE_LISTING.md   # Chrome Web Store listing content
└── .github/FUNDING.yml    # GitHub Sponsors config
```

## Key Files and Their Roles

### `shared.js` — Core Library (~1,176 lines)
The single most important file. All other pages import it. Responsibilities:

- **Storage helpers:** `getSettings()`, `setCachedData()`, `getCachedData()`
- **Azure DevOps REST API:** `adoFetch()`, `runWiql()`, `getWorkItemsBatch()`, `getItemArrivedAt()`
- **Data fetching:** `fetchPodData()`, `fetchAllPods()`, `mapItem()`
- **Analytics/calculations:** `calcWeeklyArrival()`, `calcWeeklyThroughput()`, `calcWeeklyWIP()`, `calcAgeDistribution()`, `calcFlowEfficiency()`, `calcBugRatioTrend()`, etc.
- **Work item updates:** `updateWorkItem()`, `reorderWorkItem()`

### `background.js` — Service Worker (~58 lines)
- Schedules background polling via `chrome.alarms`
- Calls `fetchAllPods()` and caches the result in `chrome.storage.local`
- Broadcasts `DATA_UPDATED` messages to any open popup/board pages
- Handles `TRIGGER_REFRESH` messages from the UI

### `board.js` — Main Board UI (~989 lines)
- Renders Overview tab (aggregate metrics + optional charts) and one tab per pod
- Handles drag-and-drop card movement between columns
- Renders all charts directly in JavaScript (no charting library)
- Filtering by assignee, work item type, aged status, and free-text search

### `popup.js` — Quick Stats (~145 lines)
- Shows triage, WIP, ready-for-release, and aged counts per pod
- Weekly arrival rate with trend vs previous week
- Manual refresh button

### `options.js` — Settings Page (~185 lines)
- Organisation, project, PAT input and save
- Pod list management (add/edit/delete with colour picker)
- 12 optional overview chart toggles
- "Test Connection" validates PAT and area paths

## Architecture & Data Flow

```
Chrome Storage (local)
  └─ settings { org, project, pat, pods[], refreshInterval, overviewCharts }
  └─ cachedData { fetchedAt, pods: { [podId]: { items[], error } } }
  └─ arrivedAtCache { "podPath:itemId": ISO date }

background.js (service worker)
  ├─ chrome.alarms → fetchAllPods() every N minutes
  ├─ stores result in cachedData
  └─ broadcasts DATA_UPDATED to popup/board

shared.js (imported by all pages)
  └─ ADO REST API (dev.azure.com) — PAT Basic auth

board.js / popup.js
  ├─ reads cachedData from storage
  ├─ listens for DATA_UPDATED messages
  └─ renders UI
```

## Azure DevOps API Calls

All calls target `https://dev.azure.com/{org}/{project}/_apis/...`:

| Endpoint | Method | Purpose |
|---|---|---|
| `/wit/wiql` | POST | Query item IDs by area path |
| `/wit/workitemsbatch` | POST | Fetch details for up to 200 items |
| `/wit/workitems/{id}/updates` | GET | Trace state history for arrival dates |
| `/wit/workitems/{id}` | PATCH | Update item (partially stubbed) |
| `/_apis/projects/{project}/teams` | GET | List teams (for WIP limit resolution) |
| `/{team}/_apis/work/teamsettings/teamfieldvalues` | GET | Map area paths to teams |
| `/{team}/_apis/work/boards` | GET | List boards for a team |
| `/{team}/_apis/work/boards/{board}` | GET | Get board columns with WIP limits |

Authentication: `Authorization: Basic {base64(':' + pat)}`

## Configuration / Settings Schema

All configuration lives in `chrome.storage.local` — no `.env` file exists.

```javascript
// Settings object
{
  org: "myorganisation",
  project: "MyProject",
  pat: "personal-access-token",
  refreshInterval: 15,           // minutes
  pods: [
    { id: "uuid", name: "Team A", areaPath: "Project\\Team A", color: "#6366f1" }
  ],
  overviewCharts: {
    weeklyArrival: true,
    weeklyThroughput: true,
    cycleTimeScatter: true,
    // ... 9 more boolean flags
  }
}
```

PAT scope required: **Work Items (Read, Write)**

## Development Workflow

### No Build Step
This is plain vanilla JavaScript. Files are loaded directly by Chrome. There is:
- No npm / package.json
- No TypeScript compilation
- No bundler (webpack, vite, etc.)
- No test framework

### Loading the Extension Locally
1. Open `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked" → select the repo root
4. Click the extension icon → open Options → configure org, project, PAT, pods

### Packaging for Chrome Web Store
```bash
bash package.sh
```
Produces `kanban-manager.zip` ready for upload. The script excludes `*.pem`, `*.crx`, `*.sh`, and the `Documentation/` folder.

### Making Changes
1. Edit the relevant `.js` or `.html` file
2. Go to `chrome://extensions` and click the reload icon on the extension card
3. Reopen any popup or board pages to see changes

### No Automated Tests
There is no test suite. Verify changes manually:
- Load the extension in Chrome
- Open the board, popup, and options pages
- Use "Test Connection" in options to validate API access
- Check the browser console for errors

## Code Conventions

### JavaScript Style
- **ES6+** — async/await, arrow functions, optional chaining (`?.`), spread operator
- **No semicolons** — stylistic choice throughout the codebase (do not add them)
- **camelCase** — all function and variable names
- **UPPER_SNAKE_CASE** — module-level constants (e.g. `DEFAULT_SETTINGS`, `INACTIVE_COLUMNS`)
- **kebab-case** — HTML element IDs and CSS class names

### DOM Access
A `$()` helper is used as a shorthand for `document.getElementById()`:
```javascript
const $  = id => document.getElementById(id);
```

### Security — HTML Escaping
Always use `escHtml()` for content inserted into the DOM and `escAttr()` for HTML attribute values. **Never use raw string interpolation** for user-supplied or API-supplied data:
```javascript
`<div class="title">${escHtml(item.title)}</div>`
`<div data-id="${escAttr(item.id)}">`
```

### Naming Conventions for Functions
- `fetch*` — async functions that call the ADO API
- `calc*` — pure functions that compute analytics from cached data
- `render*` / `build*` — functions that produce HTML strings or manipulate the DOM
- `map*` — data transformation functions

### Async Patterns
- All async operations use `async/await`
- Concurrency is controlled manually using a queue pattern (`enrichWithArrivedAt` limits to 10 concurrent requests)
- Errors from individual pods are captured in `pod.error` and displayed as warnings, not thrown globally

### Storage Keys
| Key | Type | Purpose |
|---|---|---|
| `settings` | Object | User configuration |
| `cachedData` | Object | Latest fetched work item data |
| `arrivedAtCache` | Object | Per-item arrival date keyed by `"podPath:itemId"` |

### Arrival Date Logic
The arrival date is calculated by tracing an item's update history (`/updates` endpoint) to find when it first entered the active pod's area path or a non-inactive column. Results are cached in `arrivedAtCache` with a version key (`ARRIVED_CACHE_VERSION`). Cache entries are invalidated if the item's `changedDate` is more than 1 day after the cached arrival.

## Branch & Commit Strategy

- `master` is the stable release branch
- Feature branches use the prefix `claude/` for AI-assisted work
- Commit messages should be short and imperative (e.g. `Add cycle time chart to overview`)
- No git hooks or CI/CD pipelines are configured

## What NOT to Do

- **Do not add a build system** (no npm, webpack, TypeScript) unless the project scope changes significantly
- **Do not add external libraries** — the zero-dependency approach is intentional
- **Do not add a backend** — this extension is intentionally client-side only
- **Do not use `innerHTML` with unescaped data** — always use `escHtml()` / `escAttr()`
- **Do not add semicolons** to existing files (the style is semicolon-free)
- **Do not commit** `*.zip`, `*.crx`, or `*.pem` files (they are in `.gitignore`)

## Common Tasks

### Add a new chart to the Overview tab
1. Add a toggle key to `DEFAULT_SETTINGS.overviewCharts` in `shared.js`
2. Add a checkbox for it in `options.html` / `options.js`
3. Implement a `calc*()` function in `shared.js`
4. Call it and render the chart in the Overview section of `board.js`

### Add a new analytics metric
1. Implement a `calc*()` function in `shared.js` that takes `pods` (cachedData.pods) as input
2. Return a plain object/array of data points
3. Render in `board.js` or `popup.js` as needed

### Change the column ordering / mapping
- `COLUMN_ORDER` and `INACTIVE_COLUMNS` constants in `board.js` control column display
- State-to-column mapping is in `mapItem()` in `shared.js`

### Add a new pod setting field
1. Update `DEFAULT_SETTINGS.pods[*]` schema in `shared.js`
2. Update `options.html` and `options.js` to add the field to the pod edit form
3. Handle in `fetchPodData()` in `shared.js` if the field affects API queries
