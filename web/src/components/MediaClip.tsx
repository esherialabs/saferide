/* eslint-disable @next/next/no-img-element */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import type { MediaClipData } from '@/lib/media';

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-7 w-7 translate-x-[1px]" fill="currentColor" aria-hidden="true">
      <path d="M8 5.14v13.72a1 1 0 0 0 1.52.85l11-6.86a1 1 0 0 0 0-1.7l-11-6.86A1 1 0 0 0 8 5.14Z" />
    </svg>
  );
}

/**
 * Broadcast coverage with a click-to-load player.
 *
 * Nothing is requested from the video host until a visitor presses play: the
 * card ships with a self-hosted poster, and the iframe only exists while the
 * dialog is open. Closing the dialog removes the iframe again, so a reader who
 * never watches the clip never loads third-party code.
 */
export default function MediaClip({ clip }: { clip: MediaClipData }) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  // Remember which control opened the player so focus goes back there, not to
  // a fixed button: the poster and the "Watch the clip" button both open it.
  const openerRef = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);

  const openPlayer = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    openerRef.current = event.currentTarget;
    setOpen(true);
  }, []);
  const closePlayer = useCallback(() => setOpen(false), []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      dialog.showModal();
      document.body.style.overflow = 'hidden';
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const handleClose = () => {
      document.body.style.overflow = '';
      setOpen(false);
      openerRef.current?.focus();
    };

    dialog.addEventListener('close', handleClose);
    return () => {
      dialog.removeEventListener('close', handleClose);
      document.body.style.overflow = '';
    };
  }, []);

  return (
    <section
      className="border-y-3 border-black bg-white py-14 md:py-20"
      aria-labelledby="media-clip-heading"
      data-testid="media-clip"
    >
      <div className="mx-auto max-w-[1200px] px-4 sm:px-6 lg:px-0">
        <div className="mb-8 flex flex-col gap-3 border-b-3 border-black pb-6 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-normal text-green-700">In the media</p>
            <h2
              id="media-clip-heading"
              className="mt-3 max-w-4xl font-display text-[clamp(2.25rem,5vw,4rem)] font-semibold leading-[0.9] tracking-normal"
            >
              {clip.title}
            </h2>
          </div>
          <p className="max-w-md text-sm font-semibold uppercase leading-6 tracking-normal text-black/62">
            {clip.outlet} / {clip.programme} / {clip.displayDate}
          </p>
        </div>

        <article className="interactive-card grid overflow-hidden border-3 border-black bg-white lg:grid-cols-[1.15fr_0.85fr]">
          <button
            type="button"
            onClick={openPlayer}
            aria-haspopup="dialog"
            aria-label={`Play the ${clip.outlet} clip: ${clip.title}`}
            data-testid="media-clip-play"
            className="group relative block aspect-[4/3] w-full cursor-pointer border-b-3 border-black bg-green-100 text-left outline-none focus-visible:ring-4 focus-visible:ring-black motion-reduce:transform-none lg:aspect-auto lg:min-h-[27rem] lg:border-b-0 lg:border-r-3"
          >
            <img
              src={clip.poster}
              srcSet={clip.posterSrcSet}
              sizes="(min-width: 1024px) 58vw, 100vw"
              alt={clip.posterAlt}
              loading="lazy"
              decoding="async"
              className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.02] motion-reduce:transition-none motion-reduce:transform-none"
            />
            <span className="absolute inset-0 bg-gradient-to-t from-black/55 via-black/10 to-transparent" aria-hidden="true" />
            <span className="absolute inset-0 grid place-items-center" aria-hidden="true">
              <span className="grid h-20 w-20 place-items-center rounded-full border-3 border-black bg-[#F7EC36] text-black shadow-[6px_6px_0_#0D1B12] transition-transform duration-200 group-hover:scale-105 motion-reduce:transition-none motion-reduce:transform-none">
                <PlayIcon />
              </span>
            </span>
            <span className="absolute bottom-5 left-5 border-3 border-black bg-white px-3 py-2 font-display text-sm font-semibold uppercase tracking-normal">
              Play the clip
            </span>
          </button>

          <div className="flex flex-col justify-center p-7 md:p-10">
            <p className="text-xs font-semibold uppercase tracking-normal text-black/62">
              {clip.outlet} / {clip.programme}
            </p>
            <p className="mt-5 max-w-2xl text-lg leading-8 text-black/72">{clip.body}</p>
            <button
              type="button"
              onClick={openPlayer}
              className="interactive-button mt-8 inline-flex w-fit border-3 border-black bg-[#161616] px-6 py-4 font-display font-semibold text-white hover:bg-green-900"
            >
              Watch the clip
            </button>
            <a
              href={clip.watchUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-4 w-fit text-sm font-semibold underline decoration-2 underline-offset-4 hover:text-green-700"
            >
              Open the clip on Facebook
            </a>
            <p className="mt-6 max-w-sm border-l-3 border-black pl-4 text-sm font-semibold leading-6 text-black/62">
              The player loads from Facebook only after you press play. Nothing about a SafeRide report is sent to it.
            </p>
          </div>
        </article>
      </div>

      <dialog
        ref={dialogRef}
        aria-labelledby="media-clip-dialog-title"
        data-testid="media-clip-dialog"
        className="max-h-[92vh] w-[min(94vw,60rem)] overflow-y-auto border-3 border-black bg-white p-0 text-black backdrop:bg-black/75"
        onClick={(event) => {
          if (event.target === dialogRef.current) closePlayer();
        }}
      >
        <div className="flex items-center justify-between gap-4 border-b-3 border-black bg-[#F7EC36] px-5 py-4">
          <h2 id="media-clip-dialog-title" className="font-display text-lg font-semibold leading-tight tracking-normal">
            {clip.outlet}: {clip.title}
          </h2>
          <button
            type="button"
            onClick={closePlayer}
            data-testid="media-clip-close"
            className="interactive-button border-3 border-black bg-white px-4 py-2 font-display text-sm font-semibold"
          >
            Close
          </button>
        </div>
        <div className="bg-black">
          {open ? (
            // Minimal capability set for a cross-origin player: it can run its
            // own code, keep its own session and go full screen, and it never
            // learns which SafeRide page sent the visitor.
            <iframe
              title={`${clip.outlet} clip: ${clip.title}`}
              src={clip.embedUrl}
              data-testid="media-clip-iframe"
              className="block aspect-video w-full border-0"
              allow="autoplay; fullscreen"
              sandbox="allow-scripts allow-same-origin allow-popups allow-presentation"
              referrerPolicy="no-referrer"
            />
          ) : null}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
          <p className="text-sm leading-6 text-black/62">Playing loads Facebook&apos;s player, which may set cookies on this device.</p>
          <a
            href={clip.watchUrl}
            target="_blank"
            rel="noreferrer"
            className="text-sm font-semibold underline decoration-2 underline-offset-4"
          >
            Open on Facebook
          </a>
        </div>
      </dialog>
    </section>
  );
}
