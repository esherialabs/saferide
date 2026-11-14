/* eslint-disable @next/next/no-img-element */
import Link from 'next/link';
import { PILOT_PHOTOS, type PilotPhoto } from '@/lib/pilotPhotos';

type Tile = {
  photo: PilotPhoto;
  /** Grid span on large screens (of 12) */
  span: string;
  /** Row height on large screens; the photo fills it and is cropped to fit */
  height: string;
  position?: string;
};

const ROWS: Tile[][] = [
  [
    { photo: PILOT_PHOTOS.demoBanner, span: 'lg:col-span-6', height: 'lg:h-[26rem]', position: 'object-[30%_50%]' },
    { photo: PILOT_PHOTOS.communityApp, span: 'lg:col-span-3', height: 'lg:h-[26rem]', position: 'object-top' },
    { photo: PILOT_PHOTOS.presenter, span: 'lg:col-span-3', height: 'lg:h-[26rem]', position: 'object-top' },
  ],
];

function PhotoTile({ photo, span, height, position = 'object-top lg:object-center' }: Tile) {
  return (
    <figure
      data-testid="pilot-banner-tile"
      className={`interactive-card group relative overflow-hidden border-3 border-black bg-white shadow-[6px_6px_0_#F7EC36] ${span} ${height}`}
    >
      <img
        src={photo.src}
        alt={photo.alt}
        width={photo.width}
        height={photo.height}
        loading="lazy"
        decoding="async"
        className={`h-auto max-h-[26rem] w-full object-cover lg:h-full lg:max-h-none ${position}`}
      />
      <figcaption className="absolute bottom-3 left-3 border-3 border-black bg-white px-3 py-1.5 text-xs font-semibold uppercase tracking-normal text-green-950">
        {photo.label}
      </figcaption>
    </figure>
  );
}

export default function PilotBanner() {
  return (
    <section
      data-testid="pilot-banner"
      aria-labelledby="pilot-banner-heading"
      className="border-y-3 border-black bg-[#0D1B12] py-14 md:py-20"
    >
      <div className="mx-auto max-w-[1400px] px-4 sm:px-6 lg:px-8">
        <div className="max-w-3xl">
          <p className="font-display text-sm font-semibold uppercase tracking-normal text-[#F7EC36]">
            From the pilot / Mombasa, October 2026
          </p>
          <h2
            id="pilot-banner-heading"
            className="mt-3 font-display text-[clamp(2.6rem,6vw,5.2rem)] font-semibold leading-[0.92] tracking-normal text-white"
          >
            SafeRide, out in the field.
          </h2>
          <p className="mt-5 max-w-2xl text-lg leading-8 text-white/80">
            Real photographs from the supervised pilot with HURIA: a hands-on demonstration beside the SafeRide
            banner, and team members showing the app at a community day in Mombasa.
          </p>
        </div>

        <div className="mt-10 space-y-4">
          {ROWS.map((row, index) => (
            <div key={index} className="grid gap-4 lg:grid-cols-12">
              {row.map((tile) => (
                <PhotoTile key={tile.photo.src} {...tile} />
              ))}
            </div>
          ))}

        </div>

        <div className="mt-10 flex flex-wrap gap-3">
          <Link
            href="/pilot"
            className="interactive-button border-3 border-black bg-[#53E17C] px-5 py-3 font-display font-semibold text-green-950"
          >
            See the pilot in pictures
          </Link>
          <Link
            href="/impact"
            className="interactive-button border-3 border-black bg-white px-5 py-3 font-display font-semibold text-green-950"
          >
            Read the overview
          </Link>
        </div>
      </div>
    </section>
  );
}
