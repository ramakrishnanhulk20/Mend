import { loader } from "fumadocs-core/source";
import { docs } from "../../.source/server";

export const source = loader({
  baseUrl: "/docs",
  source: docs.toFumadocsSource(),
  pageTree: {
    transformers: [
      {
        // Each group in the sidebar stays open and reads as a heading, not a fold-away menu.
        folder(node) {
          node.collapsible = false;
          return node;
        },
      },
    ],
  },
});
