/**
 * UX-001 — analytics event store (structure only; no UI).
 * Browser: localStorage. Node: in-memory (tests / future).
 */
const STORAGE_KEY = "aikido-dashboard-analytics-v1";
const MAX_EVENTS = 500;

function createDashboardAnalytics(options = {}) {
  /** @type {object[]} */
  let memory = Array.isArray(options.events) ? options.events.slice() : [];
  const storage = options.storage || null;

  function load() {
    if (!storage || typeof storage.getItem !== "function") return memory.slice();
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_error) {
      return [];
    }
  }

  function save(events) {
    memory = events.slice(-MAX_EVENTS);
    if (storage && typeof storage.setItem === "function") {
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify(memory));
      } catch (_error) {
        // ignore quota
      }
    }
    return memory;
  }

  /**
   * @param {"generated"|"selected"|"published"|string} name
   * @param {object} [payload]
   */
  function track(name, payload = {}) {
    const event = {
      name: String(name || "event"),
      at: new Date().toISOString(),
      ...(payload && typeof payload === "object" ? payload : {}),
    };
    const events = load();
    events.push(event);
    save(events);
    return event;
  }

  function list() {
    return load();
  }

  function clear() {
    return save([]);
  }

  return {
    STORAGE_KEY,
    track,
    list,
    clear,
  };
}

function createBrowserDashboardAnalytics() {
  const storage =
    typeof localStorage !== "undefined" ? localStorage : null;
  return createDashboardAnalytics({ storage });
}

module.exports = {
  STORAGE_KEY,
  MAX_EVENTS,
  createDashboardAnalytics,
  createBrowserDashboardAnalytics,
};
