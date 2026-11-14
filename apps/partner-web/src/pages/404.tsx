import Link from 'next/link';

import { Layout } from '../components/Layout.tsx';
import { PageHeading } from '../components/ui.tsx';
import { t } from '../lib/i18n.ts';

export default function NotFoundPage() {
  return (
    <Layout title={t('title.notFound')}>
      <PageHeading>{t('notFound.heading')}</PageHeading>
      <p className="mt-4">
        <Link href="/cases/" className="btn-link">{t('notFound.back')}</Link>
      </p>
    </Layout>
  );
}
