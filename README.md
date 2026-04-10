# Kanban Manager

A Chrome extension that provides a multi-pod Kanban dashboard with flow metrics, cycle time analytics, predictions, and health charts for Azure DevOps.

## Features

### Executive Summary

A meeting-ready view designed for stand-ups and leadership reviews.

- **All Pods aggregate KPIs** — Arrival, Throughput, Throughput/Person, Active WIP, and Stale/Blocked cards comparing last week vs week before with averages and this-week live counts
- **Cycle time badge** — Average days from Active/In Progress to Closed displayed as a prominent stat on the Throughput card
- **Per-pod week-over-week tables** — Arrival, Throughput, TP/Person, Cycle Time, Triage, and Aged >7d with change deltas, percentage shifts, and rolling averages
- **Auto-generated insights** — Throughput changes, demand vs capacity warnings, stale items, bug ratio alerts, and zero-WIP flags per pod
- **Throughput predictions** — Pessimistic/likely/optimistic forecasts (25th/50th/75th percentiles) with backlog drain estimates, net flow direction, and 2-week/4-week delivery forecasts
- **Holiday-aware forecasts** — Predictions normalize historical throughput by team capacity so holiday weeks don't drag down baselines. Forward forecasts scale by upcoming capacity with notes showing who's off and percentage capacity
- **Predictability scoring** — Coefficient of variation rating (Stable/Moderate/Volatile) per pod
- **Meeting notes** — Per-pod textarea for talking points, persisted across sessions
- **Pod pause state** — Paused pods load collapsed with a resume date, all alerts suppressed

### Team Management

- **Team member sync** — Fetch members from Azure DevOps per pod with one-click sync
- **Holiday scheduling** — Per-member date ranges that surface as info callouts in the Executive Summary, drive capacity warnings, and feed into holiday-aware predictions
- **Pod pause toggle** — Mark pods as temporarily inactive with an optional resume date

### Kanban Board

- **Multi-pod tabs** — Configurable pods mapped to Azure DevOps area paths, each rendered as a swimlane of columns with work item cards
- **Drag-and-drop** — Move cards between columns with ADO state updates, automatic revert on failure
- **WIP limits** — Sourced live from ADO board policies; columns turn red when limits are exceeded
- **Filters** — By assignee, type, aged items (>7d), and free-text search with persisted filter state
- **Stale & Blocked table** — Clickable table with direct ADO links, colour-coded Stale/Blocked badges, configurable threshold (1-14 days)

### Flow Metrics & Charts

- **Arrival rate** — Weekly item arrival counts with week-on-week trends
- **Throughput** — Weekly completed items with stacked Resolved/Closed segments
- **Throughput per person** — Items per contributor per week with average line
- **Cycle time** — Scatter plots for In Progress-to-Closed and Arrival-to-Closed
- **Per-person analytics** — Throughput, items closed, items resolved with sparklines
- **Health charts** — WIP trend, age distribution, flow efficiency, stale items, bug ratio, throughput predictability, priority age distribution, cumulative flow diagram
- **Burndown** — By Target PI with ideal-line overlay
- **12 optional overview charts** — Each independently toggled in Options

### General

- **Auto-refresh** — Configurable background polling with ADO retry and exponential backoff
- **Quick-stats popup** — Triage, WIP, ready-for-release, aged counts, and arrival sparkline at a glance
- **Light/dark theme** — Persistent preference with `Ctrl+Shift+T` toggle
- **Loading skeletons** — Shimmer placeholders while data loads
- **Zero dependencies** — No build step, no external libraries. Plain ES6+ loaded directly by Chrome

## Installation

### From source (developer mode)

1. Clone this repository
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the cloned folder
5. Pin the extension for easy access

### Setup

1. Click the extension icon and go to **Settings**
2. Enter your Azure DevOps organisation, project, and PAT
3. Add your pods (each maps to an ADO area path)
4. Click **Test Connection**, then **Save**

Your PAT needs the **Work Items (Read, Write)** scope. Generate one at your org's `_usersSettings/tokens` page.

## Privacy

All data stays on your machine. The extension only communicates with `dev.azure.com` — no analytics, no telemetry, no third parties. See [PRIVACY.md](PRIVACY.md) for details.

## Support

- **Issues & feature requests**: [GitHub Issues](https://github.com/DavidJPatterson/kanban-manager/issues)
- **Consulting & custom development**: [pattersondavid74+kanban@gmail.com](mailto:pattersondavid74+kanban@gmail.com)
- **Sponsor this project**: [GitHub Sponsors](https://github.com/sponsors/DavidJPatterson)

## License

[MIT](LICENSE)
