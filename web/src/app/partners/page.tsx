import PageShell from '@/components/PageShell';
import { interiorPageStructuredData } from '@/lib/json-ld';
import { pageMetadata } from '@/lib/metadata';
import { INTERIOR_PAGES } from '@/lib/pages';

export const metadata = pageMetadata({
  title: 'Partner With SafeRide in Kenya',
  absoluteTitle: true,
  description:
    'Work with SafeRide after the October 2026 HURIA pilot in Mombasa on survivor support, route data safeguards, and safe technology for women on Kenyan public transport.',
  path: '/partners',
  image: INTERIOR_PAGES['partners'].ogImage,
  imageAlt: INTERIOR_PAGES['partners'].imageAlt,
});

export default function Page() {
  return (
    <PageShell
      {...INTERIOR_PAGES['partners']}
      structuredData={interiorPageStructuredData({ name: 'Partners', path: '/partners' })}
    />
  );
}
