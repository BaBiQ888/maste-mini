import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppError } from "../../domain/shared/errors.js";

export type NodeType = "grade" | "unit" | "knowledge";

export interface KnowledgeNode {
  id: string;
  type: NodeType;
  grade: number;
  name: string;
  parentId: string | null;
  sort: number;
  enabled: boolean;
  tags?: string[];
  suggestedDrillOps?: string[];
}

export interface PublicKnowledgeNode extends KnowledgeNode {
  unitName?: string | null;
  gradeName?: string | null;
  pathLabel?: string;
}

interface TreeFile {
  version?: string;
  nodes: KnowledgeNode[];
}

let cache: {
  nodes: KnowledgeNode[];
  byId: Map<string, KnowledgeNode>;
} | null = null;

function loadTree(catalogPath?: string): {
  nodes: KnowledgeNode[];
  byId: Map<string, KnowledgeNode>;
} {
  if (cache && !catalogPath) return cache;

  const candidates = [
    catalogPath,
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../../packages/content/knowledge-tree.json",
    ),
    path.join(process.cwd(), "packages/content/knowledge-tree.json"),
    path.join(process.cwd(), "content/knowledge-tree.json"),
    path.join(process.cwd(), "server/content/knowledge-tree.json"),
  ].filter(Boolean) as string[];

  let raw: string | null = null;
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      raw = fs.readFileSync(p, "utf8");
      break;
    }
  }
  if (!raw) {
    throw new AppError("CATALOG_MISSING", "找不到 knowledge-tree.json", 500);
  }

  const data = JSON.parse(raw) as TreeFile;
  const nodes = (data.nodes || []).filter((n) => n.enabled !== false);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const packed = { nodes, byId };
  if (!catalogPath) cache = packed;
  return packed;
}

/** Clear cache (tests / reload after file edit) */
export function resetKnowledgeTreeCache(): void {
  cache = null;
}

export class KnowledgeTreeService {
  constructor(private catalogPath?: string) {}

  list(opts?: {
    grade?: number;
    type?: NodeType;
    q?: string;
  }): PublicKnowledgeNode[] {
    const { nodes, byId } = loadTree(this.catalogPath);
    let list = nodes.slice();

    if (opts?.grade != null) {
      list = list.filter((n) => n.grade === opts.grade);
    }
    if (opts?.type) {
      list = list.filter((n) => n.type === opts.type);
    }
    if (opts?.q && opts.q.trim()) {
      const q = opts.q.trim().toLowerCase();
      list = list.filter(
        (n) =>
          n.name.toLowerCase().includes(q) ||
          n.id.toLowerCase().includes(q),
      );
    }

    list.sort((a, b) => {
      if (a.grade !== b.grade) return a.grade - b.grade;
      if (a.type !== b.type) {
        const order = { grade: 0, unit: 1, knowledge: 2 };
        return order[a.type] - order[b.type];
      }
      return (a.sort || 0) - (b.sort || 0);
    });

    return list.map((n) => this.enrich(n, byId));
  }

  getById(id: string): PublicKnowledgeNode | null {
    const { byId } = loadTree(this.catalogPath);
    const n = byId.get(id);
    return n ? this.enrich(n, byId) : null;
  }

  getMany(ids: string[]): PublicKnowledgeNode[] {
    return ids
      .map((id) => this.getById(id))
      .filter((n): n is PublicKnowledgeNode => !!n);
  }

  /** Tree for one grade: units with knowledge children */
  treeByGrade(grade: number): Array<{
    unit: PublicKnowledgeNode;
    knowledge: PublicKnowledgeNode[];
  }> {
    const units = this.list({ grade, type: "unit" });
    const knowledge = this.list({ grade, type: "knowledge" });
    return units.map((unit) => ({
      unit,
      knowledge: knowledge.filter((k) => k.parentId === unit.id),
    }));
  }

  private enrich(
    n: KnowledgeNode,
    byId: Map<string, KnowledgeNode>,
  ): PublicKnowledgeNode {
    let unitName: string | null = null;
    let gradeName: string | null = null;
    if (n.type === "knowledge" && n.parentId) {
      const unit = byId.get(n.parentId);
      unitName = unit?.name || null;
      if (unit?.parentId) {
        gradeName = byId.get(unit.parentId)?.name || null;
      }
    } else if (n.type === "unit" && n.parentId) {
      gradeName = byId.get(n.parentId)?.name || null;
    }
    const pathLabel = [gradeName, unitName, n.name].filter(Boolean).join(" · ");
    return {
      ...n,
      unitName,
      gradeName,
      pathLabel: pathLabel || n.name,
    };
  }
}
