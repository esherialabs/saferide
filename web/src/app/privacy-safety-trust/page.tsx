import PageShell from '@/components/PageShell';
import { interiorPageStructuredData } from '@/lib/json-ld';
import { pageMetadata } from '@/lib/metadata';
import { INTERIOR_PAGES } from '@/lib/pages';

export const metadata = pageMetadata({
  title: 'Privacy & Safety: How SafeRide Protects You',
  absoluteTitle: true,
  description:
    "Local-first storage, explicit consent before anything is shared, retention controls, and stealth features in the HURIA pilot in Mombasa.",
  path: '/privacy-safety-trust',
  image: INTERIOR_PAGES['privacy-safety-trust'].ogImage,
  imageAlt: INTERIOR_PAGES['privacy-safety-trust'].imageAlt,
});

export default function Page() {
  return (
    <PageShell
      {...INTERIOR_PAGES['privacy-safety-trust']}
      structuredData={interiorPageStructuredData({ name: 'Privacy, Safety, and Trust', path: '/privacy-safety-trust' })}
    />
  );
}
