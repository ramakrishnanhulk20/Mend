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
      <DocsTitle className="poster-title text-[36px] text-ink md:text-[48px]">
        {page.data.title}
      </DocsTitle>
      <DocsDescription className="text-[18px] text-ink-dim">{page.data.description}</DocsDescription>
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
    title: slug === undefined || slug.length === 0 ? "Mend docs" : `${page.data.title} | Mend docs`,
    description: page.data.description,
  };
}
