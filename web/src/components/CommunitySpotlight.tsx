/* eslint-disable @next/next/no-img-element */
'use client';

import { useState } from 'react';

type SpotlightItem = {
  name: string;
  role: string;
  quote: string;
  tone: string;
  image: string;
  imageAlt: string;
};

function ArrowIcon({ direction }: { direction: 'previous' | 'next' }) {
  return (
    <svg className={`h-5 w-5 ${direction === 'previous' ? 'rotate-180' : ''}`} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M4 10h11m0 0-4-4m4 4-4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function CommunitySpotlight({ items }: { items: readonly SpotlightItem[] }) {
  const [activeCard, setActiveCard] = useState(0);

  const goToCard = (index: number) => {
    setActiveCard((index + items.length) % items.length);
  };

  return (
    <section data-testid="community-spotlight" className="border-y-3 border-black bg-[#53E17C] py-16 md:py-24" aria-labelledby="community-heading">
      <div className="mx-auto max-w-[1200px] px-4 sm:px-6 lg:px-0">
        <div className="grid gap-8 md:grid-cols-[0.85fr_1.15fr] md:items-end">
          <div>
            <p className="font-display text-sm font-semibold uppercase tracking-normal text-green-950">Community Spotlight</p>
            <h2 id="community-heading" className="mt-3 font-display text-[clamp(2.5rem,6vw,5.25rem)] font-semibold leading-[0.9] tracking-normal text-green-950">
              What the pilot included.
            </h2>
          </div>
          <div className="flex items-center gap-4 md:justify-self-end">
            <p className="font-display text-2xl font-semibold tracking-normal" aria-live="polite">
              {activeCard + 1} / {items.length}
            </p>
            <div className="flex gap-3">
              <button
                type="button"
                aria-label="Previous spotlight"
                className="interactive-button grid h-12 w-12 place-items-center border-3 border-black bg-white text-green-950"
                onClick={() => goToCard(activeCard - 1)}
              >
                <ArrowIcon direction="previous" />
              </button>
              <button
                type="button"
                aria-label="Next spotlight"
                className="interactive-button grid h-12 w-12 place-items-center border-3 border-black bg-white text-green-950"
                onClick={() => goToCard(activeCard + 1)}
              >
                <ArrowIcon direction="next" />
              </button>
            </div>
          </div>
        </div>

        {/* All cards stay in the DOM (crawlable/indexable); only visibility is
            toggled client-side. See web/SEO_REMEDIATION_PLAN.md P1-7. */}
        <div className="mt-10" aria-live="polite">
          {items.map((item, index) => (
            <article
              key={item.name}
              className={`interactive-card overflow-hidden border-3 border-black bg-white shadow-[8px_8px_0_#0D1B12] md:grid-cols-[0.9fr_1.1fr] ${
                activeCard === index ? 'grid' : 'hidden'
              }`}
            >
              <div className="relative min-h-[22rem] border-b-3 border-black bg-green-100 md:min-h-[34rem] md:border-b-0 md:border-r-3">
                <img
                  src={item.image}
                  alt={item.imageAlt}
                  loading="lazy"
                  decoding="async"
                  className="absolute inset-0 h-full w-full object-cover"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-white/10" aria-hidden="true" />
              </div>
              <div className="flex min-h-[25rem] flex-col justify-center p-7 md:p-12">
                <p className="font-display text-sm font-semibold uppercase tracking-normal text-green-700">{item.role}</p>
                <h3 className="mt-4 font-display text-[clamp(2.25rem,5vw,4rem)] font-semibold leading-[0.9] tracking-normal text-green-950">
                  {item.name}
                </h3>
                <p className="mt-7 max-w-2xl font-accent text-2xl italic leading-9 text-green-900">&quot;{item.quote}&quot;</p>
              </div>
            </article>
          ))}
        </div>

        <div className="mt-7 grid gap-3 md:grid-cols-3" aria-label="Spotlight selector">
          {items.map((item, index) => (
            <button
              key={item.name}
              type="button"
              aria-current={activeCard === index ? 'true' : undefined}
              className={`interactive-button border-3 border-black p-4 text-left ${
                activeCard === index ? 'bg-green-950 text-white' : 'bg-white text-green-950'
              }`}
              onClick={() => goToCard(index)}
            >
              <span className="block font-display text-xs font-semibold uppercase tracking-normal opacity-70">0{index + 1}</span>
              <span className="mt-2 block font-display text-xl font-semibold tracking-normal">{item.name}</span>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
