/* eslint-disable @next/next/no-img-element */
import PilotStrip, { type PilotStripData } from '@/components/PilotStrip';
import Link from 'next/link';
import Footer from '@/components/Footer';
import MediaClip from '@/components/MediaClip';
import Nav from '@/components/Nav';
import { JsonLd, type JsonLdNode } from '@/lib/json-ld';
import type { MediaClipData } from '@/lib/media';

type Stat = {
  value: string;
  label: string;
};

type Card = {
  title: string;
  body: string;
};

type Evidence = {
  label: string;
  title: string;
  body: string;
};

type ResourceLink = {
  label: string;
  title: string;
  body: string;
  href: string;
};

type PressLink = {
  publication: string;
  title: string;
  body: string;
  href: string;
  date: string;
  displayDate: string;
  author?: string;
};

type PartnerLogo = {
  name: string;
  role: string;
  href: string;
  initials: string;
  logo?: string;
};

type PresentationImage = {
  src: string;
  alt: string;
  caption: string;
};

type Faq = {
  question: string;
  answer: string;
};

type Feature = {
  eyebrow: string;
  title: string;
  paragraphs: readonly string[];
  points?: readonly string[];
  image: string;
  imageAlt: string;
  imageWidth: number;
  imageHeight: number;
};

type PageVariant = 'manifesto' | 'playbook' | 'index' | 'editorial';

type PageShellProps = {
  variant?: PageVariant;
  eyebrow: string;
  title: string;
  intro: string;
  heroTitle: string;
  heroBody: string;
  wideHeroTitle?: boolean;
  tone: string;
  accent: string;
  stats: readonly Stat[];
  cards: readonly Card[];
  evidence?: readonly Evidence[];
  evidenceTitle?: string;
  resources?: readonly ResourceLink[];
  press?: readonly PressLink[];
  media?: MediaClipData;
  partners?: readonly PartnerLogo[];
  presentationImages?: readonly PresentationImage[];
  pilotStrip?: PilotStripData;
  /** Short questions people ask, answered only from what the page already states. */
  faq?: readonly Faq[];
  /** One image-led explainer block shown above the questions. */
  feature?: Feature;
  image?: string;
  imageAlt?: string;
  /** Tailwind object-position class when the hero image is cropped to its frame */
  imagePosition?: string;
  stepsTitle: string;
  steps: readonly string[];
  ctaTitle?: string;
  cta: { label: string; href: string };
  contextLink?: { label: string; href: string };
  structuredData?: JsonLdNode;
};

const swatches = ['bg-[#F88539]', 'bg-[#50C9F0]', 'bg-[#F7EC36]', 'bg-[#53E17C]'] as const;

function swatch(index: number) {
  return swatches[index % swatches.length] ?? swatches[0];
}

function isExternalHref(href: string) {
  return href.startsWith('http');
}

function indexStatValueClass(value: string) {
  const compact = value.length > 7;
  const medium = value.length > 4;

  if (compact) {
    return 'text-[clamp(2.7rem,4.8vw,4.6rem)] leading-[0.92]';
  }

  if (medium) {
    return 'text-[clamp(3rem,5.8vw,5.35rem)] leading-[0.88]';
  }

  return 'text-[clamp(3.6rem,9vw,7.5rem)] leading-[0.82]';
}

function FieldVisual({
  accent,
  title,
  image,
  imageAlt,
  imagePosition = '',
  stats,
}: {
  accent: string;
  title: string;
  image?: string;
  imageAlt?: string;
  imagePosition?: string;
  stats: readonly Stat[];
}) {
  const highlights = stats.slice(0, 2);

  return (
    <div
      data-testid="page-hero-visual"
      className={`interactive-card group relative min-h-[24rem] overflow-hidden border-3 border-black ${accent}`}
      aria-label={`${title} visual`}
    >
      {image ? (
        <img
          src={image}
          alt={imageAlt ?? ''}
          loading="eager"
          decoding="async"
          className={`absolute inset-0 h-full w-full object-cover transition duration-500 group-hover:scale-[1.03] ${imagePosition}`}
        />
      ) : (
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_24%_24%,rgba(255,255,255,0.65),transparent_28%),linear-gradient(135deg,rgba(0,0,0,0.02),rgba(0,0,0,0.28))]" />
      )}
      <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(0,0,0,0.04),rgba(0,0,0,0.18)_48%,rgba(0,0,0,0.72))]" aria-hidden="true" />
      <div className="absolute left-5 top-5 max-w-[14rem] border-3 border-black bg-white px-4 py-3 font-display text-3xl font-semibold leading-[0.9] tracking-normal text-black sm:left-7 sm:top-7">
        {title}
      </div>
      <div className="absolute bottom-5 left-5 right-5 grid gap-3 sm:left-7 sm:right-7 sm:grid-cols-2">
        {highlights.map((stat, index) => (
          <div key={stat.label} className="border-3 border-black bg-white/92 p-4 backdrop-blur">
            <p className={`font-display text-3xl font-semibold leading-none tracking-normal ${index === 0 ? 'text-black' : 'text-green-900'}`}>
              {stat.value}
            </p>
            <p className="mt-2 text-sm font-semibold leading-5 text-black/75">{stat.label}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function IntroHero({ eyebrow, title, intro }: Pick<PageShellProps, 'eyebrow' | 'title' | 'intro'>) {
  return (
    <section className="mx-auto max-w-[1200px] px-4 pb-12 pt-12 sm:px-6 lg:px-0 lg:pb-20 lg:pt-16">
      <p className="mb-4 text-sm font-semibold uppercase tracking-normal">{eyebrow}</p>
      <h1 className="max-w-5xl font-display text-[clamp(2.75rem,7vw,5.75rem)] font-semibold leading-[0.9] tracking-normal">
        {title}
      </h1>
      <p className="mt-8 max-w-3xl text-xl leading-8 md:text-2xl md:leading-9">{intro}</p>
    </section>
  );
}

function FeatureBlock({ feature }: { feature?: Feature }) {
  if (!feature) {
    return null;
  }

  return (
    <section data-testid="page-feature" className="border-y-3 border-black bg-[#F7EC36] py-14 md:py-20" aria-labelledby="page-feature-heading">
      <div className="mx-auto grid max-w-[1200px] items-center gap-10 px-4 sm:px-6 lg:grid-cols-[1.05fr_0.95fr] lg:px-0">
        <div>
          <p className="text-sm font-semibold uppercase tracking-normal text-green-900">{feature.eyebrow}</p>
          <h2
            id="page-feature-heading"
            className="mt-2 max-w-2xl hyphens-none font-display text-[clamp(2rem,4.4vw,3.4rem)] font-semibold leading-[0.95] tracking-normal text-green-950"
          >
            {feature.title}
          </h2>
          {feature.paragraphs.map(paragraph => (
            <p key={paragraph} className="mt-5 max-w-xl text-lg leading-8 text-green-950/80">
              {paragraph}
            </p>
          ))}
          {feature.points ? (
            <ul className="mt-6 grid max-w-xl gap-3">
              {feature.points.map(point => (
                <li key={point} className="border-l-3 border-black pl-4 text-base font-semibold leading-7 text-green-950">
                  {point}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <figure className="interactive-card overflow-hidden border-3 border-black bg-white shadow-[6px_6px_0_#0D1B12]">
          <img
            src={feature.image}
            alt={feature.imageAlt}
            width={feature.imageWidth}
            height={feature.imageHeight}
            loading="lazy"
            decoding="async"
            className="h-auto w-full"
          />
        </figure>
      </div>
    </section>
  );
}

function FaqList({ faq }: { faq?: readonly Faq[] }) {
  if (!faq || faq.length === 0) {
    return null;
  }

  return (
    <section data-testid="page-faq" className="mx-auto max-w-[1200px] px-4 pb-16 pt-14 sm:px-6 lg:px-0" aria-labelledby="page-faq-heading">
      <div className="grid gap-8 lg:grid-cols-[0.7fr_1.3fr]">
        <h2 id="page-faq-heading" className="hyphens-none font-display text-[clamp(2rem,4vw,3.5rem)] font-semibold leading-[0.92] tracking-normal">
          Questions people ask.
        </h2>
        <div className="border-t-3 border-black">
          {faq.map(item => (
            <details key={item.question} className="group border-b-3 border-black py-4">
              <summary className="flex cursor-pointer list-none items-start justify-between gap-4 font-display text-xl font-semibold leading-tight tracking-normal outline-none focus-visible:ring-4 focus-visible:ring-black md:text-2xl">
                <span>{item.question}</span>
                <span aria-hidden="true" className="mt-1 text-2xl leading-none transition-transform group-open:rotate-45">+</span>
              </summary>
              <p className="mt-3 max-w-2xl text-lg leading-8 text-black/80">{item.answer}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

function CtaBand({ cta, ctaTitle, contextLink, faq, feature }: Pick<PageShellProps, 'cta' | 'ctaTitle' | 'contextLink' | 'faq' | 'feature'>) {
  return (
    <>
    <FeatureBlock feature={feature} />
    <FaqList faq={faq} />
    <section className="px-4 pb-20 sm:px-6 lg:px-0">
      <div className="mx-auto flex max-w-[1200px] flex-col gap-6 rounded-tr-[5rem] border-3 border-black bg-[#161616] p-8 text-white md:flex-row md:items-center md:justify-between">
        <div>
          <p className="max-w-2xl font-display text-4xl font-semibold leading-[0.95] tracking-normal">
            {ctaTitle ?? 'Help make the next journey safer.'}
          </p>
          {contextLink ? (
            <Link
              href={contextLink.href}
              target={isExternalHref(contextLink.href) ? '_blank' : undefined}
              rel={isExternalHref(contextLink.href) ? 'noreferrer' : undefined}
              className="mt-4 inline-flex font-semibold text-green-300 underline decoration-2 underline-offset-4"
            >
              {contextLink.label}
            </Link>
          ) : null}
        </div>
        <Link href={cta.href} className="interactive-button inline-flex w-fit border border-white px-7 py-4 font-bold hover:bg-white hover:text-black">
          {cta.label}
        </Link>
      </div>
    </section>
    </>
  );
}

function EvidenceBand({ eyebrow, evidence, evidenceTitle, image, imageAlt, imagePosition = '', accent }: Pick<PageShellProps, 'eyebrow' | 'evidence' | 'evidenceTitle' | 'image' | 'imageAlt' | 'imagePosition' | 'accent'>) {
  if (!evidence?.length) {
    return null;
  }

  return (
    <section className="mx-auto max-w-[1200px] px-4 py-16 sm:px-6 lg:px-0" aria-label={`${eyebrow} supporting detail`}>
      <div className="grid gap-6 lg:grid-cols-[0.9fr_1.1fr] lg:items-stretch">
        <div className={`relative min-h-[22rem] overflow-hidden border-3 border-black ${accent}`}>
          {image ? (
            <img src={image} alt={imageAlt ?? ''} loading="lazy" decoding="async" className={`absolute inset-0 h-full w-full object-cover ${imagePosition}`} />
          ) : (
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_24%_24%,rgba(255,255,255,0.65),transparent_28%),linear-gradient(135deg,rgba(0,0,0,0.02),rgba(0,0,0,0.28))]" />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-black/50 via-black/10 to-transparent" aria-hidden="true" />
          <div className="absolute bottom-6 left-6 right-6 text-white drop-shadow-[0_2px_8px_rgba(0,0,0,0.65)]">
            <p className="text-sm font-semibold uppercase tracking-normal">Supporting detail</p>
            <h2 className="mt-2 font-display text-[clamp(2.25rem,5vw,4.25rem)] font-semibold leading-[0.9] tracking-normal">
              {evidenceTitle ?? 'Evidence reviewers can inspect.'}
            </h2>
          </div>
        </div>
        <div className="grid gap-4">
          {evidence.map((item, index) => (
            <article key={item.title} className={`interactive-card border-3 border-black p-6 ${swatch(index)}`}>
              <p className="text-xs font-semibold uppercase tracking-normal text-black/65">{item.label}</p>
              <h3 className="mt-3 font-display text-[clamp(1.75rem,3vw,2.75rem)] font-semibold leading-[0.95] tracking-normal">{item.title}</h3>
              <p className="mt-4 text-base leading-7 text-black/72 md:text-lg">{item.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function ResourceLinks({ resources }: { resources?: readonly ResourceLink[] }) {
  if (!resources?.length) {
    return null;
  }

  return (
    <section className="mx-auto max-w-[1200px] px-4 pb-16 sm:px-6 lg:px-0" aria-labelledby="resource-links">
      <div className="border-y-3 border-black py-10">
        <div className="grid gap-8 md:grid-cols-[0.36fr_0.64fr]">
          <div>
            <p className="text-sm font-semibold uppercase tracking-normal text-green-700">Useful links</p>
            <h2 id="resource-links" className="mt-3 font-display text-[clamp(2.25rem,5vw,4rem)] font-semibold leading-[0.9] tracking-normal">
              Review the public materials.
            </h2>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {resources.map((resource, index) => (
              <Link
                key={resource.href}
                href={resource.href}
                target={isExternalHref(resource.href) ? '_blank' : undefined}
                rel={isExternalHref(resource.href) ? 'noreferrer' : undefined}
                className={`interactive-card block border-3 border-black p-5 ${swatch(index)}`}
              >
                <p className="text-xs font-semibold uppercase tracking-normal text-black/62">{resource.label}</p>
                <h3 className="mt-3 font-display text-2xl font-semibold leading-[0.95] tracking-normal">{resource.title}</h3>
                <p className="mt-3 text-sm leading-6 text-black/72">{resource.body}</p>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function PressLinks({ press }: { press?: readonly PressLink[] }) {
  if (!press?.length) {
    return null;
  }

  return (
    <section className="mx-auto max-w-[1200px] px-4 py-16 sm:px-6 lg:px-0" aria-labelledby="press-links" data-testid="press-section">
      <div className="grid gap-8 border-y-3 border-black py-10 md:grid-cols-[0.34fr_0.66fr]">
        <div>
          <p className="text-sm font-semibold uppercase tracking-normal text-green-700">Press</p>
          <h2 id="press-links" className="mt-3 font-display text-[clamp(2.25rem,5vw,4rem)] font-semibold leading-[0.9] tracking-normal">
            SafeRide in the news.
          </h2>
        </div>
        <div className="grid gap-4">
          {press.map((item, index) => (
            <Link
              key={item.href}
              href={item.href}
              target="_blank"
              rel="noreferrer"
              className={`interactive-card block border-3 border-black p-6 ${swatch(index)}`}
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs font-semibold uppercase tracking-normal text-black/62">
                <span>{item.publication}</span>
                <span aria-hidden="true">/</span>
                <time dateTime={item.date}>{item.displayDate}</time>
                {item.author ? (
                  <>
                    <span aria-hidden="true">/</span>
                    <span>{item.author}</span>
                  </>
                ) : null}
              </div>
              <h3 className="mt-4 font-display text-[clamp(1.8rem,3vw,3rem)] font-semibold leading-[0.95] tracking-normal">{item.title}</h3>
              <p className="mt-4 max-w-3xl text-base leading-7 text-black/72 md:text-lg">{item.body}</p>
              <span className="mt-6 inline-flex border-3 border-black bg-white px-5 py-3 text-sm font-bold">Read article</span>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

function PartnerMarquee({ partners }: { partners?: readonly PartnerLogo[] }) {
  if (!partners?.length) {
    return null;
  }

  const repeatedPartners = [...partners, ...partners];

  return (
    <section className="border-y-3 border-black bg-[#F7EC36] py-10" aria-labelledby="partner-marquee-heading" data-testid="partner-carousel">
      <div className="mx-auto max-w-[1200px] px-4 sm:px-6 lg:px-0">
        <div className="mb-7 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-normal text-black/62">Current ecosystem</p>
            <h2 id="partner-marquee-heading" className="font-display text-[clamp(2.1rem,4vw,3.75rem)] font-semibold leading-[0.9] tracking-normal">
              UNICEF plus Kenya-rooted partner references.
            </h2>
          </div>
          <p className="max-w-md text-sm leading-6 text-black/70">
            The carousel keeps the visible set practical: funder/support signal, survivor support, legal aid, justice access, and community delivery.
          </p>
        </div>
      </div>
      <div className="partner-marquee" aria-label="Partner organization carousel">
        <div className="partner-marquee__track">
          {repeatedPartners.map((partner, index) => {
            const duplicate = index >= partners.length;

            return (
              <Link
                key={`${partner.name}-${index}`}
                href={partner.href}
                target={isExternalHref(partner.href) ? '_blank' : undefined}
                rel={isExternalHref(partner.href) ? 'noreferrer' : undefined}
                aria-hidden={duplicate ? true : undefined}
                tabIndex={duplicate ? -1 : undefined}
                className="partner-logo-card interactive-card"
              >
                <span className="relative grid h-16 w-20 shrink-0 place-items-center border-3 border-black bg-white">
                  {partner.logo ? (
                    <img src={partner.logo} alt="" loading="lazy" decoding="async" className="absolute inset-0 h-full w-full object-contain p-2" />
                  ) : (
                    <span className="font-display text-2xl font-semibold tracking-normal text-[#0570A6]">{partner.initials}</span>
                  )}
                </span>
                <span className="min-w-0">
                  <span className="block font-display text-xl font-semibold leading-[0.95] tracking-normal">{partner.name}</span>
                  <span className="mt-1 block text-sm leading-5 text-black/64">{partner.role}</span>
                </span>
              </Link>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function PresentationMoment({ images }: { images?: readonly PresentationImage[] }) {
  const [image] = images ?? [];

  if (!image) {
    return null;
  }

  return (
    <section className="border-b-3 border-black bg-white py-14 md:py-20" aria-labelledby="presentation-moment-heading" data-testid="unicef-presentation-moment">
      <div className="mx-auto max-w-[1200px] px-4 sm:px-6 lg:px-0">
        <div className="grid gap-8 border-3 border-black bg-[#50C9F0] p-6 md:grid-cols-[0.42fr_0.58fr] md:p-8">
          <div>
            <p className="text-sm font-semibold uppercase tracking-normal text-black/62">UNICEF meet</p>
            <h2 id="presentation-moment-heading" className="mt-3 font-display text-[clamp(2.25rem,5vw,4rem)] font-semibold leading-[0.9] tracking-normal">
              SafeRide presented in the room.
            </h2>
            <p className="mt-6 max-w-md text-lg leading-7 text-black/72">
              The UNICEF Venture Fund meet is part of the SafeRide story: a review moment where the team explained a privacy-first transport safety workflow to funders and reviewers.
            </p>
          </div>
          <figure className="interactive-card overflow-hidden border-3 border-black bg-white shadow-[5px_5px_0_#0D1B12] md:ml-8">
            <div className="relative aspect-[4/3] bg-green-100">
              <img src={image.src} alt={image.alt} loading="lazy" decoding="async" className="absolute inset-0 h-full w-full object-cover" />
            </div>
            <figcaption className="border-t-3 border-black p-4 text-sm font-semibold leading-6 text-black/70">{image.caption}</figcaption>
          </figure>
        </div>
      </div>
    </section>
  );
}

function ManifestoLayout(props: PageShellProps) {
  const { eyebrow, title, intro, heroTitle, heroBody, wideHeroTitle, tone, cards, stepsTitle, steps } = props;
  const heroGridColumns = wideHeroTitle ? 'md:grid-cols-[0.88fr_1.12fr]' : 'md:grid-cols-[0.72fr_1.28fr]';

  return (
    <>
      <IntroHero eyebrow={eyebrow} title={title} intro={intro} />

      <section className={`${tone} border-y-3 border-black py-14 md:py-20`}>
        <div className={`mx-auto grid max-w-[1200px] gap-10 px-4 sm:px-6 ${heroGridColumns} lg:px-0`}>
          <h2 className="font-display text-[clamp(2.5rem,6vw,5.25rem)] font-semibold leading-[0.88] tracking-normal">
            {heroTitle}
          </h2>
          <div className="grid gap-8">
            <p className="max-w-3xl text-[clamp(1.4rem,3vw,2.35rem)] font-semibold leading-[1.02]">{heroBody}</p>
            <div className="border-l-3 border-black py-2 pl-6">
              <p className="text-xl leading-8">
                SafeRide is strongest when the rider controls the pace: draft first, choose the path, review consent, then decide what leaves the phone.
              </p>
            </div>
          </div>
        </div>
      </section>

      {props.media ? <MediaClip clip={props.media} /> : null}

      <section className="mx-auto max-w-[1200px] px-4 py-16 sm:px-6 lg:px-0">
        <div className="grid gap-5 md:grid-cols-3">
          {cards.map((card, index) => (
            <article key={card.title} className={`interactive-card flex min-h-[27rem] flex-col justify-between border-3 border-black p-7 ${swatch(index)} ${index === 0 ? 'rounded-t-[5rem]' : ''}`}>
              <p className="font-display text-7xl font-semibold leading-none tracking-normal">0{index + 1}</p>
              <div>
                <h2 className="font-display text-3xl font-semibold leading-[0.95] tracking-normal">{card.title}</h2>
                <p className="mt-5 text-lg leading-7">{card.body}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      <EvidenceBand {...props} />
      <PilotStrip strip={props.pilotStrip} />
      <PresentationMoment images={props.presentationImages} />

      <section className="mx-auto max-w-[1200px] px-4 pb-16 sm:px-6 lg:px-0">
        <div className="border-y-3 border-black py-10">
          <h2 className="font-display text-[clamp(2rem,4vw,3.5rem)] font-semibold leading-[0.92] tracking-normal">{stepsTitle}</h2>
          <ol className="mt-8 grid gap-4 md:grid-cols-2">
            {steps.map((step, index) => (
              <li key={step} className="grid grid-cols-[2.6rem_1fr] gap-4 border-t border-black pt-4 sm:grid-cols-[3.25rem_1fr]">
                <span className="font-display text-4xl font-semibold leading-none">0{index + 1}</span>
                <span className="text-lg leading-7">{step}</span>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <CtaBand {...props} />
    </>
  );
}

function PlaybookLayout(props: PageShellProps) {
  const { eyebrow, title, intro, heroTitle, heroBody, tone, accent, stats, cards, image, imageAlt, imagePosition, stepsTitle, steps } = props;

  return (
    <>
      <section className="mx-auto grid max-w-[1200px] gap-8 px-4 pb-12 pt-12 sm:px-6 lg:grid-cols-[0.95fr_1.05fr] lg:px-0 lg:pb-20 lg:pt-16">
        <div>
          <p className="mb-4 text-sm font-semibold uppercase tracking-normal">{eyebrow}</p>
          <h1 className="font-display text-[clamp(2.75rem,7vw,5.75rem)] font-semibold leading-[0.9] tracking-normal">{title}</h1>
          <p className="mt-8 max-w-2xl text-xl leading-8 md:text-2xl md:leading-9">{intro}</p>
        </div>
        <FieldVisual accent={accent} title={eyebrow} image={image} imageAlt={imageAlt} imagePosition={imagePosition} stats={stats} />
      </section>

      <section className="border-y-3 border-black bg-[#161616] py-14 text-white md:py-20">
        <div className="mx-auto grid max-w-[1200px] gap-10 px-4 sm:px-6 md:grid-cols-[0.72fr_1.28fr] lg:px-0">
          <div>
            <p className="text-sm font-semibold uppercase tracking-normal text-white/60">Workflow</p>
            <h2 className="mt-4 font-display text-[clamp(2.5rem,5vw,4.5rem)] font-semibold leading-[0.9] tracking-normal">{stepsTitle}</h2>
          </div>
          <ol className="grid gap-4">
            {steps.map((step, index) => (
              <li key={step} className="interactive-card grid grid-cols-[3.8rem_1fr] gap-4 border border-white/25 bg-white/5 p-5 sm:grid-cols-[4.5rem_1fr] sm:gap-5">
                <span className={`grid h-16 w-16 place-items-center border-3 border-black font-display text-3xl font-semibold text-black ${swatch(index)}`}>
                  {index + 1}
                </span>
                <span className="self-center text-xl leading-8">{step}</span>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="mx-auto max-w-[1200px] px-4 py-16 sm:px-6 lg:px-0">
        <div className="grid gap-8">
          <div className={`${tone} border-3 border-black p-8 md:p-10`}>
            <h2 className="font-display text-[clamp(2.25rem,5vw,4rem)] font-semibold leading-[0.9] tracking-normal">{heroTitle}</h2>
            <p className="mt-6 max-w-3xl text-xl leading-8">{heroBody}</p>
          </div>
          {cards.map((card, index) => (
            <article key={card.title} className="interactive-card grid border-t-3 border-black p-4 md:grid-cols-[0.38fr_0.62fr] md:gap-10 md:p-7">
              <div className={`mb-5 h-24 w-24 border-3 border-black ${swatch(index)} md:mb-0`} aria-hidden="true" />
              <div>
                <h2 className="font-display text-3xl font-semibold leading-[0.95] tracking-normal">{card.title}</h2>
                <p className="mt-4 max-w-3xl text-lg leading-7">{card.body}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      <EvidenceBand {...props} />
      <PilotStrip strip={props.pilotStrip} />

      <section className="mx-auto grid max-w-[1200px] border-y-3 border-black md:grid-cols-3 md:border-x-3">
        {stats.map((stat, index) => (
          <article key={stat.label} className="interactive-card border-b-3 border-black p-6 last:border-b-0 md:min-h-[14rem] md:border-b-0 md:border-r-3 md:last:border-r-0">
            <p className="font-display text-[clamp(2.75rem,6vw,5rem)] font-semibold leading-none tracking-normal">{stat.value}</p>
            <p className="mt-7 font-display text-2xl font-semibold leading-[1.02] tracking-normal">{stat.label}</p>
            <p className="mt-4 text-sm font-semibold uppercase tracking-normal text-black/55">Control 0{index + 1}</p>
          </article>
        ))}
      </section>

      <div className="pt-16">
        <CtaBand {...props} />
      </div>
    </>
  );
}

function IndexLayout(props: PageShellProps) {
  const { eyebrow, title, intro, heroTitle, heroBody, tone, stats, cards, stepsTitle, steps } = props;

  return (
    <>
      <IntroHero eyebrow={eyebrow} title={title} intro={intro} />

      <section className={`${tone} border-y-3 border-black py-14 md:py-20`}>
        <div className="mx-auto max-w-[1200px] px-4 sm:px-6 lg:px-0">
          <div className="grid gap-8 md:grid-cols-[1.2fr_1.0fr] md:items-end">
            <h2 className="whitespace-pre-line font-display text-[clamp(2.5rem,6vw,5.25rem)] font-semibold leading-[0.88] tracking-normal">
              {heroTitle}
            </h2>
            <p className="max-w-3xl text-xl leading-8">{heroBody}</p>
          </div>
          <div className="mt-12 grid overflow-hidden border-3 border-black bg-white md:grid-cols-3">
            {stats.map((stat) => (
              <article key={stat.label} className="interactive-card min-h-[21rem] overflow-hidden border-b-3 border-black p-6 last:border-b-0 md:border-b-0 md:border-r-3 md:p-8 md:last:border-r-0">
                <p data-testid="index-stat-value" className={`max-w-full break-words font-display font-semibold tracking-normal ${indexStatValueClass(stat.value)}`}>{stat.value}</p>
                <p className="mt-8 font-display text-[clamp(1.65rem,3vw,2.25rem)] font-semibold leading-[0.95] tracking-normal">{stat.label}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <EvidenceBand {...props} />
      <PilotStrip strip={props.pilotStrip} />

      <section className="mx-auto max-w-[1200px] px-4 py-16 sm:px-6 lg:px-0">
        <div className="grid gap-5 md:grid-cols-[1.1fr_0.9fr]">
          <article className="interactive-card border-3 border-black bg-[#161616] p-8 text-white md:min-h-[32rem] md:p-10">
            <h2 className="font-display text-[clamp(2.25rem,5vw,4rem)] font-semibold leading-[0.9] tracking-normal">{cards[0]?.title}</h2>
            <p className="mt-6 max-w-2xl text-xl leading-8 text-white/78">{cards[0]?.body}</p>
          </article>
          <div className="grid gap-5">
            {cards.slice(1).map((card, index) => (
              <article key={card.title} className={`interactive-card border-3 border-black p-7 ${swatch(index + 1)}`}>
                <h2 className="font-display text-3xl font-semibold leading-[0.95] tracking-normal">{card.title}</h2>
                <p className="mt-5 text-lg leading-7">{card.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-[1200px] px-4 pb-16 sm:px-6 lg:px-0">
        <div className="grid gap-8 border-t-3 border-black pt-10 md:grid-cols-[0.72fr_1.28fr]">
          <h2 className="font-display text-[clamp(2.25rem,5vw,4rem)] font-semibold leading-[0.9] tracking-normal">{stepsTitle}</h2>
          <ol className="grid gap-3">
            {steps.map((step, index) => (
              <li key={step} className="grid grid-cols-[3.25rem_1fr] gap-4 border-b border-black pb-4">
                <span className="font-display text-3xl font-semibold leading-none">0{index + 1}</span>
                <span className="text-xl leading-8">{step}</span>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <CtaBand {...props} />
    </>
  );
}

function EditorialLayout(props: PageShellProps) {
  const { eyebrow, title, intro, heroTitle, heroBody, tone, accent, stats, cards, stepsTitle, steps } = props;

  return (
    <>
      <section className="mx-auto grid max-w-[1200px] gap-8 px-4 pb-12 pt-12 sm:px-6 md:grid-cols-[0.24fr_1.76fr] lg:px-0 lg:pb-20 lg:pt-16">
        <div className={`${accent} hidden min-h-full border-3 border-black md:block`} aria-hidden="true" />
        <div>
          <p className="mb-4 text-sm font-semibold uppercase tracking-normal">{eyebrow}</p>
          <h1 className="max-w-5xl font-display text-[clamp(2.75rem,7vw,5.75rem)] font-semibold leading-[0.9] tracking-normal">{title}</h1>
          <p className="mt-8 max-w-3xl text-xl leading-8 md:text-2xl md:leading-9">{intro}</p>
        </div>
      </section>

      <section className="border-y-3 border-black bg-white py-14 md:py-20">
        <div className="mx-auto grid max-w-[1200px] gap-5 px-4 sm:px-6 md:grid-cols-[1.15fr_0.85fr] lg:px-0">
          <article className={`${tone} interactive-card border-3 border-black p-8 md:min-h-[34rem] md:p-10`}>
            <p className="text-sm font-semibold uppercase tracking-normal text-black/65">Brief</p>
            <h2 className="mt-5 font-display text-[clamp(2.5rem,6vw,5rem)] font-semibold leading-[0.88] tracking-normal">{heroTitle}</h2>
            <p className="mt-7 max-w-2xl text-xl leading-8">{heroBody}</p>
          </article>
          <div className="grid gap-5">
            {stats.map((stat, index) => (
              <article key={stat.label} className={`interactive-card border-3 border-black p-6 ${swatch(index + 1)}`}>
                <p className="font-display text-[clamp(2.5rem,6vw,4.75rem)] font-semibold leading-none tracking-normal">{stat.value}</p>
                <p className="mt-5 font-display text-2xl font-semibold leading-[0.98] tracking-normal">{stat.label}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <EvidenceBand {...props} />
      <PilotStrip strip={props.pilotStrip} />
      <ResourceLinks resources={props.resources} />
      <PartnerMarquee partners={props.partners} />
      <PresentationMoment images={props.presentationImages} />
      <PressLinks press={props.press} />

      <section className="mx-auto max-w-[1200px] px-4 py-16 sm:px-6 lg:px-0">
        <div className="grid gap-5 md:grid-cols-3">
          {cards.map((card, index) => (
            <article key={card.title} className={`interactive-card min-h-[22rem] border-3 border-black p-7 ${index === 1 ? 'md:mt-12' : ''} ${index === 2 ? 'md:mt-24' : ''}`}>
              <p className={`mb-8 h-14 w-14 border-3 border-black ${swatch(index)}`} aria-hidden="true" />
              <h2 className="font-display text-3xl font-semibold leading-[0.95] tracking-normal">{card.title}</h2>
              <p className="mt-5 text-lg leading-7">{card.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-[1200px] px-4 pb-16 sm:px-6 lg:px-0">
        <div className="grid gap-8 border-3 border-black p-6 md:grid-cols-[0.82fr_1.18fr] md:p-10">
          <h2 className="font-display text-[clamp(2.25rem,5vw,4rem)] font-semibold leading-[0.9] tracking-normal">{stepsTitle}</h2>
          <ol className="space-y-4">
            {steps.map((step, index) => (
              <li key={step} className="grid grid-cols-[3rem_1fr] gap-4 border-b-3 border-black pb-4 last:border-b-0">
                <span className="font-display text-3xl font-semibold tracking-normal">{index + 1}</span>
                <span className="text-xl leading-8">{step}</span>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <CtaBand {...props} />
    </>
  );
}

export default function PageShell(props: PageShellProps) {
  const variant = props.variant ?? 'editorial';

  return (
    <>
      <Nav />
      <main id="main-content" className="pt-20">
        {props.structuredData ? <JsonLd data={props.structuredData} /> : null}
        {variant === 'manifesto' ? <ManifestoLayout {...props} /> : null}
        {variant === 'playbook' ? <PlaybookLayout {...props} /> : null}
        {variant === 'index' ? <IndexLayout {...props} /> : null}
        {variant === 'editorial' ? <EditorialLayout {...props} /> : null}
      </main>
      <Footer />
    </>
  );
}
