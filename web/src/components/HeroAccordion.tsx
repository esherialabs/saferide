/* eslint-disable @next/next/no-img-element */
'use client';

import Link from 'next/link';
import { useState } from 'react';
import BrandWordmark from '@/components/BrandWordmark';
import { PARENT_ORG } from '@/lib/site';

type HeroPanel = {
  eyebrow: string;
  label: string;
  headline: string;
  body: string;
  cta: { label: string; href: string };
  tone: string;
  imageTone: string;
  motif: string;
  image: string;
  imageSrcSet: string;
  imageWidth: number;
  imageHeight: number;
  imageAlt: string;
};

const waveformHeights = [
  'h-[38px]',
  'h-[67px]',
  'h-[96px]',
  'h-[125px]',
  'h-[44px]',
  'h-[73px]',
  'h-[102px]',
  'h-[131px]',
  'h-[50px]',
  'h-[79px]',
  'h-[108px]',
  'h-[137px]',
  'h-[56px]',
] as const;

function VisualMotif({ motif, active }: { motif: string; active: boolean }) {
  return (
    <div className="absolute inset-0 overflow-hidden" aria-hidden="true">
      {motif === 'audio waveform' && (
        <div className="absolute inset-x-8 top-1/2 flex -translate-y-1/2 items-center justify-center gap-3">
          {waveformHeights.map((height, index) => (
            <span
              key={index}
              className={`${height} w-3 rounded-full bg-white/80 shadow-[0_0_0_2px_rgba(0,0,0,0.25)]`}
            />
          ))}
        </div>
      )}
      {motif === 'pilot tags' && (
        <ul className="absolute left-4 top-4 flex flex-col items-start gap-2 text-xs font-semibold uppercase tracking-normal text-green-950 md:text-sm">
          {['Community day', 'Mombasa', 'With HURIA'].map(tag => (
            <li key={tag} className="border-3 border-black bg-white px-3 py-1.5 shadow-[3px_3px_0_#0D1B12]">
              {tag}
            </li>
          ))}
        </ul>
      )}
      {motif === 'open code' && (
        <div className="absolute inset-8 grid content-center gap-4 font-mono text-3xl font-semibold text-white/90 drop-shadow-[0_2px_8px_rgba(0,0,0,0.7)] md:text-5xl">
          <span>{'<report />'}</span>
          <span className="translate-x-8">{'privacy: local;'}</span>
          <span>{'route.score()'}</span>
        </div>
      )}
      <div
        className={`absolute inset-0 bg-[radial-gradient(circle_at_25%_25%,rgba(255,255,255,0.55),transparent_30%),linear-gradient(135deg,transparent,rgba(0,0,0,0.16))] transition-opacity ${
          active ? 'opacity-100' : 'opacity-70'
        }`}
      />
    </div>
  );
}

export default function HeroAccordion({ panels }: { panels: readonly HeroPanel[] }) {
  const [activePanel, setActivePanel] = useState(0);

  return (
    <header className="pt-20">
      <section className="mx-auto max-w-content px-4 pb-8 pt-8 sm:px-6 lg:px-8 lg:pt-10" aria-labelledby="home-title">
        <p className="max-w-5xl font-display text-[clamp(4rem,10vw,8rem)] font-bold leading-[0.88] tracking-normal text-black">
          <BrandWordmark />
        </p>
        <h1 id="home-title" className="mt-2 max-w-4xl font-display text-[clamp(1.75rem,4vw,3.25rem)] font-semibold leading-[0.95] tracking-normal text-black">
          A private safety app for women on Kenya&apos;s public transport
        </h1>
        <p data-testid="home-affiliation" className="mt-5 max-w-3xl text-base leading-7 text-green-900 sm:text-lg">
          SafeRide is developed by{' '}
          <Link
            href={PARENT_ORG.url}
            target="_blank"
            rel="noopener"
            className="font-bold underline decoration-green-400 decoration-2 underline-offset-4 hover:text-green-600"
          >
            {PARENT_ORG.name}
          </Link>
          , the public-interest and social-impact initiative at esheria.org.
        </p>
      </section>
      <section
        className="mb-14 flex h-auto flex-col overflow-hidden md:mb-20 lg:h-[560px] lg:min-h-[520px] lg:flex-row"
        aria-label="SafeRide priorities"
      >
        {panels.map((panel, index) => {
          const active = activePanel === index;
          const panelId = `hero-panel-${index + 1}`;

          return (
            <article
              key={panel.label}
              data-testid={`accordion-panel-${index + 1}`}
              className={`accordion-panel group relative flex min-h-[94px] basis-auto flex-col overflow-hidden text-left text-black transition-all duration-[650ms] ease-[cubic-bezier(0.2,0.8,0.2,1)] lg:basis-0 ${active ? 'lg:flex-[5_1_0%]' : 'lg:flex-[1_1_0%]'} ${panel.tone}`}
              onMouseEnter={() => setActivePanel(index)}
            >
              <div className="flex h-full min-h-[94px] flex-col lg:flex-row">
                <div
                  className={`relative order-1 h-[230px] shrink-0 bg-gradient-to-br ${panel.imageTone} transition-all duration-[650ms] ease-[cubic-bezier(0.2,0.8,0.2,1)] md:h-[320px] lg:order-none lg:h-full ${
                    active ? 'lg:w-[70%]' : 'lg:w-full'
                  } ${index === 2 ? 'lg:order-2' : ''}`}
                >
                  <img
                    src={panel.image}
                    srcSet={panel.imageSrcSet}
                    sizes="(min-width: 1024px) 58vw, 100vw"
                    width={panel.imageWidth}
                    height={panel.imageHeight}
                    alt={panel.imageAlt}
                    loading={index === 0 ? 'eager' : 'lazy'}
                    fetchPriority={index === 0 ? 'high' : 'low'}
                    decoding={index === 0 ? undefined : 'async'}
                    className="absolute inset-0 h-full w-full object-cover"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/45 via-black/10 to-transparent" aria-hidden="true" />
                  <VisualMotif motif={panel.motif} active={active} />
                  <button
                    type="button"
                    aria-controls={panelId}
                    aria-expanded={active}
                    className={`absolute bottom-4 left-4 max-w-[15rem] text-left font-display text-2xl font-semibold leading-[1.05] tracking-normal text-white outline-none drop-shadow-[0_2px_8px_rgba(0,0,0,0.7)] transition focus-visible:ring-4 focus-visible:ring-white lg:text-3xl ${
                      active ? 'lg:opacity-0' : 'lg:opacity-100'
                    }`}
                    onClick={() => setActivePanel(index)}
                    onFocus={() => setActivePanel(index)}
                  >
                    {panel.label}
                  </button>
                </div>

                <div
                  id={panelId}
                  className={`order-2 flex flex-col justify-end p-5 transition-all duration-[650ms] ease-[cubic-bezier(0.2,0.8,0.2,1)] md:p-7 lg:order-none lg:h-full lg:w-[30%] lg:p-8 ${
                    active ? 'max-h-[32rem] opacity-100 lg:max-h-none lg:translate-x-0' : 'max-h-0 opacity-0 lg:max-h-none lg:translate-x-10 lg:opacity-0'
                  } ${active ? 'block' : 'hidden lg:flex'}`}
                >
                  <p className="mb-2 text-sm font-semibold uppercase tracking-normal">{panel.eyebrow}</p>
                  <h2 className="font-display text-3xl font-semibold leading-[0.95] tracking-normal md:text-4xl">
                    {panel.headline}
                  </h2>
                  <p className="mt-5 max-w-md text-[1.08rem] leading-[1.38] md:text-xl">{panel.body}</p>
                  <Link
                    href={panel.cta.href}
                    className="mt-6 inline-flex w-fit items-center gap-2 border-b-3 border-black pb-1 font-display text-xl font-semibold tracking-normal outline-none focus-visible:ring-4 focus-visible:ring-black"
                  >
                    {panel.cta.label} <span aria-hidden="true">&rarr;</span>
                  </Link>
                </div>
              </div>
            </article>
          );
        })}
      </section>
    </header>
  );
}
