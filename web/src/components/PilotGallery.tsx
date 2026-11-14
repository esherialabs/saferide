/* eslint-disable @next/next/no-img-element */
import Link from 'next/link';
import { PILOT_PHOTOS, type PilotPhoto } from '@/lib/pilotPhotos';
import { PILOT } from '@/lib/site';

type FigureProps = {
  photo: PilotPhoto;
  /** Grid span on large screens, e.g. "lg:col-span-6" */
  span?: string;
  /** Fixed height on large screens, e.g. "lg:h-[24rem]"; the photo is cropped to fit */
  height?: string;
  position?: string;
  /** Fill a frame that a neighbour stretches taller than the photo's own shape (cropped to fit) */
  fill?: boolean;
};

function Figure({ photo, span = '', height = '', position = 'object-top lg:object-center', fill = false }: FigureProps) {
  return (
    <figure
      data-testid="pilot-gallery-figure"
      className={`interactive-card flex flex-col overflow-hidden border-3 border-black bg-white shadow-[5px_5px_0_#0D1B12] ${span}`}
    >
      <div className={`relative min-h-0 flex-1 overflow-hidden bg-[#F2F2F2] ${height} ${fill ? 'lg:min-h-[14rem]' : ''}`}>
        <img
          src={photo.src}
          alt={photo.alt}
          width={photo.width}
          height={photo.height}
          loading="lazy"
          decoding="async"
          className={`h-auto max-h-[30rem] w-full object-cover lg:max-h-none ${height ? 'lg:h-full' : ''} ${fill ? 'lg:absolute lg:inset-0 lg:h-full lg:object-cover' : ''} ${position}`}
        />
      </div>
      <figcaption className="border-t-3 border-black p-4 text-sm font-semibold leading-6 text-black/72">{photo.caption}</figcaption>
    </figure>
  );
}

function Chapter({
  id,
  number,
  title,
  children,
  tone = 'bg-white',
}: {
  id: string;
  number: string;
  title: string;
  children: React.ReactNode;
  tone?: string;
}) {
  return (
    <section id={id} data-testid={`pilot-chapter-${id}`} aria-labelledby={`${id}-heading`} className={`border-b-3 border-black ${tone} py-14 md:py-20`}>
      <div className="mx-auto max-w-[1200px] px-4 sm:px-6 lg:px-0">
        <p className="font-display text-sm font-semibold uppercase tracking-normal text-green-800">{number}</p>
        <h2
          id={`${id}-heading`}
          className="mt-2 max-w-3xl hyphens-none font-display text-[clamp(2rem,4.6vw,3.6rem)] font-semibold leading-[0.95] tracking-normal text-green-950"
        >
          {title}
        </h2>
        {children}
      </div>
    </section>
  );
}

const P = 'mt-5 max-w-2xl text-lg leading-8 text-green-950/78';

export default function PilotGallery() {
  const p = PILOT_PHOTOS;

  return (
    <>
      <section className="border-b-3 border-black bg-[#F7EC36] py-16 md:py-24" aria-labelledby="pilot-gallery-title">
        <div className="mx-auto grid max-w-[1200px] gap-10 px-4 sm:px-6 lg:grid-cols-[1fr_0.9fr] lg:items-center lg:px-0">
          <div>
            <p className="font-display text-sm font-semibold uppercase tracking-normal text-green-900">
              {PILOT.name} / {PILOT.startedAt}
            </p>
            <h1
              id="pilot-gallery-title"
              className="mt-4 hyphens-none font-display text-[clamp(2.8rem,7vw,6rem)] font-semibold leading-[0.9] tracking-normal text-green-950"
            >
              The pilot, in pictures.
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-8 text-green-950/80">
              {PILOT.description} These photographs come from the partner briefing, hands-on demonstrations and a
              community day in {PILOT.region}.
            </p>
            <p className="mt-4 max-w-xl border-l-3 border-black pl-4 text-sm font-semibold leading-6 text-green-950/75">
              The photographs show demonstrations and events. Nothing here comes from a survivor’s report.
            </p>
            <nav aria-label="Pilot chapters" className="mt-8 flex flex-wrap gap-2 text-sm font-semibold">
              {[
                ['#briefing', 'The briefing'],
                ['#live-demo', 'Live demo'],
                ['#hands-on', 'Hands-on'],
                ['#community', 'Community day'],
                ['#team', 'The team'],
              ].map(([href, label]) => (
                <a key={href} href={href} className="border-3 border-black bg-white px-3 py-1.5 text-green-950">
                  {label}
                </a>
              ))}
            </nav>
          </div>
          <figure className="interactive-card overflow-hidden border-3 border-black bg-white shadow-[8px_8px_0_#0D1B12]">
            <img
              src={p.demoBanner.src}
              alt={p.demoBanner.alt}
              width={p.demoBanner.width}
              height={p.demoBanner.height}
              decoding="async"
              className="h-auto w-full"
            />
            <figcaption className="border-t-3 border-black p-4 text-sm font-semibold leading-6 text-black/72">{p.demoBanner.caption}</figcaption>
          </figure>
        </div>
      </section>

      <Chapter id="briefing" number="01" title="It started with the partner’s team.">
        <p className={P}>
          The pilot began with a briefing for the partner team. Facilitators walked through why SafeRide exists, how
          the path to justice breaks, and the rule everything else rests on: the rider decides what leaves her phone.
        </p>
        <div className="mt-10 grid gap-5 lg:grid-cols-12">
          <Figure photo={p.presenter} span="lg:col-span-4" position="object-[82%_50%]" fill />
          <div className="grid gap-5 lg:col-span-8">
            <Figure photo={p.briefingGesture} />
            <Figure photo={p.briefingPointing} />
          </div>
          <Figure photo={p.briefing} span="lg:col-span-12" />
        </div>
      </Chapter>

      <Chapter id="live-demo" number="02" title="Then a live demo." tone="bg-[#FFF8D6]">
        <p className={P}>
          The briefing included a live demo, with a QR code on the screen and phones out around the table. Questions
          came up as it went, and the team took them there and then.
        </p>
        <div className="mt-10 grid gap-5 lg:grid-cols-2">
          <Figure photo={p.liveDemoTalk} fill />
          <Figure photo={p.liveDemoClap} fill />
        </div>
      </Chapter>

      <Chapter id="hands-on" number="03" title="Hands-on, on real phones.">
        <p className={P}>{PILOT.approach}</p>
        <div className="mt-10 grid gap-5 lg:grid-cols-12">
          <Figure photo={p.demoLively} span="lg:col-span-6" height="lg:h-[26rem]" />
          <Figure photo={p.handson} span="lg:col-span-6" height="lg:h-[26rem]" position="object-[40%_50%]" />
        </div>
      </Chapter>

      <Chapter id="community" number="04" title="Out with the community." tone="bg-[#E8F7EE]">
        <p className={P}>
          SafeRide also went where people gather: a community day under tents in {PILOT.region}, with the banner up and
          team members showing the app to one person at a time.
        </p>
        <div className="mt-10 grid gap-5 lg:grid-cols-12">
          <Figure photo={p.communityPanel} span="lg:col-span-6" height="lg:h-[28rem]" />
          <Figure photo={p.communityApp} span="lg:col-span-3" height="lg:h-[28rem]" position="object-top" />
          <Figure photo={p.communityBanner} span="lg:col-span-3" height="lg:h-[28rem]" position="object-top" />
        </div>
      </Chapter>

      <Chapter id="team" number="05" title="The people in the room.">
        <p className={P}>{PILOT.feedback}</p>
        <div className="mt-10 grid gap-5 lg:grid-cols-12">
          <Figure photo={p.teamSmiling} span="lg:col-span-12" />
          <Figure photo={p.teamFour} span="lg:col-span-7" position="object-top" fill />
          <div className="interactive-card border-3 border-black bg-white p-7 shadow-[5px_5px_0_#0D1B12] lg:col-span-5">
            <dl className="grid gap-5">
              {[
                ['Partner', PILOT.partner],
                ['Areas', PILOT.areas],
                ['When', PILOT.startedAt],
              ].map(([label, value]) => (
                <div key={label} className="border-t-3 border-black pt-3">
                  <dt className="text-xs font-semibold uppercase tracking-normal text-green-800">{label}</dt>
                  <dd className="mt-1 font-display text-2xl font-semibold leading-[1] tracking-normal text-green-950">{value}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-6 text-sm font-semibold leading-6 text-green-950/72">{PILOT.privacy}</p>
          </div>
        </div>
      </Chapter>

      <section className="bg-[#0D1B12] py-14 md:py-16" aria-label="Next steps">
        <div className="mx-auto flex max-w-[1200px] flex-wrap items-center justify-between gap-6 px-4 sm:px-6 lg:px-0">
          <p className="max-w-xl font-display text-2xl font-semibold leading-[1.05] tracking-normal text-white">
            Want the findings, not just the photographs?
          </p>
          <div className="flex flex-wrap gap-3">
            <Link href="/impact" className="interactive-button border-3 border-black bg-[#53E17C] px-5 py-3 font-display font-semibold text-green-950">
              Read the overview
            </Link>
            <Link href="/partners" className="interactive-button border-3 border-black bg-white px-5 py-3 font-display font-semibold text-green-950">
              Meet the pilot partner
            </Link>
            <Link href="/privacy-safety-trust" className="interactive-button border-3 border-black bg-white px-5 py-3 font-display font-semibold text-green-950">
              How privacy works
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
