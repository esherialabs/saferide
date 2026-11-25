import Link from 'next/link';
import { PILOT, SITE } from '@/lib/site';

export default function FundCTA() {
  return (
    <section data-testid="fund-cta" className="bg-white py-16" aria-labelledby="fund-heading">
      <div className="mx-auto max-w-content px-4 sm:px-6 lg:px-8">
        <div className="interactive-card border border-black bg-green-900 p-8 text-white md:p-12">
          <div className="grid gap-10 lg:grid-cols-[1.4fr_0.6fr] lg:items-center">
            <div>
              <p className="font-body text-sm font-bold uppercase tracking-normal text-[#FF9E5F]">Support the Mombasa Pilot</p>
              <h2 id="fund-heading" className="mt-4 max-w-3xl font-display text-[clamp(2.25rem,5vw,4.5rem)] font-semibold leading-[0.95] tracking-normal text-white">
                The pilot has run. Help us learn safely.
              </h2>
              <p className="mt-6 max-w-2xl text-lg leading-8 text-green-200">
                SafeRide ran a {PILOT.summary} with {PILOT.partner}. Support the next phase of testing, review, and responsible delivery.
              </p>
            </div>
            <div className="grid gap-4">
              <Link
                href={SITE.cta.donate.href}
                className="interactive-button bg-[#FF9E5F] px-10 py-4 text-center font-body font-bold text-black hover:bg-[#F7EC36]"
              >
                {SITE.cta.donate.label}
              </Link>
              <Link
                href={SITE.cta.secondary.href}
                className="interactive-button border border-white px-10 py-4 text-center font-body font-bold text-white hover:bg-white/10"
              >
                Partner with Us
              </Link>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
