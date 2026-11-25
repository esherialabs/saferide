import type { MetadataRoute } from 'next';
import { LEGAL_PUBLISHED_ON } from '@/content/legal';
import { INTERIOR_PAGES } from '@/lib/pages';
import { SITE, canonicalUrl } from '@/lib/site';

export const dynamic = 'force-static';

// Bump these when the visible content of a static route changes (see
// web/SEO_REMEDIATION_PLAN.md P0-2 / P4-4). Interior pages carry their own
// updatedAt in INTERIOR_PAGES; blog posts use their reviewed update date.
const staticEntries = [
  { route: '/', updatedAt: '2026-11-05', priority: 1, changeFrequency: 'weekly' as const, image: '/og.png' },
  { route: '/blog', updatedAt: '2026-11-01', priority: 0.7, changeFrequency: 'weekly' as const, image: '/images/press/businessday-unicef-femtech-ventures.webp' },
  { route: '/pilot', updatedAt: '2026-11-05', priority: 0.7, changeFrequency: 'monthly' as const, image: '/images/pilot/pilot-demo-banner.webp' },
  { route: '/download', updatedAt: '2026-10-22', priority: 0.8, changeFrequency: 'monthly' as const, image: '/og.png' },
  { route: '/contact', updatedAt: '2026-11-01', priority: 0.65, changeFrequency: 'monthly' as const, image: '/og.png' },
  { route: '/privacy', updatedAt: LEGAL_PUBLISHED_ON, priority: 0.4, changeFrequency: 'monthly' as const, image: '/og.png' },
  { route: '/terms', updatedAt: LEGAL_PUBLISHED_ON, priority: 0.4, changeFrequency: 'monthly' as const, image: '/og.png' },
] as const;

const interiorEntries = Object.keys(INTERIOR_PAGES).map((slug) => {
  const page = INTERIOR_PAGES[slug as keyof typeof INTERIOR_PAGES];

  return {
    route: `/${slug}` as const,
    updatedAt: page.updatedAt,
    priority: slug === 'what-we-do' ? 0.9 : 0.8,
    changeFrequency: 'monthly' as const,
    image: page.image,
  };
});

export default function sitemap(): MetadataRoute.Sitemap {
  const pages = [...staticEntries, ...interiorEntries].map((entry) => ({
    url: canonicalUrl(entry.route),
    lastModified: new Date(entry.updatedAt),
    changeFrequency: entry.changeFrequency,
    priority: entry.priority,
    images: entry.image ? [`${SITE.url}${entry.image}`] : undefined,
  }));

  const posts = SITE.updates.map((post) => ({
    url: canonicalUrl(`/blog/${post.slug}`),
    lastModified: new Date(post.updatedAt),
    changeFrequency: 'monthly' as const,
    priority: 0.55,
    images: [`${SITE.url}${post.ogImage}`],
  }));

  return [...pages, ...posts];
}
