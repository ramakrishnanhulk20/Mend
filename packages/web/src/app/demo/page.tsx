import type { Metadata } from "next";
import { Console } from "@/components/console/Console";
import { SmoothScroll } from "@/components/motion/SmoothScroll";

export const metadata: Metadata = {
  title: "Demo | Mend",
  description: "Run a real win-back campaign on a sandbox shop: plan with Claude, approve, pay with PayPal, see if it worked.",
};

export default function DemoPage() {
  return (
    <>
      <SmoothScroll />
      <Console />
    </>
  );
}
