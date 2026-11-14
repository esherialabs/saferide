import PageShell from '@/components/PageShell';
import { interiorPageStructuredData } from '@/lib/json-ld';
import { pageMetadata } from '@/lib/metadata';
import { INTERIOR_PAGES } from '@/lib/pages';

export const metadata = pageMetadata({
  title: 'Impact & Transparency',
  description:
    'What the HURIA pilot in Mombasa delivered, what it tested, and what SafeRide does not claim without evidence.',
  path: '/impact',
  image: INTERIOR_PAGES['impact'].ogImage,
  imageAlt: INTERIOR_PAGES['impact'].imageAlt,
});

export default function Page() {
  return (
    <PageShell
      {...INTERIOR_PAGES['impact']}
      structuredData={interiorPageStructuredData({ name: 'Impact', path: '/impact' })}
    />
  );
}
