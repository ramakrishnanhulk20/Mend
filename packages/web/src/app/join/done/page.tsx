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
    <main className="flow-root min-h-screen bg-paper">
      <div className="patch mx-4 mt-[12vh] max-w-[560px] px-[26px] py-9 min-[600px]:mx-auto min-[600px]:px-11 min-[600px]:py-12">
        <p className="font-mono text-[12px] tracking-[0.14em] text-ink-dim">MEND · SANDBOX</p>
        <Mark size={32} className="mt-4 text-ink" />
        <h1 className="poster-title mt-6 text-[36px] text-ink">
          {copy.title}
        </h1>
        <p className="mt-4 text-[16px] leading-[1.55] text-ink-dim">{copy.text}</p>
        <Link href="/" className="mt-8 inline-block text-ink underline underline-offset-4">
          What is Mend?
        </Link>
        <p className="mt-3 text-[12px] text-ink-dim">Sandbox only. No real money moves.</p>
      </div>
    </main>
  );
}
