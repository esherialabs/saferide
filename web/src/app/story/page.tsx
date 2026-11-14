import PageShell from '@/components/PageShell';
import { interiorPageStructuredData } from '@/lib/json-ld';
import { pageMetadata } from '@/lib/metadata';
import { INTERIOR_PAGES } from '@/lib/pages';

export const metadata = pageMetadata({
  title: 'Our Story: Why We Built SafeRide',
  absoluteTitle: true,
  description:
    'Why Esheria built SafeRide, and how the work moved from Nairobi design into a supervised HURIA pilot in Mombasa.',
  path: '/story',
  image: INTERIOR_PAGES['story'].ogImage,
  imageAlt: INTERIOR_PAGES['story'].imageAlt,
});

export default function Page() {
  return (
    <PageShell
      {...INTERIOR_PAGES['story']}
      structuredData={interiorPageStructuredData({ name: 'Our Story', path: '/story' })}
    />
  );
}
