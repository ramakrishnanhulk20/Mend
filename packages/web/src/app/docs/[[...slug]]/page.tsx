import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/page";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getMDXComponents } from "@/components/docs/mdx";
import { source } from "@/lib/source";

type DocsPageProps = { params: Promise<{ slug?: string[] }> };

export default async function Page({ params }: DocsPageProps) {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (!page) notFound();

  const Body = page.data.body;

  return (
    <DocsPage toc={page.data.toc} full={page.data.full} className="max-w-[calc(760px+4rem)]">
      {/* Inline line height, because .poster-title sits outside Tailwind's layers and would beat a leading class. */}
      <DocsTitle className="poster-title text-[44px] text-bone md:text-[56px]" style={{ lineHeight: 0.9 }}>
        {page.data.title}
      </DocsTitle>
      <DocsDescription className="text-[18px] text-bone-dim">{page.data.description}</DocsDescription>
      <DocsBody>
        <Body components={getMDXComponents()} />
      </DocsBody>
    </DocsPage>
  );
}

export function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata({ params }: DocsPageProps): Promise<Metadata> {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (!page) notFound();

  return {
    title: `${page.data.title} | Mend docs`,
    description: page.data.description,
  };
}
