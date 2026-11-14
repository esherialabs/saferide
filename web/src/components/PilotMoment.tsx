/* eslint-disable @next/next/no-img-element */
import Link from 'next/link';
import { PILOT_PHOTOS } from '@/lib/pilotPhotos';
import { PILOT } from '@/lib/site';

export default function PilotMoment() {
  return (
    <section
      data-testid="mombasa-pilot"
      className="border-y-3 border-black bg-[#F7EC36] py-14 md:py-20"
      aria-labelledby="mombasa-pilot-heading"
    >
      <div className="mx-auto grid max-w-[1200px] gap-8 px-4 sm:px-6 lg:grid-cols-[0.92fr_1.08fr] lg:items-stretch lg:px-0">
        <div className="border-3 border-black bg-white p-7 md:p-10">
          <p className="font-display text-sm font-semibold uppercase tracking-normal text-green-800">
            {PILOT.name} / {PILOT.startedAt}
          </p>
          <h2
            id="mombasa-pilot-heading"
            className="mt-4 max-w-2xl font-display text-[clamp(2.4rem,5vw,4.5rem)] font-semibold leading-[0.9] tracking-normal text-green-950"
          >
            The pilot has run.
          </h2>
          <p className="mt-6 max-w-2xl text-lg leading-8 text-green-950/78">{PILOT.description}</p>
          <div className="mt-5 max-w-2xl space-y-4 text-base leading-7 text-green-950/78">
            <p>{PILOT.approach}</p>
            <p>{PILOT.partnerPath}</p>
            <p>{PILOT.feedback}</p>
            <p>{PILOT.continuity}</p>
          </div>
          <p className="mt-5 max-w-2xl border-l-3 border-black pl-4 text-sm font-semibold leading-6 text-green-950/72">
            {PILOT.privacy}
          </p>

          <dl className="mt-8 grid gap-3 sm:grid-cols-3">
            {[
              ['Status', 'Pilot run'],
              ['Partner', 'HURIA'],
              ['Areas', PILOT.areas],
            ].map(([label, value]) => (
              <div key={label} className="border-t-3 border-black pt-3">
                <dt className="text-xs font-semibold uppercase tracking-normal text-green-800">{label}</dt>
                <dd className="mt-1 font-display text-2xl font-semibold leading-[0.95] tracking-normal text-green-950">{value}</dd>
              </div>
            ))}
          </dl>

          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              href="/impact"
              className="interactive-button border-3 border-black bg-[#53E17C] px-5 py-3 font-display font-semibold text-green-950"
            >
              Read the overview
            </Link>
            <Link
              href="/partners"
              className="interactive-button border-3 border-black bg-white px-5 py-3 font-display font-semibold text-green-950"
            >
              Meet the pilot partner
            </Link>
          </div>
        </div>

        <div className="flex flex-col gap-4">
          <figure className="interactive-card flex-1 overflow-hidden border-3 border-black bg-[#53E17C] shadow-[8px_8px_0_#0D1B12]">
            <div className="relative h-full min-h-[20rem] md:min-h-[24rem]">
              <img
                data-testid="mombasa-pilot-image"
                width={PILOT_PHOTOS.handson.width}
                height={PILOT_PHOTOS.handson.height}
                src={PILOT_PHOTOS.handson.src}
                alt={PILOT_PHOTOS.handson.alt}
                loading="lazy"
                decoding="async"
                className="absolute inset-0 h-full w-full object-cover"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-black/55 via-transparent to-white/10" aria-hidden="true" />
              <figcaption className="absolute bottom-5 left-5 right-5 border-3 border-black bg-white p-4 text-sm font-semibold leading-6 text-green-950">
                {PILOT_PHOTOS.handson.caption}
              </figcaption>
            </div>
          </figure>
          <figure className="interactive-card overflow-hidden border-3 border-black bg-white shadow-[8px_8px_0_#0D1B12]">
            <img
              data-testid="mombasa-region-map"
              src="/images/mombasa-region-map.svg"
                alt="Mombasa subcounty boundaries with the Changamwe and Likoni pilot areas highlighted"
              loading="lazy"
              decoding="async"
              className="h-auto w-full"
            />
            <figcaption className="border-t-3 border-black p-4 text-sm font-semibold leading-6 text-green-950/75">
              Pilot areas in Mombasa: Changamwe and Likoni. Broad subcounty boundaries only; no case locations are shown.
            </figcaption>
          </figure>
        </div>
      </div>
    </section>
  );
}
