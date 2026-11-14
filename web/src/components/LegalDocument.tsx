import Link from 'next/link';
import type { ReactNode } from 'react';
import Footer from '@/components/Footer';
import Nav from '@/components/Nav';
import {
  HURIA_PHONE,
  LEGAL_PILOT_VERSION,
  LEGAL_PLACEHOLDERS,
  LEGAL_PUBLISHED_ON,
  type LegalDocumentContent,
  type LegalPlaceholderKey,
} from '@/content/legal';
import { JsonLd, breadcrumbSchema } from '@/lib/json-ld';

const TOKEN = /\{\{ph:([a-z-]+)\}\}|\{\{huria-phone\}\}|\[\[([^|\]]+)\|([^\]]+)\]\]/g;

function formatDate(date: string) {
  return new Intl.DateTimeFormat('en-KE', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${date}T00:00:00Z`),
  );
}

function Placeholder({ id }: { id: string }) {
  if (!(id in LEGAL_PLACEHOLDERS)) {
    throw new Error(`Unknown legal placeholder: ${id}`);
  }

  return (
    <mark
      data-placeholder={id}
      className="border-2 border-dashed border-amber-700 bg-amber-100 px-1 text-amber-950 [box-decoration-break:clone]"
    >
      <strong>[To confirm: </strong>
      {LEGAL_PLACEHOLDERS[id as LegalPlaceholderKey]}
      <strong>]</strong>
    </mark>
  );
}

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;

  for (const match of text.matchAll(TOKEN)) {
    const index = match.index ?? 0;

    if (index > last) {
      nodes.push(text.slice(last, index));
    }

    if (match[1]) {
      nodes.push(<Placeholder key={index} id={match[1]} />);
    } else if (match[2] && match[3]) {
      nodes.push(
        <Link key={index} href={match[3]} className="font-semibold underline decoration-2 underline-offset-4">
          {match[2]}
        </Link>,
      );
    } else {
      nodes.push(
        <a key={index} href={`tel:${HURIA_PHONE.replace(/\s/g, '')}`} className="font-semibold underline decoration-2 underline-offset-4">
          {HURIA_PHONE}
        </a>,
      );
    }

    last = index + match[0].length;
  }

  if (last < text.length) {
    nodes.push(text.slice(last));
  }

  return nodes;
}

export default function LegalDocument({ document }: { document: LegalDocumentContent }) {
  const other = document.kind === 'privacy'
    ? { label: 'Terms of use', href: '/terms' }
    : { label: 'Privacy notice', href: '/privacy' };

  return (
    <>
      <Nav />
      <main id="main-content" className="bg-white pt-20">
        <JsonLd
          id="legal-structured-data"
          data={breadcrumbSchema([{ name: document.metaTitle, path: document.path }])}
        />
        <article data-testid="legal-document" data-legal-version={LEGAL_PILOT_VERSION}>
          <header className="mx-auto max-w-[1000px] px-4 py-14 sm:px-6 lg:px-0 lg:py-20">
            <p className="flex flex-wrap items-center gap-3 text-sm font-semibold uppercase tracking-normal text-green-800">
              <span
                data-testid="legal-pilot-label"
                className="border-2 border-black bg-[#F7EC36] px-2 py-0.5 text-black"
              >
                Pilot
              </span>
              <span>HURIA pilot, Kenyan Coast</span>
            </p>
            <h1 className="mt-6 font-display text-[clamp(2.5rem,6vw,5rem)] font-semibold leading-[0.95] tracking-normal">
              {document.title}
            </h1>
            <p className="mt-8 max-w-3xl text-xl leading-8 text-green-950/80 md:text-2xl md:leading-9">
              {renderInline(document.intro)}
            </p>
            <dl className="mt-8 grid gap-x-8 gap-y-2 border-y border-black/20 py-4 text-sm text-black/70 sm:grid-cols-3">
              <div>
                <dt className="font-semibold text-black">Version</dt>
                <dd data-testid="legal-version">{LEGAL_PILOT_VERSION}</dd>
              </div>
              <div>
                <dt className="font-semibold text-black">Published</dt>
                <dd>
                  <time dateTime={LEGAL_PUBLISHED_ON}>{formatDate(LEGAL_PUBLISHED_ON)}</time>
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-black">Effective</dt>
                <dd>{renderInline('{{ph:effective-date}}')}</dd>
              </div>
            </dl>
          </header>

          <div className="border-y-3 border-black bg-[#EAF9EE] py-12 md:py-16">
            <div className="mx-auto max-w-[850px] px-4 sm:px-6 lg:px-0">
              <aside
                className="border-3 border-black bg-[#F7EC36] p-5 shadow-[5px_5px_0_#0D1B12]"
                aria-label="Pilot status"
              >
                <p className="text-xs font-semibold uppercase tracking-normal">Pilot version, under review</p>
                <p className="mt-3 text-base leading-7 text-black/80">
                  This is the pilot version of this document. Legal, safeguarding and privacy review is not finished.
                  Text marked “To confirm” has not been decided yet and will be completed in a later version.
                </p>
              </aside>

              <nav aria-label="On this page" className="mt-10">
                <p className="font-display text-sm font-semibold uppercase tracking-normal text-green-800">On this page</p>
                <ol className="mt-3 grid gap-1 text-base sm:grid-cols-2">
                  {document.sections.map((section) => (
                    <li key={section.id}>
                      <a href={`#${section.id}`} className="underline decoration-1 underline-offset-4 hover:decoration-2">
                        {section.title}
                      </a>
                    </li>
                  ))}
                </ol>
              </nav>

              <div className="mt-12 space-y-12">
                {document.sections.map((section) => (
                  <section key={section.id} id={section.id} aria-labelledby={`${section.id}-heading`} className="scroll-mt-28">
                    <h2
                      id={`${section.id}-heading`}
                      className="font-display text-[clamp(1.75rem,3.5vw,2.75rem)] font-semibold leading-[1] tracking-normal"
                    >
                      {section.title}
                    </h2>
                    <div className="mt-5 space-y-4 text-lg leading-8 text-green-950/85">
                      {section.blocks.map((block, index) =>
                        typeof block === 'string' ? (
                          <p key={index}>{renderInline(block)}</p>
                        ) : (
                          <ul key={index} className="list-disc space-y-3 pl-6">
                            {block.map((item, itemIndex) => (
                              <li key={itemIndex}>{renderInline(item)}</li>
                            ))}
                          </ul>
                        ),
                      )}
                    </div>
                  </section>
                ))}
              </div>
            </div>
          </div>

          <section className="mx-auto max-w-[1000px] px-4 py-12 sm:px-6 lg:px-0" aria-labelledby="legal-related-heading">
            <h2 id="legal-related-heading" className="font-display text-2xl font-semibold tracking-normal">
              Related
            </h2>
            <ul className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-base">
              <li>
                <Link href={other.href} className="font-semibold underline decoration-2 underline-offset-4">
                  {other.label}
                </Link>
              </li>
              <li>
                <Link href="/privacy-safety-trust" className="font-semibold underline decoration-2 underline-offset-4">
                  Privacy &amp; trust overview
                </Link>
              </li>
              <li>
                <Link href="/contact" className="font-semibold underline decoration-2 underline-offset-4">
                  Contact SafeRide
                </Link>
              </li>
            </ul>
            <p className="mt-6 text-sm text-black/60">
              Version {LEGAL_PILOT_VERSION}. Replaces the unpublished engineering draft {document.supersedes}.
            </p>
          </section>
        </article>
      </main>
      <Footer />
    </>
  );
}
