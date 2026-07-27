/**
 * Local mock DB for offline UI demo (no network).
 * Persists in storage so logout/re-login can reuse the same mock user when desired.
 */
const STORE_KEY = "suanben_mock_db_v1";

function emptyDb() {
  return {
    users: {},
    sessions: {},
    classes: [],
    memberships: [],
    questions: [],
    assignments: [],
    submissions: [],
    nextSeq: 1,
  };
}

function load() {
  try {
    const raw = wx.getStorageSync(STORE_KEY);
    if (raw && typeof raw === "object" && raw.users) return raw;
  } catch (_) {
    /* ignore */
  }
  return emptyDb();
}

function save(db) {
  try {
    wx.setStorageSync(STORE_KEY, db);
  } catch (_) {
    /* ignore */
  }
}

function id(prefix) {
  const db = load();
  const n = db.nextSeq || 1;
  db.nextSeq = n + 1;
  save(db);
  return `${prefix}_mock_${n}_${Date.now().toString(36)}`;
}

function reset() {
  save(emptyDb());
}

module.exports = { load, save, id, reset, emptyDb, STORE_KEY };
