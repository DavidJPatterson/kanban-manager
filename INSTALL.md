# Kanban Manager — Chrome Extension

## Installation

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (toggle, top-right)
3. Click **Load unpacked**
4. Select the extension folder
5. The extension appears in your toolbar (pin it for easy access)

## First-time Setup

1. Click the extension icon → **Configure →**
   (or right-click the icon → **Options**)
2. Fill in:
   - **Organisation**: your Azure DevOps org (e.g. `amcsgroup`)
   - **Project**: your project name (e.g. `Platform`)
   - **Pods**: add one or more pods with their ADO area paths
   - **PAT**: generate at your org's `_usersSettings/tokens` page
     - Required scope: **Work Items (Read, Write)**
3. Click **Test Connection** to verify
4. Click **Save Settings**

Data loads automatically and refreshes every 15 minutes (configurable).

## Features

- **Popup**: Quick stats — triage count, WIP, aged items, arrival rate trends
- **Full Board** (`Open Board →`): Full kanban with drag-and-drop, filters by assignee / aged / type
- **Flow Metrics**: Arrival rate, throughput, cycle time, throughput by person, and more
- **Health Charts**: WIP trend, age distribution, flow efficiency, stale items, bug ratio, predictability
- **Multi-pod**: Track multiple teams/pods with per-pod and aggregate views
- **Auto-refresh**: Chrome alarm fires in the background; board updates live while open

## Updating After Code Changes

In `chrome://extensions`, click the **↻ refresh** icon next to the extension.
