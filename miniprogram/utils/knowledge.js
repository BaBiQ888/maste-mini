const { request } = require("./request");
const { logError } = require("./errors");

/** @type {Record<string, { name: string, pathLabel: string }>} */
const labelCache = Object.create(null);

/**
 * Resolve knowledge node id → display labels (cached).
 * @param {string} id
 * @returns {Promise<{ name: string, pathLabel: string }|null>}
 */
async function resolveKnowledgeLabel(id) {
  if (!id) return null;
  if (labelCache[id]) return labelCache[id];
  try {
    const data = await request({
      url: `/api/v1/knowledge-nodes/${encodeURIComponent(id)}`,
      method: "GET",
    });
    const n = data && data.node;
    if (!n) return null;
    const pack = {
      name: n.name || id,
      pathLabel: n.pathLabel || n.name || id,
    };
    labelCache[id] = pack;
    return pack;
  } catch (e) {
    logError("knowledge.resolve", e, { id });
    return null;
  }
}

/**
 * Enrich a list of items that have knowledgeNodeId with knowledgeLabel.
 * @param {Array<{ knowledgeNodeId?: string|null }>} items
 */
async function attachKnowledgeLabels(items) {
  const list = Array.isArray(items) ? items : [];
  const ids = [];
  const seen = Object.create(null);
  for (const it of list) {
    const id = it && it.knowledgeNodeId;
    if (id && !seen[id] && !labelCache[id]) {
      seen[id] = true;
      ids.push(id);
    }
  }
  await Promise.all(ids.map((id) => resolveKnowledgeLabel(id)));
  return list.map((it) => {
    const id = it && it.knowledgeNodeId;
    const pack = id ? labelCache[id] : null;
    // Never surface raw technical ids to UI
    return {
      ...it,
      knowledgeLabel: pack ? pack.name : "",
      knowledgePath: pack ? pack.pathLabel : "",
    };
  });
}

module.exports = {
  resolveKnowledgeLabel,
  attachKnowledgeLabels,
};
