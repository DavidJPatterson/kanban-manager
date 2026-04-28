# Weekly Pod Status Update — Design Spec

**Date:** 2026-04-28
**Status:** Draft — pending review
**Trigger:** Leadership feedback that the existing weekly pod-status updates need work — surface progress, flag key issues, show what we're doing about them, and align format across the three unit leads.

---

## 1. Context

Three unit leads each run their own portfolio of pods using their own Chrome installation of the Kanban Manager extension:

- Unit A — 13 pods
- Unit B — 14 pods
- Unit C — 4 pods

Each lead presents *their own* pods only. They do not see each other's data. The "alignment" leadership asked for is **format alignment**: when the three weekly artifacts are read side by side, they have identical shape and emphasis.

Today, the extension's Executive Summary tab gives:

- Aggregate KPIs (arrival, throughput, cycle time, WIP, stale)
- Auto-insights (✅ ⚠️ 🔴) computed from data
- A free-text **Meeting Notes** textarea per pod

This is a telemetry panel, not a leadership report. There is no place to record curated progress, no structure for flagging issues, and **no concept of actions at all**. With 13 pods, three freeform notes textareas does not produce alignment, doesn't capture wins, and doesn't track whether anything actually got done week to week.

## 2. Goals

1. **Surface progress** — pod leads can record wins each week, with auto-suggested wins drawn from the data.
2. **Flag issues** — pod leads can record blockers/risks/watch-items each week with severity, owner, and a "needs leadership" flag.
3. **Track actions** — pod leads can record actions for the coming week, each with an owner and a due date. Actions that carry over from prior weeks are auto-flagged.
4. **Produce a leadership-ready PDF** — single artifact per unit per week, executive cut on page 1, pod detail thereafter.
5. **Align format across the three unit leads** — same fields, same PDF layout, every week, by virtue of every lead using the same code path.
6. **Build on what already exists** — reuse `calcExecInsights`, `calcWeeklyArrival`, `calcWeeklyThroughput`, holidays/team data, and the existing per-pod card chrome. No duplicate calculations, no parallel code paths.

## 3. Non-goals

- Cross-unit synchronisation. (Phase 2 if format sticks. Likely write to an ADO wiki page.)
- Markdown export. (PDF is the artifact leadership asked for.)
- Charts in the PDF. (Operational, not strategic. They live on the screen.)
- A separate Weekly Update tab. (Inline within Exec Summary.)
- Backend / cloud storage. (CLAUDE.md rule — no backend.)
- New libraries. (CLAUDE.md rule — no dependencies.)
- Changes to the popup. (At-a-glance view; weekly update lives on the board.)

## 4. Decisions log

| # | Decision | Alternatives considered | Why |
|---|----------|--------------------------|-----|
| 1 | Hybrid auto-draft + human curation | Pure manual; pure automated | Automation does grunt work; humans own the why and the what-we're-doing |
| 2 | Structured fields per category, not freeform | Freeform textarea; heavyweight status form with root-cause/DoD | Discipline with low ceremony |
| 3 | PDF export, native browser print | jsPDF / html2canvas / markdown | Zero deps; CLAUDE.md rule |
| 4 | Executive-cut PDF layout (not full data dump) | Print-as-screen; configurable export dialog | Skim-readable in 90 seconds is the whole point |
| 5 | Per-ISO-week storage, no auto-prune | Single overwriting record; rolling N weeks | History is the basis of carry-over detection and trend reporting |
| 6 | Inline on the Exec Summary tab; week dropdown for history; default to last completed week | Sub-tab; separate History tab | Avoids fragmenting the experience |
| 7 | Unit Headline section (Top 3 Wins/Issues/Actions) above per-pod detail | Per-pod only | 13 pods needs a unit-level narrative roll-up |
| 8 | Hide steady pods from PDF body; list in footer | Show all pods always | A 14-page "Steady — no notable updates" PDF is noise |
| 9 | Soft cap of 3 on unit headline counts | Hard cap | Don't lose information when there's a legitimate 4th |
| 10 | Finalised weeks are read-only; "Unlock" with confirmation | Hard immutable; no lock | Humans need to fix typos |
| 11 | Auto-save only (no Save Draft button) + "saved Xs ago" indicator | Manual save | Less clutter; matches existing notes textarea pattern |
| 12 | Auto-suggestions live (recomputed on render) for current + last completed week only; no suggestions on older weeks | Stored snapshots; suggestions on all weeks | Suggestions for historical weeks would reflect today's data — misleading |
| 13 | Auto-suggested actions enabled (7 trigger types) | Wins/issues only, no action suggestions | Actions are where alignment fails; reduce friction |
| 14 | Stale-state widening: include any state ∉ {Closed, Removed, Triage, New} | Active-only (status quo); all states | Resolved/QA Complete items languishing for weeks are real blockers |
| 15 | Team Leads as first-class concept in settings | Auto-populate owner from assignees only | Actions need clear accountable owners |
| 16 | PDF re-renders from current data on each export | Snapshot on Finalise | Trial cycle benefits from typo fixes; on-screen and PDF stay consistent |
| 17 | `weekly-update.js` as a separate module (not in shared.js) | Fold into shared.js | shared.js is already ~1,176 lines |
| 18 | Hard-block PDF export when Unit Name is empty | Soft warn | Unidentified PDFs defeat the alignment goal |
| 19 | Soft warn on PDF export when actions exist without team-lead owners | Hard block; no warn | Forces conversation without stopping the trial |
| 20 | Auto-tick Steady for pods paused for the full week | Manual only | Right default; reversible |

## 5. Data model

### 5.1 New storage key — `weeklyUpdates`

Sits alongside existing keys `settings`, `cachedData`, `arrivedAtCache`, `execSummaryNotes` in `chrome.storage.local`. Default: `{}`.

```javascript
weeklyUpdates: {
  "2026-W17": {
    weekStart: "2026-04-20",            // ISO Monday (yyyy-mm-dd)
    weekEnd:   "2026-04-26",            // ISO Sunday
    finalisedAt: "2026-04-28T09:14:00Z",  // null until Finalise clicked

    unitHeadline: {
      wins:    [WinEntry, ...],     // soft cap 3, no hard limit
      issues:  [IssueEntry, ...],
      actions: [ActionEntry, ...]
    },

    pods: {
      "<podId>": {
        steady: false,
        progress: [WinEntry, ...],
        issues:   [IssueEntry, ...],
        actions:  [ActionEntry, ...],
        suggestionsState: {
          promoted:  ["sugg-throughput-up", "sugg-stale-12345", ...],
          dismissed: ["sugg-cycle-time-down", ...]
        }
      }
    }
  },
  "2026-W16": { ... },
  ...
}
```

### 5.2 Entry shapes

```javascript
WinEntry = {
  id: "uuid",
  text: "Shipped 14 stories last week vs 8-week avg of 10",
  category: "Shipped" | "Unblocked" | "Improvement" | "Milestone" | null,
  workItemIds: [4521, 4530],
  sourcePodId: "pod-bravo-uuid"  // only on unitHeadline.wins when promoted from a pod
}

IssueEntry = {
  id: "uuid",
  text: "Item #4521 stale 12 days in QA Complete",
  severity: "blocker" | "risk" | "watch",
  workItemIds: [4521],
  owner: { kind: "lead" | "member" | "custom", id?: "uuid", name: "Lead Alpha" } | null,
  needsFromLeadership: false,
  sourcePodId: "pod-bravo-uuid"  // only on unitHeadline.issues when promoted
}

ActionEntry = {
  id: "uuid",
  text: "Triage QA-Complete backlog with QA team",
  owner: { kind: "lead" | "member" | "custom", id?: "uuid", name: "Lead Alpha" } | null,
  due: "this-week" | "next-week" | "YYYY-MM-DD",
  carriedFrom: "2026-W16" | null,  // populated automatically on save
  sourcePodId: "pod-bravo-uuid"  // only on unitHeadline.actions when promoted
}
```

### 5.3 Behaviours

- **Entry IDs** are UUIDs (`crypto.randomUUID()`) so individual entries can be edited or deleted without index shifts.
- **Carry-over detection on save:**
  for each action saved on week N, scan week N-1's actions; if any have the same text (case-insensitive, trimmed) and were not marked done, set `carriedFrom: "<N-1>"`. Surfaces in UI as a `↻ carried from W16` chip. No user input needed.
- **Carry-chain length:**
  computed by walking `carriedFrom` recursively at render time. A chain length ≥ 2 is what triggers the "Escalate stalled action" auto-suggestion.
- **Promote-to-headline copies text**, doesn't reference. `sourcePodId` is metadata only; editing the headline entry does not affect the source pod entry, and deleting the source pod entry does not break the headline entry.
- **`finalisedAt`:**
  set when "Finalise & Export PDF" is clicked. Once set, the form is read-only by default. "Unlock" button opens a confirmation dialog: *"This week was finalised on … . Edits will not be re-sent unless you re-export. Continue?"*. On confirm, form becomes editable; `finalisedAt` is **not** cleared (we want to know it was finalised, even if it's been edited since). A separate `lastEditedAt` field would be added later if it becomes useful — out of scope now.

### 5.4 Settings additions

Three new fields on the existing `settings` object:

```javascript
DEFAULT_SETTINGS.unitName: ""
DEFAULT_SETTINGS.teamLeads: []  // see 5.5

// Existing field reused (no new toggle):
DEFAULT_SETTINGS.executiveSummary: false  // unchanged; gates the whole exec summary tab
```

When `executiveSummary === true`, the new Weekly Update sections render. When `false`, the entire exec summary tab is hidden — no behaviour change vs today.

### 5.5 Team Lead schema

```javascript
TeamLead = {
  id: "uuid",
  name: "Lead Alpha",
  email: "lead.alpha@example.com",  // optional, used for tooltip only
  podIds: ["pod-bravo-uuid", "pod-charlie-uuid"]
}
```

A pod may have zero, one, or many team leads. A team lead may cover one or many pods. Many-to-many.

### 5.6 Migration

None. `weeklyUpdates: {}`, `unitName: ""`, `teamLeads: []` are new defaults. Existing users are unaffected on extension reload until they open the Exec Summary tab and start interacting with the new sections.

## 6. UI design

### 6.1 Exec Summary tab — restructured

Top-of-tab order:

```
[ Week selector: ◀ [Week of: 2026-W17 ▼] ▶  | Status: Draft / ✓ Finalised | Re-export PDF ]
[ Unit Headline ]
   Wins      [+ add]
   Issues    [+ add]
   Actions   [+ add]
[ Aggregate KPIs ]                  ← existing block, unchanged visually
[ Pods ]
   Pod Bravo  [ Steady ☐ ]  ▼
     ▶ Auto-suggestions (collapsed)
     Progress  [+ add]
     Issues    [+ add]
     Actions   [+ add]
     [ existing WoW table, predictability, predictions, Meeting Notes textarea — unchanged ]
   Pod Charlie ...
   ... 11 more pods ...
[ Steady this week footer ]
   Pod A · Pod F · Pod J · Pod M
[ Finalise & Export PDF ]           ← bottom of tab; mirrors the top button
```

- **Week selector:** dropdown lists every key in `weeklyUpdates` plus the current ISO week if not yet present, sorted descending. ◀ ▶ buttons jump to adjacent weeks.
- **Default selected week on tab open:** the most recent **completed** ISO week (i.e. for any day Mon–Sun, the previous Mon–Sun). This matches the meeting cadence — leads review last week's progress in this week's call.
- **Status badge:** `● Draft` (yellow) or `✓ Finalised <date>` (green).
- **Auto-save:** every input blur writes to `weeklyUpdates[weekKey]`. Indicator shows `saved 2s ago` next to the status badge. No manual save button.
- **Steady checkbox per pod:** ticking it collapses the entry forms and hides the pod from the PDF body. Existing pod-level entries are preserved (not deleted) and a soft warning shows if entries exist when Steady is ticked. Auto-ticked when the pod is paused for the entire selected week.
- **Auto-suggestions block:** collapsed `<details>` element per pod card. Three columns inside (Wins | Issues | Actions). Each suggestion has Promote / Dismiss / `✓ Added`. Suggestions are computed live for the current and last-completed week only.
- **Promote button** on every pod-level entry: copies the entry to the unit-headline section, preserving severity (for issues) and owner/due (for actions). Headline entry shows `from Pod Bravo` chip.
- **Read-only state when finalised:** all form controls disabled, `[+ add]` and `[×]` buttons hidden, Steady checkbox disabled. Single visible action: "Unlock" (with confirmation).

### 6.2 Owner picker

Dropdown shown when authoring an Issue or Action. Grouped, in this order:

1. **Team Leads for this pod** — name with 👑 chip
2. **Assignees observed in cached items for this pod**
3. **Other team leads** (assigned to other pods)
4. **+ Add custom owner** — opens a one-shot text input

Selection stores `{ kind, id?, name }`. Custom owners persist on the entry only — no global custom-owner list accumulates.

### 6.3 Auto-suggestion sources and rules

Wins (positive):
- Throughput up ≥ 25% vs 4-week average
- Cycle time improved by ≥ 1 day vs 4-week average
- Predictability rating improved a tier (Volatile → Moderate, Moderate → Stable)
- Pod health went from amber/red to green between weeks
- Zero items aged > 7 days (only suggested if last week had ≥ 3 such items)

Issues (warning/blocker):
- Throughput down ≥ 25% vs 4-week average
- Cycle time worsened by ≥ 1 day vs 4-week average
- Predictability rating dropped a tier
- Stale items present (count) — uses widened stale calc (Section 7)
- Items aged > 7 days (count)
- Bug ratio trend rising (existing calc)
- Pod paused with no `resumeDate` set
- WIP over column limit (where data available)

Actions (forward-looking):
- Issue with `severity: blocker` and **no matching action this week** → "Plan resolution for: *<issue text>*"
- Action carry chain ≥ 2 weeks → "Escalate stalled action: *<action text>*"
- Item Active with priority P1/P2 and **no assignee** → "Assign owner to P1/P2: #<id> *<title>*"
- Item stale ≥ 7 days → "Triage stale item: #<id> *<title>*"
- Predictability rating dropped → "Run predictability retro for *<pod name>*"
- Pod health went red and there's no blocker-severity issue logged this week → "Diagnose health drop for *<pod name>*"

Suggestion keys are deterministic (e.g. `"throughput-up"`, `"action-blocker-resolution-<issue-id>"`) so promote/dismiss state survives reloads and is matched against fresh recomputations.

Dismissal is **per week** — dismissing a suggestion in W17 does not dismiss it in W18; if the underlying condition still holds in W18 it is suggested again.

Thresholds reuse existing values in `calcExecInsights` — not re-tuned in this iteration.

### 6.4 Options page additions

Two new sections in `options.html`, mirroring the existing Pods management UI:

**Unit Name** — single text input, persisted to `settings.unitName`.

**Team Leads** — list/add/edit/delete. Each lead has name, optional email, multi-select pod picker (existing pods listed by name, multi-select).

## 7. Stale-state calculation widening

### 7.1 Current behaviour

`shared.js:727 calcStaleItems(items, staleDays)` filters to `i.state === 'Active'` only. Items in `Resolved`, `QA Complete`, `Ready for Release`, `In Review`, `In Progress`, etc. are excluded entirely from the stale check, regardless of how long they have sat there.

### 7.2 Change

A "terminal-or-intake" state is one of `{Closed, Removed, Triage, New}`. The stale set is **any item whose state is not terminal-or-intake AND whose `changedDate` age ≥ staleDays**.

Pseudocode:

```javascript
const NON_STALE_STATES = new Set(['Closed', 'Removed', 'Triage', 'New'])

function calcStaleItems(items, staleDays = 2) {
  const cutoff = Date.now() - staleDays * 86400000
  const inScope = items.filter(i => !NON_STALE_STATES.has(i.state))
  const stale = inScope.filter(i => new Date(i.changedDate).getTime() < cutoff)
  const blockedNotStale = inScope.filter(i =>
    new Date(i.changedDate).getTime() >= cutoff && isBlocked(i))
  // ... rest unchanged ...
}
```

### 7.3 Payload addition

The returned record gains `currentState` (string) alongside the existing `boardColumn`. PDF and exec-summary renders use this to display "stale 12 days in *QA Complete*" rather than just "stale 12 days".

### 7.4 Consumer trace (per CLAUDE.md project rule)

Every consumer of `calcStaleItems` output must be reviewed before merging:

1. `calcPodHealthStatus` (`shared.js:1017`) — uses `stale.total` and `stale.items` — still valid; widened set means health may go amber more often (correct).
2. `calcExecInsights` (`shared.js:1069`) — uses `stale.total` for the warning threshold — still valid.
3. Stale-items table renderer in `board.js` (around line 2114) — uses `staleDaysActual` and `boardColumn` — needs the new `currentState` to render the column-stuck label.
4. Popup display of aged counts (`popup.js`) — needs review; if it uses `calcStaleItems` output the counts will increase.
5. The new auto-suggestion engine — uses the widened set as its source for "Triage stale item" suggestions.

### 7.5 Breaking-change note

To be added to `CHANGELOG.md` and called out in release notes:

> Stale calculation now includes items in any non-terminal, non-intake state (was: Active only). This means items stuck in Resolved, QA Complete, Ready for Release, etc. past the threshold are now counted. Existing dashboards may show higher stale counts on next refresh — these items were always there, the calculation now surfaces them.

## 8. PDF export

### 8.1 Mechanism

Native browser print, no libraries.

1. User clicks **Finalise & Export PDF** (or **Re-export PDF** on a finalised week).
2. `weeklyUpdates[weekKey].finalisedAt` is set if not already (idempotent on re-export).
3. `chrome.tabs.create({ url: chrome.runtime.getURL('print-export.html') + '?week=2026-W17' })` opens the export page in a new tab.
4. `print-export.js` reads `?week=…` from URL, loads `settings` and `weeklyUpdates[weekKey]` from `chrome.storage.local`, renders the layout, then calls `window.print()` once render completes.
5. User chooses "Save as PDF" in the browser's print dialog. Suggested filename comes from `<title>`.

### 8.2 Layout (executive cut)

Page 1 — must fit A4 portrait at 11pt:

- **Header** — `Weekly Pod Status — <Unit Name>` · `Week of <date range>` · `Finalised <date>` · `Pods covered: 13 (4 with updates · 9 steady)`
- **Highlights** (Top 3 Wins) — `✅` bullets, with `from Pod X` chip if promoted
- **Key Issues** — severity icon + text + owner + `NEEDS LEADERSHIP` flag if set
- **Actions Next Week** — bullet, owner, due, `↻ carried` chip if applicable
- **At a Glance** — single line: `Arrival N (Δ vs prev wk) · Throughput N (Δ) · Cycle Time Nd (Δ) · Active WIP N · Stale/Blocked N`
- **Actions by team lead** — single line: `Lead Alpha 4 · Lead Bravo 2 · Lead Charlie 1 · Unassigned 1` (Unassigned in red if non-zero). Allowed to wrap to first row of page 2 if page 1 overflows; `page-break-inside: avoid` keeps it tidy.

Page 2 onward — Pod Detail:

- One section per pod that has entries this week
- Pod name + health dot + mini KPI strip (`arr 5/3 · tp 3/1 · cyc 4.2d`)
- Progress / Issues / Actions in the structured shape
- No charts, no predictability, no per-person throughput, no predictions

Final page footer — `Steady this week: Pod A · Pod F · Pod J · Pod M ...`

### 8.3 Print stylesheet

- A4 portrait, 18mm margins, 11pt body, 14pt section headers
- Severity colours (print-safe): blocker `#dc2626`, risk `#d97706`, watch `#0891b2`
- `page-break-after` on the page-1 header block; `page-break-inside: avoid` on each pod section and the actions-by-lead roll-up
- No interactive elements; layout is render-once, print, leave open for user to close

### 8.4 Document title (default save filename)

```
Weekly Pod Status — <Unit Name> — <ISO Week>.pdf
```

Example: `Weekly Pod Status — Acme Unit — 2026-W17.pdf`

### 8.5 Validation on Finalise / Export

- **Hard block:** `settings.unitName` empty → modal: *"Unit Name is required for PDF export. Set it in Options first."* Cancel / Open Options.
- **Soft block (warn but proceed):** any action exists this week with `owner` null → banner: *"3 actions have no owner assigned — proceed anyway?"* Yes / No. (Actions with a `custom` owner do *not* trigger the warning — typing a name is treated as an explicit ownership decision.)

### 8.6 Failure modes

- **Cached data missing for the selected week:** print page renders KPIs as `—` and shows a banner *"No cached data for this week — KPIs may be incomplete."*
- **Pod deleted between week and export:** rendered with `(pod removed)` annotation; entries are not dropped.
- **`window.print()` cancelled:** PDF wasn't generated; week still marked finalised. Re-export button on the exec summary handles re-runs without re-finalising.

### 8.7 manifest.json change

`print-export.html` and its assets must be reachable as `chrome.runtime.getURL`. Likely needs a `web_accessible_resources` entry; confirmed during the implementation plan stage.

## 9. Code structure

### 9.1 New files

| File | Purpose |
|------|---------|
| `weekly-update.js` | Core module: storage helpers (`getWeeklyUpdate`, `setWeeklyUpdate`, `listWeeks`, `weekKeyFor(date)`, `getCurrentWeekKey`, `getLastCompletedWeekKey`), suggestion engine wrappers, carry-over detection. Imported by `board.js` and `print-export.js`. |
| `print-export.html` | Standalone print page, loaded via `chrome.runtime.getURL`. Reads `?week=…`. |
| `print-export.js` | Renders executive PDF layout from storage data; calls `window.print()` after render. |
| `print-export.css` | Print stylesheet (A4 portrait, severity colours, page-break rules). Linked by `print-export.html`. |

### 9.2 Edited files

| File | Change summary |
|------|---------------|
| `shared.js` | Add `STORAGE_KEYS.weeklyUpdates`. Add `unitName`, `teamLeads` to `DEFAULT_SETTINGS`. Widen `calcStaleItems` per Section 7. Add `currentState` to its returned items. |
| `board.js` | Restructure `buildExecutiveSummaryPanel`: week selector, unit headline, per-pod structured-update sections above the existing WoW table, footer roll-up. Auto-suggestions block per pod card. Wire promote / dismiss / save / finalise / re-export handlers. Hard-block PDF export on empty `unitName`. Existing per-pod metrics, predictions, predictability, meeting-notes textarea remain in place. |
| `options.html` / `options.js` | New "Unit Name" input. New "Team Leads" management section (parallels existing Pods section: list / add / edit / delete; multi-select pod picker per lead). |
| `manifest.json` | `web_accessible_resources` entry for `print-export.html` and assets. |
| `popup.js` / `popup.html` | No changes. |
| `CHANGELOG.md` | Entry covering: structured weekly update, PDF export, team leads, stale-state widening (with the breaking-change note from Section 7.5). |

### 9.3 Module boundaries

`weekly-update.js` exposes a small surface that `board.js` consumes:

```javascript
// Storage
getWeeklyUpdate(weekKey)         // returns the stored object or a fresh empty shape
setWeeklyUpdate(weekKey, data)
listWeeks()                      // sorted desc, includes current week if not yet stored

// Week math
weekKeyFor(date)                 // ISO YYYY-Www
getCurrentWeekKey()
getLastCompletedWeekKey()
weekRange(weekKey)               // { start: Date, end: Date, label: string }

// Carry-over
detectCarryOver(actions, prevWeekActions)   // returns same array with `carriedFrom` populated
carryChainLength(action, allWeeklyUpdates)  // recursive walk

// Suggestions
buildSuggestions(pod, cachedData, settings, holidays, prevWeek)
  // returns { wins: [], issues: [], actions: [] } with deterministic keys
```

`print-export.js` consumes the same module plus a render-only helper:

```javascript
renderPdf(weekKey, weeklyUpdate, settings, cachedData)
  // Mutates document body. Calls window.print() once layout settles.
```

This keeps `board.js` from owning storage logic, and keeps `print-export.js` from re-deriving week math.

## 10. Testing approach

The project has no automated test suite (per CLAUDE.md). Verification is manual.

1. **Reload-and-test loop** — `chrome://extensions` → reload, exercise each new flow.
2. **Three-surface verification per the project rule** — Exec Summary tab, board tabs, popup. The widened stale calculation is the highest-risk change and propagates to popup health dots and pod health badges; verify counts before/after on a real cached dataset.
3. **Print-preview QA** — DevTools "Emulate CSS print" plus actual `window.print()` to PDF. Verify page 1 fits A4 portrait at 11pt for representative pod counts (small/medium/large units).
4. **Storage quota check** — after several synthetic weeks, confirm `weeklyUpdates` size stays well below 100KB. At ~13 pods × ~10 entries × 52 weeks, expected ≪ 1MB even pessimistically.
5. **Carry-over correctness** — author identical-text actions across two consecutive weeks, verify `carriedFrom` populates on save without user input.
6. **Lock/unlock flow** — Finalise, verify read-only. Unlock, confirm dialog, edit, verify auto-save still works. Re-export PDF, verify changes propagate.

## 11. Open items for phase 2

These were explicitly deferred and are listed here so they don't get lost:

- **Cross-unit synchronisation** — likely write to an ADO wiki page or a designated "Weekly Pod Status" tracking work item. Adopt only if the format proves itself in trial.
- **Auto-suggestion threshold tuning** — left at existing `calcExecInsights` values; revisit if trial shows too much / too little signal.
- **Per-entry "done" marking on actions** — would let next-week's carry-over detection skip explicitly-completed actions even if rephrased. Currently relies on text match.
- **Cycle-time auto-suggestion thresholds** — currently 1-day delta; may need calibration once more historical data is available.
- **Click-through from PDF to ADO work items** — PDFs lose hyperlinks when printed via the dialog in some setups. If becomes an issue, consider rendering work item IDs as plain text with full URL in a footnote.

## 12. Definition of done

- Weekly Update sections render on the Exec Summary tab when `executiveSummary === true`.
- A unit lead can author / edit / promote / finalise a week's entries end to end.
- A finalised week produces a PDF that fits the layout in Section 8.2.
- Auto-suggestions appear on current and last-completed weeks, with deterministic promote/dismiss state.
- Stale calculation includes the widened state set; all five consumers (Section 7.4) are reviewed and updated.
- Team Leads can be managed in Options; owner picker uses them with the priority order in Section 6.2.
- All three UI surfaces (exec summary, board tabs, popup) verified after the stale-calc change.
- CHANGELOG entry written, including the breaking-change note.
