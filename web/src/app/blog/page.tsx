/* eslint-disable @next/next/no-img-element */
import Link from 'next/link';
import Footer from '@/components/Footer';
import MediaClip from '@/components/MediaClip';
import Nav from '@/components/Nav';
import { JsonLd, blogCollectionSchema, breadcrumbSchema, graph } from '@/lib/json-ld';
import { SPICE_FM_CLIP } from '@/lib/media';
import { pageMetadata } from '@/lib/metadata';
import { PRESS_COVERAGE } from '@/lib/press';
import { SITE } from '@/lib/site';

export const metadata = pageMetadata({
  title: 'Safety Guides for Women in Kenya',
  description:
    'Practical guides on harassment reporting, GBV support services, evidence safety, and route safety for women in Kenya.',
  path: '/blog',
  image: '/og/blog.jpg',
  imageAlt: 'SafeRide press coverage and public safety guides',
});

const auditThemes = [
  {
    label: 'Privacy first',
    body: 'Start privately, review consent, and understand what stays on the phone before anything is shared.',
  },
  {
    label: 'Legal clarity',
    body: 'Plain-language notes can help riders understand options without turning the app into legal advice.',
  },
  {
    label: 'Route safety',
    body: 'Anonymous patterns can support safer transport only when private evidence and exact journeys stay protected.',
  },
] as const;

const unicefMeetStory = {
  label: 'Field note',
  title: 'Presenting SafeRide as a privacy-first transport safety workflow.',
  date: '2026-05-24',
  image: '/images/pictures/UNI988186_presenter.webp',
  imageAlt: 'SafeRide CEO presenting SafeRide at a UNICEF Venture Fund meet',
  paragraphs: [
    'At the UNICEF Venture Fund meet, SafeRide was presented less as a campaign and more as a product question: how can a rider document harassment, understand support options, and still control what leaves their phone?',
    'The conversation centred on the practical pieces that matter before scale: local drafts, consent review, redacted route signals, referral boundaries, and a route accountability model that does not turn survivor experience into public exposure.',
  ],
} as const;

export default function Page() {
  const [featured, ...rest] = SITE.updates;
  const [pressArticle] = PRESS_COVERAGE;

  return (
    <>
      <Nav />
      <main id="main-content" className="bg-white pt-20">
        <JsonLd
          id="blog-structured-data"
          data={graph([breadcrumbSchema([{ name: 'Guides', path: '/blog' }]), blogCollectionSchema()])}
        />
        <section className="mx-auto grid max-w-[1200px] gap-10 px-4 py-14 sm:px-6 lg:grid-cols-[0.9fr_1.1fr] lg:px-0 lg:py-20">
          <div>
            <p className="mb-4 text-sm font-semibold uppercase tracking-normal">Guides</p>
            <h1 className="max-w-6xl font-display text-[clamp(2.75rem,7vw,5.75rem)] font-semibold leading-[0.9] tracking-normal">
              Guides to safer, more private reporting in Kenya.
            </h1>
          </div>
          <div className="grid gap-8">
            <p className="max-w-3xl text-xl leading-8 text-green-950/80 md:text-2xl md:leading-9">
              Public-facing notes for riders, supporters, reviewers, and pilot partners who need SafeRide to feel private, practical, legal, and safe.
            </p>
            <div className="grid border-y-3 border-black md:grid-cols-3">
              {auditThemes.map((theme) => (
                <article key={theme.label} className="interactive-card border-b-3 border-black py-5 md:border-b-0 md:border-r-3 md:px-5 md:first:pl-0 md:last:border-r-0 md:last:pr-0">
                  <h2 className="font-display text-2xl font-semibold leading-none tracking-normal">{theme.label}</h2>
                  <p className="mt-3 text-sm leading-6 text-black/70">{theme.body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {pressArticle ? (
          <section className="border-y-3 border-black bg-[#F7EC36] py-12 md:py-16" aria-labelledby="press-heading" data-testid="blog-press-section">
            <div className="mx-auto max-w-[1200px] px-4 sm:px-6 lg:px-0">
              <div className="mb-8 flex flex-col gap-3 border-b-3 border-black pb-6 md:flex-row md:items-end md:justify-between">
                <div>
                  <p className="text-sm font-semibold uppercase tracking-normal text-green-700">Coverage</p>
                  <h2 id="press-heading" className="mt-3 font-display text-[clamp(2.25rem,5vw,4rem)] font-semibold leading-[0.9] tracking-normal">
                    Press
                  </h2>
                </div>
                <p className="max-w-md text-sm leading-6 text-black/68">
                  External coverage of SafeRide, Esheria, and the UNICEF Femtech Ventures cohort.
                </p>
              </div>
              <article className="interactive-card overflow-hidden border-3 border-black bg-white">
                <div className="relative aspect-[2560/1491] border-b-3 border-black" data-testid="press-image-frame">
                  <img src={pressArticle.image} alt={pressArticle.imageAlt} loading="lazy" decoding="async" className="absolute inset-0 h-full w-full object-cover" />
                </div>
                <div className="grid gap-7 p-7 md:grid-cols-[0.28fr_0.72fr] md:p-9">
                  <aside className="border-b-3 border-black pb-5 md:border-b-0 md:border-r-3 md:pb-0 md:pr-7">
                    <p className="text-xs font-semibold uppercase tracking-normal text-black/62">{pressArticle.publication}</p>
                    <time dateTime={pressArticle.date} className="mt-3 block font-display text-3xl font-semibold leading-none tracking-normal">
                      {pressArticle.displayDate}
                    </time>
                    {pressArticle.author ? <p className="mt-4 text-sm font-semibold uppercase tracking-normal text-black/58">By {pressArticle.author}</p> : null}
                  </aside>
                  <div>
                    <h3 className="font-display text-[clamp(2rem,4vw,3.65rem)] font-semibold leading-[0.9] tracking-normal">{pressArticle.title}</h3>
                    <p className="mt-6 max-w-3xl text-lg leading-7 text-black/72">{pressArticle.body}</p>
                    <Link
                      href={pressArticle.href}
                      target="_blank"
                      rel="noreferrer"
                      className="interactive-button mt-8 inline-flex w-fit border-3 border-black bg-[#161616] px-6 py-4 font-display font-semibold text-white hover:bg-green-900"
                    >
                      Read BusinessDay article
                    </Link>
                  </div>
                </div>
              </article>
            </div>
          </section>
        ) : null}

        <section className="border-y-3 border-black bg-[#F7EC36] py-12 md:py-16" aria-labelledby="field-note-heading" data-testid="blog-story-section">
          <div className="mx-auto max-w-[1200px] px-4 sm:px-6 lg:px-0">
            <article className="grid overflow-hidden border-3 border-black bg-white md:grid-cols-[0.52fr_0.48fr]">
              <div className="flex flex-col justify-center p-7 md:p-10">
                <p className="text-xs font-semibold uppercase tracking-normal text-green-700">{unicefMeetStory.label}</p>
                <time dateTime={unicefMeetStory.date} className="mt-4 block text-sm font-semibold uppercase tracking-normal text-black/55">
                  {unicefMeetStory.date}
                </time>
                <h2 id="field-note-heading" className="mt-5 font-display text-[clamp(2.15rem,4.6vw,4rem)] font-semibold leading-[0.9] tracking-normal">
                  {unicefMeetStory.title}
                </h2>
                <div className="mt-7 grid gap-5">
                  {unicefMeetStory.paragraphs.map((paragraph) => (
                    <p key={paragraph} className="max-w-2xl text-lg leading-8 text-black/72">
                      {paragraph}
                    </p>
                  ))}
                </div>
              </div>
              <div className="relative min-h-[22rem] border-t-3 border-black bg-green-100 md:min-h-[34rem] md:border-l-3 md:border-t-0" data-testid="blog-story-image-frame">
                <img src={unicefMeetStory.image} alt={unicefMeetStory.imageAlt} loading="lazy" decoding="async" className="absolute inset-0 h-full w-full object-cover" />
              </div>
            </article>
          </div>
        </section>

        {/* The same clip card as on the story page, so a reader who missed it there finds it here. */}
        <div className="[&>section]:border-t-0" data-testid="blog-media-clip">
          <MediaClip clip={SPICE_FM_CLIP} />
        </div>

        {featured ? (
          <section className="mx-auto max-w-[1200px] px-4 py-16 sm:px-6 lg:px-0" aria-labelledby="featured-update">
            <div className="mb-8 flex flex-col gap-3 border-b-3 border-black pb-6 md:flex-row md:items-end md:justify-between">
              <div>
                <p className="text-sm font-semibold uppercase tracking-normal text-green-700">Featured guide</p>
                <h2 id="featured-update" className="mt-3 font-display text-[clamp(2.25rem,5vw,4rem)] font-semibold leading-[0.9] tracking-normal">
                  Start with the reader&apos;s next decision.
                </h2>
              </div>
              <p className="max-w-md text-sm leading-6 text-black/68">
                Practical notes for riders, reviewers, and partners are grouped like articles, not campaign panels.
              </p>
            </div>
            <article className="interactive-card grid overflow-hidden border-3 border-black bg-white md:grid-cols-[0.34fr_0.66fr]">
              <aside className="border-b-3 border-black bg-[#50C9F0] p-7 md:border-b-0 md:border-r-3 md:p-8">
                <p className="text-xs font-semibold uppercase tracking-normal text-black/62">{featured.tag}</p>
                <p className="mt-3 font-display text-5xl font-semibold leading-none tracking-normal">01</p>
                <time dateTime={featured.updatedAt} className="mt-6 block text-sm font-semibold uppercase tracking-normal text-black/62">
                  Updated {featured.updatedAt}
                </time>
                <Link href={`/blog/${featured.slug}`} className="interactive-button mt-8 inline-flex w-fit border-3 border-black bg-white px-5 py-3 font-display font-semibold text-black hover:bg-green-900 hover:text-white">
                  Read guide
                </Link>
              </aside>
              <div className="p-7 md:p-9">
                <div>
                  <h3 className="font-display text-[clamp(2.25rem,5vw,4.25rem)] font-semibold leading-[0.9] tracking-normal">
                    {featured.title}
                  </h3>
                  <p className="mt-6 max-w-2xl text-xl leading-8 text-black/72">{featured.excerpt}</p>
                </div>
                <div className="mt-8 border-t-3 border-black pt-5">
                  <p className="text-xs font-semibold uppercase tracking-normal text-black/55">Inside this guide</p>
                  <ul className="mt-4 grid gap-3 md:grid-cols-2">
                    {featured.sections.map((section) => (
                      <li key={section.heading} className="font-display text-xl font-semibold leading-[1.05] tracking-normal">
                        {section.heading}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </article>
          </section>
        ) : null}

        <section className="mx-auto max-w-[1200px] px-4 pb-16 sm:px-6 lg:px-0" aria-labelledby="all-updates">
          <div className="grid gap-8 md:grid-cols-[0.35fr_0.65fr]">
            <div>
              <p className="text-sm font-semibold uppercase tracking-normal text-green-700">Latest guides</p>
              <h2 id="all-updates" className="mt-3 font-display text-[clamp(2.25rem,5vw,4rem)] font-semibold leading-[0.9] tracking-normal">
                Understand the choices before a crisis.
              </h2>
            </div>
            <div className="grid gap-5">
              {rest.map((post, index) => (
                <article key={post.slug} className="interactive-card grid gap-5 border-3 border-black p-6 md:grid-cols-[5rem_1fr_auto] md:items-start">
                  <div className="font-display text-5xl font-semibold leading-none tracking-normal">0{index + 2}</div>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-normal text-green-800">{post.tag} - Updated {post.updatedAt}</p>
                    <h3 className="mt-3 max-w-3xl font-display text-3xl font-semibold leading-[0.95] tracking-normal">
                      {post.title}
                    </h3>
                    <p className="mt-4 max-w-3xl text-lg leading-7 text-green-950/75">{post.excerpt}</p>
                  </div>
                  <Link href={`/blog/${post.slug}`} className="interactive-button inline-flex w-fit border-3 border-black bg-white px-5 py-3 font-display font-semibold text-black hover:bg-green-900 hover:text-white">
                    Read guide
                  </Link>
                </article>
              ))}
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
