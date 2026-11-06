import type { Metadata } from "next";
import { Console } from "@/components/console/Console";

export const metadata: Metadata = {
  title: "Demo | Mend",
  description: "Run a real win-back campaign on a sandbox shop: plan with Claude, approve, pay with PayPal, see if it worked.",
};

export default function DemoPage() {
  // No smooth scrolling here: its own scroll target fights the jump to the top of each step,
  // and a click right after a wheel scroll would leave the visitor below a shorter step.
  return <Console studioLicenseKey={process.env.AG_STUDIO_LICENSE_KEY ?? ""} />;
}
