// Real photographs from the supervised HURIA pilot in Mombasa (October 2026).
// Web copies are produced from the originals by scripts/prepare-pilot-photos.mjs,
// which crops each frame, resizes it and drops all camera metadata.
//
// Captions and alt text say what is visible. They name no one and give no
// individual days: the pilot is described only at the October 2026 level.

export type PilotPhoto = {
  src: string;
  width: number;
  height: number;
  alt: string;
  caption: string;
  /** Short tag used on photo tiles. */
  label: string;
  /** Large-screen focal point when a tile crops the photo (Tailwind object-position class). */
  focus?: string;
};

const DIR = '/images/pilot';

export const PILOT_PHOTOS = {
  demoBanner: {
    src: `${DIR}/pilot-demo-banner.webp`,
    width: 1600,
    height: 865,
    alt: 'Two people in SafeRide T-shirts go through the app on a phone and a laptop with a colleague, beside a SafeRide banner reading Safer journeys. Stronger voices.',
    caption: 'A SafeRide demonstration during the supervised pilot in Mombasa.',
    label: 'Hands-on demonstration',
  },
  demoLively: {
    src: `${DIR}/pilot-demo-lively.webp`,
    width: 1600,
    height: 1236,
    alt: 'A facilitator in a SafeRide T-shirt gestures as he explains the app to a colleague in a SafeRide T-shirt.',
    caption: 'Explaining the app out loud: facilitators sat beside people as they tried it.',
    label: 'Explaining it',
  },
  handson: {
    src: `${DIR}/pilot-handson.webp`,
    width: 1600,
    height: 840,
    alt: 'A facilitator leans in to show a colleague the SafeRide app on a phone at an office desk.',
    caption: 'Going through the app on a phone, one step at a time.',
    label: 'On a real phone',
  },
  liveDemoTalk: {
    src: `${DIR}/pilot-live-demo-talk.webp`,
    width: 1600,
    height: 813,
    alt: 'Three colleagues talk around a meeting table beside a screen headed Live demo with a QR code.',
    caption: 'A live demo at the partner briefing: the screen shows the QR code for the app.',
    label: 'Live demo',
  },
  liveDemoClap: {
    src: `${DIR}/pilot-live-demo-clap.webp`,
    width: 1600,
    height: 914,
    alt: 'A colleague claps his hands as he talks to another standing by his chair, while a third looks at a phone at the table.',
    caption: 'Questions and answers during the live demo.',
    label: 'Questions and answers',
  },
  briefing: {
    src: `${DIR}/pilot-briefing.webp`,
    width: 1600,
    height: 665,
    alt: 'A facilitator smiles and gestures in front of a screen headed The rider decides what leaves her phone, with a colleague standing beside him.',
    caption: 'The principle the pilot was built on: the rider decides what leaves her phone.',
    label: 'The briefing',
  },
  briefingGesture: {
    src: `${DIR}/pilot-briefing-gesture.webp`,
    width: 1600,
    height: 682,
    alt: 'A facilitator speaks with his hands in front of a screen headed Most harassment is never reported, while a colleague listens.',
    caption: 'Why SafeRide exists: most harassment is never reported.',
    label: 'Why it matters',
    focus: 'lg:object-[20%_50%]',
  },
  briefingPointing: {
    src: `${DIR}/pilot-briefing-pointing.webp`,
    width: 1600,
    height: 777,
    alt: 'A presenter points at a screen headed Where the path to justice breaks while a colleague watches.',
    caption: 'Walking the partner team through where the path to justice breaks.',
    label: 'The path to justice',
    focus: 'lg:object-[55%_50%]',
  },
  privacySlide: {
    src: `${DIR}/pilot-briefing-privacy-slide.webp`,
    width: 1600,
    height: 731,
    alt: 'A presenter and a colleague beside a screen headed The rider decides what leaves her phone',
    caption: 'The privacy principle as presented at the pilot briefing: the rider decides what leaves her phone.',
    label: 'The rider decides',
  },
  presenter: {
    src: `${DIR}/pilot-presenter.webp`,
    width: 900,
    height: 1221,
    alt: 'A presenter in front of a screen headed HURIA’s work across the Coast, speaking with open hands.',
    caption: 'The partner’s own briefing: its work across the Coast.',
    label: 'The partner’s work',
  },
  teamSmiling: {
    src: `${DIR}/pilot-team-smiling.webp`,
    width: 1600,
    height: 636,
    alt: 'Five members of the partner and SafeRide teams stand together and smile at the camera in front of a screen about HURIA’s work across the Coast.',
    caption: 'Partner and SafeRide teams together.',
    label: 'Partner and SafeRide teams',
  },
  teamFour: {
    src: `${DIR}/pilot-team-four.webp`,
    width: 1600,
    height: 782,
    alt: 'Four members of the pilot team stand side by side, looking at the camera, in front of a screen about HURIA’s work across the Coast.',
    caption: 'The pilot team after the partner briefing.',
    label: 'The pilot team',
  },
  communityPanel: {
    src: `${DIR}/pilot-community-panel.webp`,
    width: 1400,
    height: 998,
    alt: 'Community day: people sit and stand under a tent, smiling, as a speaker holds a microphone.',
    caption: 'A community day in Mombasa: speakers and neighbours under the tent.',
    label: 'Community day',
  },
  communityApp: {
    src: `${DIR}/pilot-community-app.webp`,
    width: 600,
    height: 1008,
    alt: 'A team member in a SafeRide T-shirt shows the app on a phone to a woman seated under a tent at the community day.',
    caption: 'One person at a time: showing the app on a phone at the community day.',
    label: 'One person at a time',
  },
  communityBanner: {
    src: `${DIR}/pilot-community-banner.webp`,
    width: 642,
    height: 960,
    alt: 'A team member in a SafeRide T-shirt speaks beside a pull-up banner reading Safer journeys. Stronger voices. Your evidence. Your control.',
    caption: 'Safer journeys. Stronger voices. Your evidence. Your control.',
    label: 'Your evidence. Your control.',
  },
} as const satisfies Record<string, PilotPhoto>;

export type PilotPhotoKey = keyof typeof PILOT_PHOTOS;
