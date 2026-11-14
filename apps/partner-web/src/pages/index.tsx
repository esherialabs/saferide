import { useRouter } from 'next/router';
import { useEffect } from 'react';

import { Layout } from '../components/Layout.tsx';
import { RequireSession } from '../components/RequireSession.tsx';
import { Loading } from '../components/ui.tsx';
import { t } from '../lib/i18n.ts';

function GoToCases() {
  const router = useRouter();
  useEffect(() => {
    void router.replace('/cases/');
  }, [router]);
  return <Loading label={t('queue.loading')} />;
}

export default function HomePage() {
  return (
    <Layout title={t('title.cases')}>
      <RequireSession>
        <GoToCases />
      </RequireSession>
    </Layout>
  );
}
