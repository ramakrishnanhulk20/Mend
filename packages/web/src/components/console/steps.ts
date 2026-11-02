// Kept out of Console.tsx so the link format can be tested without rendering anything.
// The landing page and the docs open the demo with /demo?step=break-it.
export function stepFromQuery(search: string): "breakit" | null {
  return new URLSearchParams(search).get("step") === "break-it" ? "breakit" : null;
}
