import type { Metadata } from "next";
import { Landing } from "@/components/landing/Landing";
import { SmoothScroll } from "@/components/motion/SmoothScroll";

export const metadata: Metadata = {
  title: "Mend: win back the regulars who went quiet",
  description:
    "Win back the regulars who went quiet, with PayPal cashback and a random holdout that measures whether it worked.",
};

export default function HomePage() {
  return (
    <>
      <SmoothScroll />
      <Landing />
    </>
  );
}
