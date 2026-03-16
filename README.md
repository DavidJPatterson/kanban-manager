# Kanban Manager

A Chrome extension that provides a multi-pod Kanban dashboard with flow metrics, cycle time analytics, and health charts for Azure DevOps.

## Features

- **Multi-pod overview** — track multiple teams/area paths from a single dashboard
- **Full Kanban board** with drag-and-drop column transitions
- **Flow metrics** — arrival rate, throughput, week-on-week trends
- **Cycle time** — scatter plots for In Progress-to-Closed and Arrival-to-Closed
- **Per-person analytics** — throughput, items closed, items resolved with sparklines
- **Health charts** — WIP trend, age distribution, flow efficiency, stale items, bug ratio, throughput predictability
- **Burndown** — by Target PI with ideal-line overlay
- **Filters** — by assignee, type, aged items, free-text search
- **Auto-refresh** — configurable background polling
- **Quick popup** — key stats at a glance

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
