# Privacy Policy — Kanban Manager

**Last updated:** 16 March 2026

## What data does Kanban Manager collect?

Kanban Manager does **not** collect, transmit, or store any personal data on external servers. All data remains on your local machine.

## Data stored locally

The extension stores the following in Chrome's local extension storage (`chrome.storage.local`):

| Data | Purpose |
|------|---------|
| Azure DevOps organisation name | To construct API requests |
| Azure DevOps project name | To construct API requests |
| Personal Access Token (PAT) | To authenticate with Azure DevOps APIs |
| Pod/team configuration | To query the correct area paths |
| Cached work item data | To display the board without re-fetching on every page load |
| User preferences | Chart toggles, refresh interval |

## Where is data sent?

Your PAT and queries are sent **only** to the Azure DevOps REST API (`https://dev.azure.com`) to fetch work item data. No data is sent to any other server, analytics service, or third party.

## Permissions explained

| Permission | Why it's needed |
|------------|----------------|
| `storage` | To persist your settings and cached data locally |
| `alarms` | To schedule background data refreshes |
| `host_permissions: dev.azure.com` | To make API calls to Azure DevOps |

## Data retention

All data is stored locally in your browser. Uninstalling the extension removes all stored data. You can also clear cached data at any time by saving settings (which triggers a cache clear and fresh fetch).

## Third-party services

Kanban Manager does not integrate with any analytics, telemetry, crash reporting, or advertising services.

## Contact

If you have questions about this privacy policy, please open an issue on the [GitHub repository](https://github.com/DavidJPatterson/kanban-manager/issues).
