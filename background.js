// background.js — Service worker: auto-refresh alarm + data caching (v3)
importScripts('shared.js');

const ALARM_NAME = 'kanban-refresh';

chrome.runtime.onInstalled.addListener(() => {
  scheduleAlarm();
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM_NAME) {
    refreshData();
  }
});

// Reschedule alarm whenever settings change
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    scheduleAlarm();
  }
});

// Allow popup/board to trigger a manual refresh
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'REFRESH') {
    refreshData()
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true; // keep channel open for async response
  }
  if (msg.type === 'GET_STATUS') {
    getCachedData().then(data => sendResponse({ data }));
    return true;
  }
});

async function scheduleAlarm() {
  await chrome.alarms.clear(ALARM_NAME);
  const settings = await getSettings();
  const mins = Math.max(1, settings.refreshInterval || 15);
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: mins });
}

async function refreshData() {
  try {
    const settings = await getSettings();
    if (!settings.pat || !settings.pods?.length) return;
    const previous = await getCachedData();
    const data = await fetchAllPods(settings, previous);
    await setCachedData(data);
    chrome.runtime.sendMessage({ type: 'DATA_UPDATED', data }).catch(() => {});
  } catch (err) {
    console.error('[Kanban] refresh failed:', err);
    const existing = await getCachedData();
    if (existing) {
      await setCachedData({ ...existing, lastError: err.message, errorAt: new Date().toISOString() });
    }
  }
}
