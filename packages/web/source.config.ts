import { remarkMdxMermaid } from "fumadocs-core/mdx-plugins/remark-mdx-mermaid";
import { defineConfig, defineDocs } from "fumadocs-mdx/config";

export const docs = defineDocs({ dir: "content/docs" });

// Code in the docs uses only the site's own bone tones on the raised ink panel, so the
// colours stay inside the same palette as the rest of the film. Meaning comes from
// brightness and italics, not from hue.
const BONE = "#ede6da";
const BONE_BODY = "#c2bcb2";
const BONE_SOFT = "#a39e95";
const BONE_FAINT = "#76726c";

const mendCodeTheme = {
  name: "mend-bone",
  type: "dark" as const,
  colors: {
    "editor.background": "#151312",
    "editor.foreground": BONE_BODY,
  },
  tokenColors: [
    { settings: { foreground: BONE_BODY } },
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: BONE_FAINT, fontStyle: "italic" } },
    { scope: ["string", "string.quoted", "constant.numeric", "constant.language"], settings: { foreground: BONE_SOFT } },
    {
      scope: ["keyword", "storage", "entity.name.function", "support.function", "entity.name.tag", "support.type.property-name", "variable.parameter.option"],
      settings: { foreground: BONE },
    },
    { scope: ["punctuation", "meta.brace"], settings: { foreground: BONE_FAINT } },
  ],
};

export default defineConfig({
  mdxOptions: {
    // Turns a mermaid code block into a Mermaid element, which src/components/docs/mdx.tsx maps to the drawn diagram.
    remarkPlugins: [remarkMdxMermaid],
    rehypeCodeOptions: {
      themes: { light: mendCodeTheme, dark: mendCodeTheme },
    },
  },
});
