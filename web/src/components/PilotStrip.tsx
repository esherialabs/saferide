/* eslint-disable @next/next/no-img-element */
import Link from 'next/link';
import type { PilotPhoto } from '@/lib/pilotPhotos';

export type PilotStripData = {
  eyebrow: string;
  title: string;
  intro: string;
  /** One to three photographs (two suits most of these wide frames); none may repeat on a page (tests enforce it). */
  photos: readonly PilotPhoto[];
};

const NOTE = 'These photographs show briefings, demonstrations and events. Nothing here comes from a survivor’s report.';

const NOTE_ONE = 'This photograph shows a briefing, demonstration or event. Nothing here comes from a survivor’s report.';

const GRID: Record<number, string> = {
  1: 'lg:grid-cols-1',
  2: 'lg:grid-cols-2',
  3: 'lg:grid-cols-3',
};

// A photo section for an interior page: a heading tied to the page's topic, one or two
// sentences, up to three photographs and the boundary note. Tiles share one height on
// large screens (the photo fills it) and keep their own shape on phones.
export default function PilotStrip({ strip }: { strip?: PilotStripData }) {
  if (!strip || strip.photos.length === 0) {
    return null;
  }

  const count = Math.min(strip.photos.length, 3);
  const single = count === 1;

  if (single) {
    const photo = strip.photos[0];

    return (
      <section
        data-testid="pilot-strip"
        className="border-b-3 border-black bg-white py-14 md:py-16"
        aria-labelledby="pilot-strip-heading"
      >
        <div className="mx-auto grid max-w-[1200px] gap-8 px-4 sm:px-6 lg:grid-cols-[0.9fr_1.1fr] lg:items-center lg:px-0">
          <div>
            <p className="text-sm font-semibold uppercase tracking-normal text-green-800">{strip.eyebrow}</p>
            <h2
              id="pilot-strip-heading"
              className="mt-2 max-w-2xl hyphens-none font-display text-[clamp(2rem,4.4vw,3.4rem)] font-semibold leading-[0.95] tracking-normal text-green-950"
            >
              {strip.title}
            </h2>
            <p className="mt-5 max-w-xl text-lg leading-8 text-green-950/78">{strip.intro}</p>
            <p className="mt-5 max-w-xl border-l-3 border-black pl-4 text-sm font-semibold leading-6 text-green-950/70">{NOTE_ONE}</p>
            <Link
              href="/pilot"
              className="interactive-button mt-6 inline-block border-3 border-black bg-[#53E17C] px-5 py-3 font-display font-semibold text-green-950"
            >
              See the pilot in pictures
            </Link>
          </div>
          <figure
            data-testid="pilot-strip-figure"
            className="interactive-card overflow-hidden border-3 border-black bg-white shadow-[5px_5px_0_#0D1B12]"
          >
            <img
              src={photo.src}
              alt={photo.alt}
              width={photo.width}
              height={photo.height}
              loading="lazy"
              decoding="async"
              className="h-auto w-full"
            />
            <figcaption className="border-t-3 border-black p-4 text-sm font-semibold leading-6 text-black/70">
              {photo.caption}
            </figcaption>
          </figure>
        </div>
      </section>
    );
  }

  return (
    <section
      data-testid="pilot-strip"
      className="border-b-3 border-black bg-white py-14 md:py-16"
      aria-labelledby="pilot-strip-heading"
    >
      <div className="mx-auto max-w-[1200px] px-4 sm:px-6 lg:px-0">
        <div className="grid gap-4 lg:grid-cols-[0.8fr_1.2fr] lg:items-end">
          <div>
            <p className="text-sm font-semibold uppercase tracking-normal text-green-800">{strip.eyebrow}</p>
            <h2
              id="pilot-strip-heading"
              className="mt-2 max-w-2xl hyphens-none font-display text-[clamp(2rem,4.4vw,3.4rem)] font-semibold leading-[0.95] tracking-normal text-green-950"
            >
              {strip.title}
            </h2>
          </div>
          <p className="max-w-2xl text-lg leading-8 text-green-950/78">{strip.intro}</p>
        </div>

        <div className={`mt-8 grid gap-5 ${GRID[count]}`}>
          {strip.photos.slice(0, 3).map((photo) => (
            <figure
              key={photo.src}
              data-testid="pilot-strip-figure"
              className="interactive-card flex flex-col overflow-hidden border-3 border-black bg-white shadow-[5px_5px_0_#0D1B12]"
            >
              <div className={`overflow-hidden bg-[#F2F2F2] ${count === 2 ? 'lg:h-[19rem]' : 'lg:h-[16rem]'}`}>
                <img
                  src={photo.src}
                  alt={photo.alt}
                  width={photo.width}
                  height={photo.height}
                  loading="lazy"
                  decoding="async"
                  className={`h-auto max-h-[26rem] w-full object-cover object-top ${
                    `lg:h-full lg:max-h-none ${photo.focus ?? 'lg:object-center'}`
                  }`}
                />
              </div>
              <figcaption className="flex-1 border-t-3 border-black p-4 text-sm font-semibold leading-6 text-black/70">
                {photo.caption}
              </figcaption>
            </figure>
          ))}
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-between gap-4">
          <p className="max-w-2xl border-l-3 border-black pl-4 text-sm font-semibold leading-6 text-green-950/70">{NOTE}</p>
          <Link
            href="/pilot"
            className="interactive-button border-3 border-black bg-[#53E17C] px-5 py-3 font-display font-semibold text-green-950"
          >
            See the pilot in pictures
          </Link>
        </div>
      </div>
    </section>
  );
}
