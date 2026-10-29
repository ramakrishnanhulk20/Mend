import type { Metadata } from "next";
import Link from "next/link";
import { Mark } from "@/components/brand/Mark";

export const metadata: Metadata = {
  title: "Join | Mend",
  robots: { index: false, follow: false },
};

type Copy = { readonly title: string; readonly text: string };

// The codes the join routes send a person here with. Any other value, a repeated one or
// none at all shows GENERIC, so the address can never choose the words on this page.
const RESULTS: Readonly<Record<string, Copy>> = {
  joined: {
    title: "You're on the list.",
    text: "Thank you. If the shop sends you a thank-you, it arrives in your PayPal account with a short note. You can leave at any time from the same link.",
  },
  left: {
    title: "You've left the list.",
    text: "You won't receive any more thank-yous from this shop. Any reward not yet sent to you was cancelled.",
  },
  cancelled: {
    title: "Nothing changed.",
    text: "You stopped at PayPal, so you were not added to the list.",
  },
  consent_changed: {
    title: "The wording changed.",
    text: "The shop updated what joining means while you were signing in. Open the join link again to read the new wording.",
  },
  expired: {
    title: "That link timed out.",
    text: "Open the join link again and sign in within a few minutes.",
  },
  rate_limited: {
    title: "Too many tries.",
    text: "Wait a minute, then open the join link again.",
  },
};

const GENERIC: Copy = {
  title: "That didn't work.",
  text: "Something went wrong between PayPal and Mend. Try the join link again in a minute.",
};

type JoinDoneProps = { readonly searchParams: Promise<Record<string, string | string[] | undefined>> };

/** Where Join with PayPal ends for a person: one plain sentence for ?result=, rendered on the server with no client script. */
export default async function JoinDonePage({ searchParams }: JoinDoneProps) {
  const { result } = await searchParams;
  const copy = typeof result === "string" && Object.hasOwn(RESULTS, result) ? RESULTS[result] : GENERIC;
  return (
    <main className="flow-root min-h-screen bg-ink">
      <div className="mx-4 mt-[12vh] max-w-[560px] rounded-[8px] border border-rule bg-ink-raised px-6 py-8 min-[600px]:mx-auto">
        <p className="font-mono text-[11px] tracking-[0.14em] text-bone-faint">MEND · SANDBOX</p>
        <Mark size={32} className="mt-4 text-bone" />
        {/* Inline line height, because .poster-title sits outside Tailwind's layers and would beat a leading class. */}
        <h1 className="poster-title mt-6 text-[40px] text-bone" style={{ lineHeight: 0.95 }}>
          {copy.title}
        </h1>
        <p className="mt-4 text-[16px] leading-[1.55] text-bone-dim">{copy.text}</p>
        <Link href="/" className="mt-8 inline-block text-bone underline underline-offset-4">
          What is Mend?
        </Link>
        <p className="mt-3 text-[12px] text-bone-faint">Sandbox only. No real money moves.</p>
      </div>
    </main>
  );
}
