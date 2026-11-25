// Verified broadcast coverage shown on the public site.
//
// The player is mounted only after a visitor presses play, so no third-party
// request, script or cookie reaches the page on load. The embed URL is the
// documented Facebook video plugin; `watchUrl` is the canonical post and stays
// available as a plain link for anyone who blocks frames or scripts.
export type MediaClipData = {
  outlet: string;
  programme: string;
  title: string;
  body: string;
  displayDate: string;
  watchUrl: string;
  embedUrl: string;
  poster: string;
  posterSrcSet: string;
  posterAlt: string;
};

export const SPICE_FM_CLIP: MediaClipData = {
  outlet: 'Spice FM',
  programme: 'Pink Perspective',
  title: 'A clip about SafeRide',
  body:
    'Spice FM’s Pink Perspective recognised SafeRide after UNICEF highlighted the app as a Kenyan innovation for women’s safety on public transport.',
  displayDate: '2026',
  watchUrl: 'https://www.facebook.com/reel/2555899891595834/',
  embedUrl:
    'https://www.facebook.com/plugins/video.php?href=https%3A%2F%2Fwww.facebook.com%2Freel%2F2555899891595834%2F&show_text=false&autoplay=true&width=560&height=315',
  poster: '/images/spice-fm-poster.svg',
  posterSrcSet: '/images/spice-fm-poster.svg 1200w',
  posterAlt: 'A yellow and green card with a play symbol and the words Watch the clip on Facebook.',
};
