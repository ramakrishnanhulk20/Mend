import type { Metadata } from "next";
import { SmoothScroll } from "@/components/motion/SmoothScroll";
import { LabStage } from "./LabStage";

export const metadata: Metadata = {
  title: "Lab | Mend",
  robots: { index: false, follow: false },
};

export default function LabPage() {
  return (
    <>
      <SmoothScroll />
      <LabStage />
    </>
  );
}
