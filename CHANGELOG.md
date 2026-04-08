# Changelog

All notable changes to Kanban Manager are documented here.

---

## [1.3.0] — 2026-04-08

### Added

- **Executive Summary: last week vs week before** — All metrics now compare the last completed week against the week before, instead of the current (incomplete) week. Current week arrival and throughput are shown as secondary "this week so far" values with bug/story splits.
- **Executive Summary: averages** — Aggregate KPI cards and per-pod WoW tables now show an 8-week rolling average for Arrival, Throughput, and TP/Person, giving historical context to weekly figures.
- **Executive Summary: throughput per person** — New aggregate KPI card and per-pod WoW table row showing throughput divided by active contributors.
- **Executive Summary: bug/story splits** — Arrival, Throughput, and Active WIP aggregate cards now break down totals by work item type (bugs vs stories), including this-week splits.
- **Executive Summary: work item breakdown per pod** — Each pod card now shows active item counts by type (Bug/Story/Other) and priority (P1–P4) as colour-coded badges.
- **Executive Summary: backlog count** — Active WIP card now shows items in backlog (not in progress) with bug/story split, replacing the less useful "total active" count.
- **Executive Summary: clickable stale/blocked items** — Stale/Blocked KPI card now shows individual work item IDs as clickable links to Azure DevOps, colour-coded by type (red = bug, blue = story).
- **Executive Summary: per-pod insights** — Auto-generated insights (throughput changes, demand vs capacity, stale items, bug ratio, zero WIP) are now shown inside each pod card instead of as a flat list at the top.
- **Executive Summary: pod paused state** — Pods can be marked as "paused" (e.g. team on bug rotation) via the Team page. Paused pods load collapsed in the exec summary with a "Paused · resumes 6 May" label, dimmed styling, and all alerts suppressed.
- **Team Management page** — New `team.html` page accessible via "👥 Team" button in the board header. Auto-fetches team members from Azure DevOps per pod, with "Sync All Pods" for first-time setup.
- **Holiday scheduling** — Per-member holiday date ranges managed on the Team page. Holidays surface as info callouts in exec summary pod cards ("John off 8–10 Apr"). Multi-day absences with active WIP trigger warnings. Single-day absences (public holidays) generate softer messaging.
- **Pod pause toggle** — Team page includes a per-pod "Pod paused" checkbox with optional resume date, for teams temporarily not producing (e.g. bug rotation).
- **`info` insight type** — New blue-coloured insight type for informational callouts (holidays, capacity notes), sorted between warnings and positive insights.

### Improved

- **Executive Summary: pod ordering stable** — Exec summary pod cards now use the settings-sorted pod array instead of `Object.values(cachedData.pods)`, fixing random reordering on refresh.
- **Executive Summary: aged threshold** — Changed from >90 days (useless) to >7 days (actionable).
- **Executive Summary: percentage change in WoW table** — Per-pod delta column now shows percentage alongside absolute change (e.g. "↓2 (40%)").
- **Executive Summary: risk item styling** — Pod risk items now use the same left-border colour treatment as aggregate insights, with type-specific colours and light theme support.
- **Executive Summary: predictability badge** — Replaced inline `style=` with `data-rating` CSS attribute selectors for Stable/Moderate/Volatile states.
- **Executive Summary: WoW avg column** — Replaced inline `style=` with `.exec-wow-avg` CSS class.
- **Executive Summary: notes textarea** — Increased min-height from 3rem to 5rem for more usable meeting notes.
- **Holiday date UX** — Changing the "from" date on a holiday period auto-updates the "to" date if it would be earlier, so single-day holidays only need one click.
- **Team page loads collapsed** — All pod sections on the Team page load collapsed by default.
- **Package script** — `team.html` and `team.js` added to `package.sh` for Chrome Web Store builds.

### Fixed

- **Overview pod ordering** — Pod summary cards and Flow by Pod charts now respect settings order. Previously only tabs were sorted; the overview panel independently derived pods from the raw cache object in arbitrary order.
- **`_podPaused` rendered as team member** — The pod pause metadata stored in the holidays object is now filtered out when rendering the member list and counting members.

---

## [1.2.0] — 2026-03-30

### Added

- **Stale & Blocked Items table** — Replaces the old stale items bar chart with a scrollable, clickable table. Each row links directly to the ADO work item. Items are labelled as Stale or Blocked with colour-coded badges, sorted with blocked items first.
- **Blocked item detection** — Items are detected as blocked via board column name, swim lane, or a "Blocked" tag. Blocked items always appear in the table regardless of the stale threshold.
- **Configurable stale threshold** — New "Stale item threshold" setting in Options (1–14 days, default 2). Replaces the hardcoded 14-day threshold.
- **Unit test suite** — Lightweight HTML test runner (`test.html`) with 50+ tests covering all pure `calc*()` functions, `escSvg`, `hashStr`, `assigneeColor`, and stale/blocked detection. No dependencies — open in Chrome to run.

### Improved

- **Fetch timeout protection** — All ADO API calls now abort after 15 seconds via `AbortController`, preventing indefinitely hung refreshes.
- **SVG escaping** — All user/API-derived text in chart rendering is now escaped via `escSvg()`, closing a potential XSS vector in SVG label interpolation.
- **Deterministic assignee colours** — Colours are now assigned via a stable hash (djb2) instead of insertion order. Same person always gets the same colour across page reloads.
- **Pod tab order preserved** — Tabs no longer scramble after background refresh. Pods are sorted by settings order before rendering.
- **404 handling for deleted pods** — Pods whose ADO area path returns 404 are skipped on subsequent refresh cycles instead of retrying every cycle. Cleared automatically when settings are saved.
- **Centralised storage keys** — All `chrome.storage` key strings consolidated into a `STORAGE_KEYS` constant across all files.
- **JSDoc on complex functions** — `adoFetch`, `enrichWithArrivedAt`, `enrichWithStartedAt`, `fetchPodData`, `fetchAllPods`, `calcCycleTimes`, and all chart renderers now have JSDoc documentation.

### Fixed

- **Clean first-run setup** — Options page no longer pre-fills with placeholder values. New installs start blank and ready for your own organisation.
- **Work item links corrected** — Cards on the board now link to your Azure DevOps organisation correctly in all cases. Previously links were built from a default value rather than your configured organisation.
- **Age tracking now uses board arrival date** — Item age is measured from when a card entered the board, not when it was created. Aged-item highlighting is now meaningful for long-lived backlog items.
- **Cycle time accuracy improved** — Items that are sent back from review and reactivated now report cycle time from their most recent In Progress start. Previously this silently overstated cycle times for bounced items.
- **Area paths with apostrophes now work** — Team or area path names containing an apostrophe (e.g. `David's Team`) previously caused WIQL queries to fail silently. These are now correctly escaped.
- **Team loading no longer truncates at 100** — Organisations with more than 100 teams were silently missing teams from WIP limit resolution. The API call now requests up to 500 teams.
- **Stale items only tracks Active work items** — Previously counted items in queue states (New, Ready, Triage) which are not genuinely stale.

---

## [1.1.0] — 2026-03-20

### Added

- **Priority age distribution chart** — Overview tab now includes a chart breaking down work item age by priority, making it easy to spot high-priority items that have been sitting too long.
- **Cumulative Flow Diagram (CFD)** — New optional overview chart showing item counts per column over time, surfacing flow bottlenecks and scope changes.
- **WIP limits from Azure DevOps** — Per-column WIP limits are now read directly from your ADO board configuration rather than stored locally. Columns highlight red when the limit is exceeded, with live updates as you drag cards and apply filters.
- **Persisted filters** — Active filter selections and search text are saved and restored across sessions. No more re-applying the same filters every time you open the board.
- **Drag-and-drop revert on failure** — If an ADO update fails after dragging a card, the card automatically snaps back to its original position. No silent data loss.
- **Throughput chart: stacked Resolved/Closed** — The throughput bar chart now shows Resolved and Closed items as two stacked segments, giving a clearer breakdown of completion type per week.
- **Throughput per person** — Throughput chart switched to items-per-contributor per week with a dashed average line across all weeks, making team-level capacity trends readable without exposing individual names.
- **Sparkline on popup arrival rate** — The quick-stats popup now includes a small sparkline alongside the weekly arrival figure to show trend direction at a glance.
- **Light/dark theme toggle** — Persistent theme preference with a `Ctrl+Shift+T` keyboard shortcut. All colours converted to CSS variables for consistent theming across all pages.
- **Loading skeletons** — Board and popup show shimmer placeholders while data loads rather than a blank screen.
- **Automated Chrome Web Store publishing** — GitHub Actions workflow to package and publish to the Chrome Web Store automatically on release creation.

### Improved

- **ADO API retry logic** — `adoFetch()` now retries up to 3 times with exponential backoff (1s / 2s / 4s) on network errors and 5xx/429 responses. 4xx errors fail immediately.
- **Typography and spacing** — Font sizes consolidated to a 6-step scale. Increased card padding and column spacing for better readability.
- **Chart tooltips** — Hover tooltips on bar and line chart data points. Tooltip clipping on viewport edges fixed.
- **Chart visual polish** — Area fills under line charts, average line overlays on arrival rate and throughput charts, improved scatter dot visibility, lighter dashed grid lines.
- **Accessibility** — `:focus-visible` outlines added throughout for keyboard navigation.
- **Options page layout** — Two-column layout on screens wider than 800px.
- **Popup responsiveness** — Minimum width 320px, maximum 420px.

---

## [1.0.0] — 2026-03-16

Initial release.

### Features

- **Multi-pod Kanban board** — Configurable pods mapped to Azure DevOps area paths, each rendered as a swimlane of columns with work item cards.
- **Drag-and-drop** — Move cards between columns with ADO state updates via PATCH.
- **Arrival rate** — Weekly item arrival counts with trend vs the previous week.
- **Throughput** — Weekly completed item counts across the overview and per pod.
- **Cycle time scatter** — Scatter plot of cycle time (days) per completed item over the past 12 weeks.
- **Per-person charts** — Throughput, closed, and resolved breakdowns by assignee.
- **Health charts** — WIP trend, age distribution, flow efficiency, stale items, bug ratio, throughput predictability, burndown by Target PI.
- **Auto-refresh** — Background polling via Chrome alarms at a configurable interval, with live updates pushed to open board and popup pages.
- **Filters** — Filter by assignee, work item type, aged status, and free-text search.
- **Quick-stats popup** — At-a-glance triage, WIP, ready-for-release, and aged counts per pod.
- **12 optional overview charts** — Each chart independently toggled in Options.
- **Zero dependencies** — No build step, no external libraries. Plain ES6+ loaded directly by Chrome.
