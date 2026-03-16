# WIP Limit Feature — Implementation Plan

## Overview

Allow each pod to define optional per-column WIP limits. When a column's live item count
exceeds its configured limit, the column header turns red and shows an `X / limit` badge,
giving teams an immediate visual signal during standups and planning.

---

## Data Model

Add a `wipLimits` map to each pod object in settings:

```javascript
// settings.pods[i]
{
  id: "pod-abc",
  name: "Team A",
  areaPath: "Platform\\Team A",
  wipLimits: {
    "In Progress": 4,
    "Code Review": 3,
    "Ready for Test": 2
  }
}
```

- Keys are **exact board column names** (case-sensitive, matching `System.BoardColumn` values).
- A missing or zero value means no limit for that column.
- The map is optional — pods without it behave exactly as today.

---

## Options Page Changes

### Layout

Add a collapsible "WIP Limits" sub-section **inside each pod row**.

Current pod row:
```
[●] [Name input          ] [Area Path input                       ] [✕]
```

Proposed pod row (expanded):
```
[●] [Name input          ] [Area Path input                       ] [✕]
    ▼ WIP Limits (optional)
    [Column name  ][Limit  ] [+ Add limit]
    [Column name  ][Limit  ]
```

### Implementation notes

- The "WIP Limits" toggle expands/collapses inline below the pod row.
- Each limit row is a pair of text inputs: column name + numeric limit.
- Column names are free-text because they are only known at runtime (discovered from ADO data).
  As a convenience, pre-populate a "Common columns" hint: `In Progress, Code Review, Ready for Test`.
- An "Add limit" button appends a new blank row.
- Each limit row has a remove (✕) button.
- On save, the limit rows are read and serialised into the `wipLimits` map.

### options.js changes

1. In `renderPodList(pods)`: generate the WIP limit sub-section from `pod.wipLimits`.
2. In `readPods()`: collect limit rows per pod into the `wipLimits` map.
3. The add-pod inline handler also needs to include the limit sub-section stub.

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
/* Optional: subtle pulsing border on the whole column */
.column.wip-exceeded {
  border-top-color: #ef4444;
  box-shadow: 0 0 0 1px rgba(239,68,68,.3);
}
```

### buildPodPanel changes

When generating the column HTML, pass `pod.wipLimits` into `buildPodPanel` and check each
column against the limit:

```javascript
const limit = (pod.wipLimits || {})[col];
const count = byCol[col].length;
const overLimit = limit && count > limit;
const countLabel = limit ? `${count} / ${limit}` : count;
const exceededClass = overLimit ? ' wip-exceeded' : '';
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
    const colName = col.querySelector('.col-body')?.dataset.column;
    const limit = (pod.wipLimits || {})[colName];
    const visible = col.querySelectorAll('.card:not(.hidden)').length;
    col.querySelector('.col-count').textContent = limit ? `${visible} / ${limit}` : visible;
    const exceeded = limit && visible > limit;
    col.querySelector('.col-header').classList.toggle('wip-exceeded', exceeded);
    col.classList.toggle('wip-exceeded', exceeded);
  });
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
- **ADO board policy sync**: ADO itself supports WIP limits on its native board; this feature
  is independent and stored only in the extension's local settings.

---

## Estimated Change Surface

| File | Change |
|---|---|
| `shared.js` | Add `wipLimits: {}` to pod schema in `DEFAULT_SETTINGS` (1 line) |
| `options.html` | Add WIP limit sub-section HTML inside pod-row template |
| `options.js` | Update `renderPodList`, `readPods`, and add-pod handler |
| `board.js` | Update column header HTML, `updateColCounts`, overview pod card |

Approximately **~80–120 lines** across the four files. No new dependencies, no new API calls.

---

## Suggested Implementation Order

1. `shared.js` — schema change (trivial)
2. `options.js` / `options.html` — settings UI (most complex, ~60 lines)
3. `board.js` — column header rendering + `updateColCounts` update (~40 lines)
4. `board.js` — overview pod card warning badge (~10 lines)
