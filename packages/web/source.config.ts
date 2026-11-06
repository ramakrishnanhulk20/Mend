import { remarkMdxMermaid } from "fumadocs-core/mdx-plugins/remark-mdx-mermaid";
import { defineConfig, defineDocs } from "fumadocs-mdx/config";

export const docs = defineDocs({ dir: "content/docs" });

export default defineConfig({
  mdxOptions: {
    // Turns a mermaid code block into a Mermaid element, which src/components/docs/mdx.tsx maps to the drawn diagram.
    remarkPlugins: [remarkMdxMermaid],
    // The docs never go dark, so both slots use the same light theme.
    rehypeCodeOptions: {
      themes: { light: "github-light", dark: "github-light" },
    },
  },
});
