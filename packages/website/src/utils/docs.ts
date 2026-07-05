import { getCollection } from "astro:content";

export interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: TreeNode[];
  doc?: any;
}

const HIDDEN = [/^en\//, /^claude-tag\//, /^infos\//];
const isHidden = (id: string) => HIDDEN.some((re) => re.test(id));

export async function buildDocTree(lang: "zh" | "en" = "zh"): Promise<TreeNode[]> {
  const name = lang === "zh" ? "docs" : "docsEn";
  const all = await getCollection(name as any);
  const docs = all.filter((d: any) => !isHidden(d.id)).sort((a: any, b: any) => a.id.localeCompare(b.id));

  const root: TreeNode[] = [];
  for (const d of docs) {
    const parts = d.id.split("/");
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const isLast = i === parts.length - 1;
      let node = current.find((n) => n.name === name && n.isDir === !isLast);
      if (!node) {
        node = { name, path: parts.slice(0, i + 1).join("/"), isDir: !isLast, children: [] };
        if (isLast) node.doc = d;
        current.push(node);
      } else if (isLast) {
        node.doc = d;
      }
      current = node.children;
    }
  }

  const DIR_ORDER: Record<string, number> = { user: 1, dev: 2, federation: 3, archive: 4 };

  const sortNodes = (nodes: TreeNode[], topLevel = false) => {
    nodes.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      // Top-level dirs: user(1) → dev(2) → archive(3)
      if (topLevel && a.isDir) {
        const oa = DIR_ORDER[a.name] ?? 99;
        const ob = DIR_ORDER[b.name] ?? 99;
        return oa - ob;
      }
      return a.name.localeCompare(b.name);
    });
    nodes.forEach((n) => sortNodes(n.children));
  };
  sortNodes(root, true);
  return root;
}

export function displayName(name: string): string {
  return name.replace(/-/g, " ").replace(/_/g, " ");
}

export function nodeUrl(node: TreeNode, lang: "zh" | "en" = "zh"): string {
  const prefix = lang === "zh" ? "/docs/" : "/en/docs/";
  return `${prefix}${node.path}/`;
}
