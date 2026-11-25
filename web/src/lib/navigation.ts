export const NAV_CTA = { label: 'Download App', href: '/download' } as const;

export const NAV_LINKS = [
  {
    label: 'What We Do',
    href: '/what-we-do',
    children: [
      { label: 'How It Works', href: '/how-it-works' },
      { label: 'For Survivors', href: '/for-survivors' },
      { label: 'Privacy & Trust', href: '/privacy-safety-trust' },
      { label: 'Partner Dashboard', href: '/partner-dashboard' },
      { label: 'Impact', href: '/impact' },
      { label: 'The Pilot in Pictures', href: '/pilot' },
    ],
  },
  { label: 'Source & Models', href: '/open-source' },
  { label: 'Our Story', href: '/story' },
  { label: 'Partners', href: '/partners' },
  { label: 'Blog', href: '/blog' },
] as const;

export const PUBLIC_LINKS = {
  github: process.env.NEXT_PUBLIC_GITHUB_URL ?? 'https://github.com/esherialabs/saferide',
  huggingface:
    process.env.NEXT_PUBLIC_HUGGINGFACE_URL ??
    'https://huggingface.co/esherialabs/saferide-gemma-4-e2b-v058-original-419806-litertlm',
} as const;
