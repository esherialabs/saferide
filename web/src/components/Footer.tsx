/* eslint-disable @next/next/no-img-element */
import Link from 'next/link';
import BrandWordmark from '@/components/BrandWordmark';
import { PUBLIC_LINKS } from '@/lib/navigation';
import { PARENT_ORG, SITE } from '@/lib/site';

// One link per destination with its best label — duplicate anchors dilute
// internal-link signals (see web/SEO_REMEDIATION_PLAN.md P1-6).
const footerGroups = [
  {
    title: 'Product',
    links: [
      { label: 'What We Do', href: '/what-we-do' },
      { label: 'How It Works', href: '/how-it-works' },
      { label: 'For Survivors', href: '/for-survivors' },
      { label: 'Partner Dashboard', href: '/partner-dashboard' },
      { label: 'Privacy & Trust', href: '/privacy-safety-trust' },
    ],
  },
  {
    title: 'Source & Models',
    links: [
      { label: 'Source & Licenses', href: '/open-source' },
      { label: 'Open-source repository', href: PUBLIC_LINKS.github, external: true },
      { label: 'Hugging Face Model', href: PUBLIC_LINKS.huggingface, external: true },
      { label: 'Download App', href: '/download' },
    ],
  },
  {
    title: 'Community',
    links: [
      { label: 'Partners', href: '/partners' },
      { label: 'Our Story', href: '/story' },
      { label: 'Impact', href: '/impact' },
      { label: 'Guides', href: '/blog' },
    ],
  },
  {
    title: 'Organisation',
    links: [
      { label: 'Esheria Foundation', href: PARENT_ORG.url, external: true },
      { label: 'Privacy Guide', href: '/blog/private-reporting-control' },
      { label: 'Privacy Notice', href: '/privacy' },
      { label: 'Terms of Use', href: '/terms' },
      { label: 'Contact', href: '/contact' },
    ],
  },
];
const socialLinks = [
  { label: 'GitHub', href: PUBLIC_LINKS.github, icon: 'github' },
  { label: 'HuggingFace', href: PUBLIC_LINKS.huggingface, icon: 'huggingface' },
  { label: 'LinkedIn', href: 'https://www.linkedin.com/company/esheria/', icon: 'linkedin' },
] as const;

function SocialIcon({ icon }: { icon: (typeof socialLinks)[number]['icon'] }) {
  if (icon === 'linkedin') {
    return (
      <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M6.94 8.98H3.8V20h3.14V8.98ZM5.37 4C4.34 4 3.5 4.8 3.5 5.8s.84 1.81 1.87 1.81c1.04 0 1.88-.81 1.88-1.81S6.41 4 5.37 4ZM20.5 13.66c0-3.08-1.64-4.51-3.83-4.51-1.77 0-2.56.97-3 1.65V8.98h-3.01V20h3.14v-5.45c0-1.44.27-2.84 2.06-2.84 1.76 0 1.79 1.65 1.79 2.93V20h3.14l-.29-6.34Z" />
      </svg>
    );
  }

  if (icon === 'huggingface') {
    return (
      <img src="/images/hf-logo.svg" alt="" width={20} height={20} className="h-5 w-5" aria-hidden="true" />
    );
  }

  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" d="M12 2.5a9.5 9.5 0 0 0-3 18.52c.47.08.65-.2.65-.45v-1.7c-2.63.57-3.18-1.12-3.18-1.12-.43-1.1-1.05-1.4-1.05-1.4-.86-.59.07-.58.07-.58.95.07 1.45.98 1.45.98.85 1.45 2.22 1.03 2.76.79.08-.61.33-1.03.6-1.27-2.1-.24-4.3-1.05-4.3-4.68 0-1.03.37-1.88.98-2.54-.1-.24-.43-1.2.09-2.5 0 0 .8-.26 2.61.97a9.02 9.02 0 0 1 4.76 0c1.8-1.23 2.6-.97 2.6-.97.53 1.3.2 2.26.1 2.5.61.66.98 1.5.98 2.54 0 3.64-2.21 4.44-4.32 4.67.34.3.64.87.64 1.76v2.54c0 .25.17.54.65.45A9.5 9.5 0 0 0 12 2.5Z" clipRule="evenodd" />
    </svg>
  );
}

function Logo() {
  return (
    <Link href="/" className="inline-flex items-center" aria-label="SafeRide home">
      <BrandWordmark className="text-3xl" inverted />
    </Link>
  );
}

export default function Footer() {
  const currentYear = new Date().getFullYear();

  return (
    <footer data-testid="main-footer" className="bg-green-900 text-white">
      <div className="mx-auto max-w-content px-4 py-14 sm:px-6 lg:px-8">
        <div>
          <div>
            <Logo />
            <p className="mt-3 text-white/65">
              SafeRide is a public-interest safety product developed by{' '}
              <Link href={PARENT_ORG.url} className="font-semibold text-white underline decoration-green-300 underline-offset-4 hover:text-green-300">
                {PARENT_ORG.name}
              </Link>
              , the public-interest and social-impact home for the project.
            </p>
          </div>
        </div>

        <div className="mt-12 border-t border-white/10 pt-10">
          <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            {footerGroups.map((group) => (
              <div key={group.title}>
                <p className="font-display text-sm font-bold uppercase tracking-normal text-green-300">{group.title}</p>
                <ul className="mt-5 space-y-3">
                  {group.links.map((link) => (
                    <li key={link.label}>
                      <Link
                        href={link.href}
                        {...('external' in link && link.external ? { target: '_blank', rel: 'noopener' } : {})}
                        className="text-sm text-white/75 underline-offset-4 hover:text-green-300 hover:underline"
                      >
                        {link.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-12 flex flex-col gap-6 border-t border-white/10 pt-8 text-sm text-white/65 lg:flex-row lg:items-center lg:justify-between">
          <p>
            &copy; {currentYear}{' '}
            <Link href={PARENT_ORG.url} className="underline decoration-green-300 underline-offset-4 hover:text-green-300">
              {SITE.operatorLegalName}
            </Link>
          </p>
          <p>Apache 2.0  CC-BY 4.0  Built in Nairobi, Kenya 🇰🇪</p>
          <div className="flex items-center gap-3">
            {socialLinks.map((social) => (
              <Link
                key={social.label}
                href={social.href}
                aria-label={social.label}
                target="_blank"
                rel="noopener"
                className="grid h-10 w-10 place-items-center border border-white/20 text-green-300 transition hover:bg-green-300 hover:text-green-950"
              >
                <SocialIcon icon={social.icon} />
              </Link>
            ))}
          </div>
        </div>
      </div>
    </footer>
  );
}
