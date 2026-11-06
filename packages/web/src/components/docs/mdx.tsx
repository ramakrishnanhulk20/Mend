import { Callout } from "fumadocs-ui/components/callout";
import { CodeBlock, Pre } from "fumadocs-ui/components/codeblock";
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import type { ComponentProps, CSSProperties } from "react";
import { Mermaid } from "./Mermaid";

const CALLOUT_STYLE = { "--callout-color": "var(--color-ink-faint)" } as CSSProperties;

// remarkMdxMermaid (source.config.ts) turns a mermaid code block into <Mermaid chart="...">,
// so mapping that one name here is what draws the diagram.
export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    pre: (props: ComponentProps<"pre">) => (
      <CodeBlock {...props} className="rounded-[8px]">
        <Pre>{props.children}</Pre>
      </CodeBlock>
    ),
    Callout: (props: ComponentProps<typeof Callout>) => (
      <Callout {...props} className="rounded-[8px] bg-transparent" style={CALLOUT_STYLE} />
    ),
    Mermaid,
    ...components,
  };
}
