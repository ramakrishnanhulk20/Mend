import { createFromSource } from "fumadocs-core/search/server";
import { source } from "@/lib/source";

export const runtime = "nodejs";

// Builds its index from the same pages the docs route serves, on the first request.
export const { GET } = createFromSource(source);
