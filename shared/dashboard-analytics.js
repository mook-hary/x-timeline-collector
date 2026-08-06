/**
 * UX-001 — browser analytics shim (loads structure for Generate/Select/Publish).
 */
(function (global) {
  const STORAGE_KEY = "aikido-dashboard-analytics-v1";
  const MAX_EVENTS = 500;

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_error) {
      return [];
    }
  }

  function save(events) {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(events.slice(-MAX_EVENTS))
      );
    } catch (_error) {
      // ignore
    }
  }

  function track(name, payload) {
    const events = load();
    const event = {
      name: String(name || "event"),
      at: new Date().toISOString(),
      ...(payload && typeof payload === "object" ? payload : {}),
    };
    events.push(event);
    save(events);
    return event;
  }

  global.DashboardAnalytics = {
    STORAGE_KEY,
    track,
    list: load,
    clear: () => save([]),
  };
})(window);
