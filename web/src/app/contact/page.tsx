import Link from 'next/link';
import Footer from '@/components/Footer';
import Nav from '@/components/Nav';
import { JsonLd, breadcrumbSchema, contactPageSchema, graph } from '@/lib/json-ld';
import { pageMetadata } from '@/lib/metadata';
import { PILOT, SITE } from '@/lib/site';

export const metadata = pageMetadata({
  title: 'Contact SafeRide',
  absoluteTitle: true,
  description:
    `Contact SafeRide about partnerships, safeguarding review, security reports, or the ${PILOT.summary}. We don't collect sensitive details by email.`,
  path: '/contact',
});

const contactRoutes = [
  {
    label: 'Pilot partnerships',
    title: 'Talk to SafeRide about a pilot.',
    body: 'For SACCOs, support organizations, county teams, funders, and reviewers who want to discuss the Mombasa pilot or a careful next deployment.',
    subject: 'SafeRide pilot partnership inquiry',
  },
  {
    label: 'Safeguarding review',
    title: 'Review privacy, referral, or survivor-facing language.',
    body: 'For GBV, legal, medical, psychosocial, privacy, and child-safeguarding reviewers checking the pilot posture.',
    subject: 'SafeRide safeguarding review inquiry',
  },
  {
    label: 'Open-source review',
    title: 'Inspect the stack or contribute to hardening.',
    body: 'For engineers and civic-tech reviewers looking at the Android app, content packs, model roadmap, or first-party pilot API.',
    subject: 'SafeRide source and model review inquiry',
  },
] as const;

const mailto = (subject: string) => `mailto:${SITE.contactEmail}?subject=${encodeURIComponent(subject)}`;

export default function Page() {
  return (
    <>
      <Nav />
      <main id="main-content" className="bg-white pt-20">
        <JsonLd
          id="contact-structured-data"
          data={graph([breadcrumbSchema([{ name: 'Contact', path: '/contact' }]), contactPageSchema()])}
        />
        <section className="mx-auto max-w-[1200px] px-4 py-14 sm:px-6 lg:px-0 lg:py-20">
          <p className="mb-4 text-sm font-semibold uppercase tracking-normal text-green-800">Contact SafeRide</p>
          <h1 className="max-w-5xl font-display text-[clamp(2.75rem,7vw,5.75rem)] font-semibold leading-[0.9] tracking-normal text-green-950">
            Talk to the SafeRide team.
          </h1>
          <p className="mt-8 max-w-3xl text-xl leading-8 text-green-950/80 md:text-2xl md:leading-9">
            SafeRide is privacy-first, so this site does not collect contact messages in a web form. Use the general pilot inbox for partnership, review, and implementation conversations.
          </p>
        </section>

        <section className="border-y-3 border-black bg-[#F7EC36] py-12 md:py-16" aria-labelledby="contact-options">
          <div className="mx-auto max-w-[1200px] px-4 sm:px-6 lg:px-0">
            <div className="grid gap-6 md:grid-cols-[0.8fr_1.2fr] md:items-start">
              <div>
                <h2 id="contact-options" className="font-display text-[clamp(2.25rem,5vw,4rem)] font-semibold leading-[0.9] tracking-normal text-green-950">
                  Choose a route.
                </h2>
                <p className="mt-5 text-lg leading-8 text-green-950/75">
                  Please do not send survivor evidence, identity details, exact routes, or private incident descriptions through this inbox.
                </p>
              </div>
              <div className="grid gap-4">
                {contactRoutes.map((route, index) => (
                  <article key={route.label} className="border-3 border-black bg-white p-6 shadow-[5px_5px_0_#0D1B12]">
                    <p className="font-display text-xs font-semibold uppercase tracking-normal text-green-700">0{index + 1} / {route.label}</p>
                    <h3 className="mt-3 font-display text-3xl font-semibold leading-[0.96] tracking-normal text-green-950">{route.title}</h3>
                    <p className="mt-4 max-w-2xl text-lg leading-7 text-green-950/75">{route.body}</p>
                    <Link
                      href={mailto(route.subject)}
                      className="mt-6 inline-flex border-3 border-black bg-[#53E17C] px-5 py-3 font-display font-semibold text-green-950 transition hover:-translate-x-1 hover:-translate-y-1 hover:shadow-[4px_4px_0_#0D1B12]"
                    >
                      Email the pilot inbox
                    </Link>
                  </article>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="mx-auto grid max-w-[1200px] gap-6 px-4 py-16 sm:px-6 md:grid-cols-3 lg:px-0">
          <div className="border-3 border-black bg-[#50C9F0] p-6">
            <h2 className="font-display text-3xl font-semibold leading-none tracking-normal">General inbox</h2>
            <p className="mt-5 break-words text-lg font-bold text-green-950">{SITE.contactEmail}</p>
          </div>
          <div className="border-3 border-black bg-white p-6">
            <h2 className="font-display text-3xl font-semibold leading-none tracking-normal">Open source</h2>
            <p className="mt-5 text-lg leading-7 text-green-950/75">Review public code, pilot notes, and model roadmap materials through the SafeRide repository.</p>
            <Link href={SITE.github} target="_blank" rel="noreferrer" className="mt-5 inline-flex border-b-3 border-black pb-1 font-bold text-green-950">
              View GitHub
            </Link>
          </div>
          <div className="border-3 border-black bg-[#F88539] p-6">
            <h2 className="font-display text-3xl font-semibold leading-none tracking-normal">Privacy posture</h2>
            <p className="mt-5 text-lg leading-7 text-green-950/75">Use the privacy page to check consent, retention, redaction, and backend migration claims before contacting the team.</p>
            <Link href="/privacy-safety-trust" className="mt-5 inline-flex border-b-3 border-black pb-1 font-bold text-green-950">
              Review privacy
            </Link>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
