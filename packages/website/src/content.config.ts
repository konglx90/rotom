import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

// docs 集合:加载仓库根 /docs/*.md 作为官网文档页内容
// 路径相对于本文件(src/content.config.ts),走 ../../docs 即仓库根 docs/
const docs = defineCollection({
  loader: glob({
    pattern: "**/*.md",
    base: "../../docs",
  }),
  schema: z.object({
    title: z.string().optional(),
    description: z.string().optional(),
    // Astro 自动注入 render() 等
  }),
});

export const collections = { docs };
