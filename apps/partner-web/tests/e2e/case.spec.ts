import {
  ADMIN, REFERRAL_IDS, auditActions, expect, expectAccessible, expectNoCaseContent, expectTargetSizes, openCase, signIn, snap, test,
} from './helpers.ts';

const ID = REFERRAL_IDS;

test.describe('case detail', () => {
  test('an escalation shows its packet at the chosen redaction level', async ({ page }) => {
    await signIn(page);
    await openCase(page, 'SR-7K3Q-9M2D');
    await expect(page).toHaveTitle('(2) Case · SafeRide × HURIA'); // IDs only in the URL; the title has at most a count
    expect(new URL(page.url()).search).toBe(`?id=${ID['SR-7K3Q-9M2D']}`);
    const banner = page.getByTestId('redaction-banner');
    await expect(banner).toContainText('Redaction level: light');
    await expect(banner).toContainText('Masked: Names, Phone numbers, Exact location');
    await expect(page.getByText('The survivor uses the alias “Test-Alias Wanjiku”.')).toBeVisible();
    await expect(page.getByText('SYNTHETIC TEST CASE. A conductor made repeated comments')).toBeVisible();
    await expect(page.getByTestId('timeline')).toContainText('Received from SafeRide');
    await expect(page.getByText(/Prepared on the survivor’s phone on/)).toBeVisible();
    const manifest = page.getByTestId('packet-manifest');
    await expect(manifest).toContainText('Evidence listed in the packet');
    await expect(manifest).toContainText('Description: SYNTHETIC. The stage sign.');
    await expect(manifest).toContainText('Transcript: SYNTHETIC. [inaudible]');
    await expectAccessible(page, 'case detail (escalation)');
    await expectTargetSizes(page, 'case detail (escalation)');
    await snap(page, '08-case-escalation');
  });

  test('a referral shows only the brief fields the survivor selected', async ({ page }) => {
    await signIn(page);
    await openCase(page, 'SR-4T8N-2XHB');
    await expect(page.getByRole('heading', { name: 'Referral brief' })).toBeVisible();
    await expect(page.getByText('The survivor prefers WhatsApp. They will contact HURIA and quote the reference SR-4T8N-2XHB.')).toBeVisible();
    await expect(page.getByText('verbal harassment, unwanted touching')).toBeVisible();
    await expect(page.getByText('18 October 2026 (approximate date)')).toBeVisible();
    await expect(page.getByTestId('callback-not-shared')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reveal callback number' })).toHaveCount(0);
    await expectAccessible(page, 'case detail (referral)');
    await snap(page, '09-case-referral');
  });

  test('evidence is not shareable yet by default: a calm line instead of a download button', async ({ page, request }) => {
    await signIn(page);
    await openCase(page, 'SR-7K3Q-9M2D');
    const evidence = page.getByRole('region', { name: 'Evidence' });
    await expect(evidence.getByTestId('evidence-item')).toHaveCount(3);
    await expect(evidence.getByTestId('evidence-unavailable')).toHaveText(
      Array(3).fill('Evidence files can’t be shared with partners yet. SafeRide keeps them safely.'),
    );
    await expect(evidence.getByRole('button', { name: /Get download link/ })).toHaveCount(0);
    await expect(evidence.getByTestId('evidence-logged')).not.toContainText('60 seconds');
    expect((await auditActions(request)).some(entry => entry.action === 'partner.evidence.url')).toBe(false);
  });

  test.describe('with evidence downloads switched on (development/test only in P3)', () => {
    test.use({ mockReset: { evidenceDownload: 'originals' } });

    test('logging is explained, links last 60 s and download, refusals are shown', async ({ page, request }) => {
      await signIn(page);
      await openCase(page, 'SR-7K3Q-9M2D');
      await expect(page.getByTestId('evidence-logged')).toContainText('Every evidence link you request is recorded with your name and the time');
      await expect(page.getByText('Not available yet: the file is still being checked.')).toBeVisible();
      await expect(page.getByText('Not available: the file did not pass the safety check.')).toBeVisible();
      await expect(page.getByRole('button', { name: /Get download link/ })).toHaveCount(1);

      await page.getByRole('button', { name: 'Get download link for evidence-photo-1.jpg' }).click();
      const link = page.getByRole('link', { name: 'Download evidence-photo-1.jpg' });
      await expect(link).toBeVisible();
      await expect(page.getByText(/Link expires in (60|59|58) s\./)).toBeVisible();
      expect(await link.getAttribute('rel')).toContain('noreferrer');
      expect(await link.getAttribute('href')).toMatch(/^http:\/\/localhost:4321\/storage\//);
      const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
      const attachmentId = 'a77a0000-0000-4000-8000-000000000001';
      expect(download.suggestedFilename()).toBe(`evidence-${attachmentId}.txt`);
      const evidence = (await auditActions(request)).filter(entry => entry.action === 'partner.evidence.url');
      expect(evidence).toEqual([expect.objectContaining({ outcome: 'success', referralId: ID['SR-7K3Q-9M2D'], attachmentId })]);
      await snap(page, '10-case-evidence-link');
    });

    test('a link to any host but the storage origin is refused', async ({ page, request }) => {
      await signIn(page);
      await openCase(page, 'SR-7K3Q-9M2D');
      await request.post('/__mock/evidence-url-override', { data: { url: 'https://evil.example.test/evidence.jpg' } });
      await page.getByRole('button', { name: 'Get download link for evidence-photo-1.jpg' }).click();
      await expect(page.getByText('The partner service is unavailable. Try again shortly.')).toBeVisible();
      await expect(page.getByRole('link', { name: /Download evidence/ })).toHaveCount(0);
      await expect(page.locator('a[href*="evil.example.test"]')).toHaveCount(0);
    });

    test('a 409 evidence_not_shareable_yet is shown the same calm way, with no further attempts offered', async ({ page, request }) => {
      await signIn(page);
      await openCase(page, 'SR-9PQR-6WZA');
      const evidence = page.getByRole('region', { name: 'Evidence' });
      await expect(evidence.getByTestId('evidence-logged')).toContainText('60 seconds');
      const item = evidence.getByTestId('evidence-item').first();
      await expect(item.getByRole('button', { name: 'Get download link for evidence-photo-1.jpg' })).toBeVisible();
      await request.post('/__mock/evidence-download', { data: { mode: 'disabled' } });
      await item.getByRole('button', { name: 'Get download link for evidence-photo-1.jpg' }).click();
      await expect(item.getByTestId('evidence-unavailable')).toHaveText(
        'Evidence files can’t be shared with partners yet. SafeRide keeps them safely.',
      );
      await expect(evidence.getByRole('button')).toHaveCount(0);
      await expect(evidence.getByTestId('evidence-logged')).not.toContainText('60 seconds');
      await expect(item.getByText('The link was refused')).toHaveCount(0);
      const urls = (await auditActions(request)).filter(entry => entry.action === 'partner.evidence.url');
      expect(urls).toEqual([expect.objectContaining({ outcome: 'denied' })]);
    });
  });

  test('status changes only through the allowed transitions, with confirmation', async ({ page, request }) => {
    await signIn(page);
    await openCase(page, 'SR-7K3Q-9M2D');
    const status = page.getByRole('region', { name: 'Status' });
    await expect(status.getByRole('radio')).toHaveCount(2);
    await expect(status.getByRole('radio', { name: 'Acknowledged' })).toBeVisible();
    await expect(status.getByRole('radio', { name: 'Closed' })).toBeVisible();

    await status.getByRole('button', { name: 'Update status' }).click();
    await expect(status.getByRole('link', { name: 'Choose a new status.' })).toBeVisible();

    await status.getByText('Acknowledged', { exact: true }).click();
    await status.getByRole('button', { name: 'Update status' }).click();
    const dialog = page.getByTestId('status-confirm');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Change the status from New to Acknowledged? The survivor will see “HURIA received it”');
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await expectAccessible(page, 'status confirm dialog');
    await snap(page, '11-status-confirm');
    await dialog.getByRole('button', { name: 'Change status' }).click();
    await expect(status.getByText('Status changed to Acknowledged.')).toBeVisible();
    await expect(status.getByRole('radio')).toHaveCount(2);
    await expect(status.getByRole('radio', { name: 'In progress' })).toBeVisible();
    await expect(page.getByTestId('timeline')).toContainText('Acknowledged by Amina Test-Caseworker (you)');

    await status.getByText('Closed', { exact: true }).click();
    await status.getByRole('button', { name: 'Update status' }).click();
    await expect(status.getByRole('link', { name: 'Choose a reason for closing.' })).toBeVisible();
    await status.getByLabel('Reason for closing').selectOption('support_provided');
    await status.getByRole('button', { name: 'Update status' }).click();
    await page.getByTestId('status-confirm').getByRole('button', { name: 'Change status' }).click();
    await expect(status.getByText('This case is closed, so its status cannot change.')).toBeVisible();
    await expect(status.getByText('Reason: Support provided')).toBeVisible();
    await expect(status.getByRole('radio')).toHaveCount(0);

    const changes = (await auditActions(request)).filter(entry => entry.action === 'partner.referral.status');
    expect(changes.map(entry => entry.outcome)).toEqual(['success', 'success']);
    await page.getByRole('link', { name: 'Back to cases' }).click();
    await expect(page.getByTestId('queue-row').first()).toContainText('Closed');
  });

  test('a status changed by someone else asks for a reload instead of overwriting', async ({ page, request }) => {
    await signIn(page);
    await openCase(page, 'SR-7K3Q-9M2D');
    await request.post(`/__mock/referrals/${ID['SR-7K3Q-9M2D']}/status`, { data: { status: 'acknowledged' } });
    const status = page.getByRole('region', { name: 'Status' });
    await status.getByText('Acknowledged', { exact: true }).click();
    await status.getByRole('button', { name: 'Update status' }).click();
    await page.getByTestId('status-confirm').getByRole('button', { name: 'Change status' }).click();
    await expect(status.getByText('Someone else changed this case after you opened it.')).toBeVisible();
    await status.getByRole('button', { name: 'Reload case' }).click();
    await expect(status.getByRole('radio', { name: 'In progress' })).toBeVisible();
  });

  test('notes are append-only and internal', async ({ page }) => {
    await signIn(page);
    await openCase(page, 'SR-4T8N-2XHB');
    const notes = page.getByRole('region', { name: 'Internal notes' });
    await expect(notes).toContainText('the survivor never sees them');
    await expect(notes.getByRole('listitem')).toHaveCount(1);
    await notes.getByRole('button', { name: 'Add note' }).click();
    await expect(notes.getByText('Write a note first.')).toBeVisible();
    await notes.getByLabel('New note').fill('SYNTHETIC. Survivor called and quoted the reference.');
    await expect(notes.getByText('52 of 2,000 characters')).toBeVisible();
    await notes.getByRole('button', { name: 'Add note' }).click();
    await expect(notes.getByRole('listitem')).toHaveCount(2);
    await expect(notes.getByRole('listitem').last()).toContainText('SYNTHETIC. Survivor called and quoted the reference.');
    await expect(notes.getByRole('listitem').last()).toContainText('Amina Test-Caseworker');
    await expect(notes.getByLabel('New note')).toHaveValue('');
    await expect(notes.getByRole('button', { name: /edit|delete|remove/i })).toHaveCount(0);
    expect(await notes.getByLabel('New note').getAttribute('maxlength')).toBe('2000');
    const textarea = notes.getByLabel('New note');
    await expect(textarea).toHaveAttribute('spellcheck', 'false');
    await expect(textarea).toHaveAttribute('autocorrect', 'off');
    await expect(textarea).toHaveAttribute('autocapitalize', 'off');
  });

  test('the callback number is revealed only on an explicit, logged action', async ({ page, request }) => {
    await signIn(page);
    await openCase(page, 'SR-7K3Q-9M2D');
    const panel = page.getByTestId('callback-panel');
    await expect(panel).toContainText('Revealing it is recorded with your name and the time.');
    await expect(page.getByTestId('callback-number')).toHaveCount(0);
    await expect(page.getByRole('main')).not.toContainText('+254');

    await panel.getByRole('button', { name: 'Reveal callback number' }).click();
    const dialog = page.getByTestId('callback-confirm');
    await expect(dialog).toContainText('This is recorded in the audit log with your name.');
    await expectAccessible(page, 'callback confirm dialog');
    await snap(page, '12-callback-confirm');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByTestId('callback-number')).toHaveCount(0);
    expect((await auditActions(request)).some(entry => entry.action === 'partner.referral.callback.read')).toBe(false);

    await panel.getByRole('button', { name: 'Reveal callback number' }).click();
    await page.getByTestId('callback-confirm').getByRole('button', { name: 'Reveal number' }).click();
    await expect(page.getByTestId('callback-number')).toHaveText('+254 700 000 123');
    await expect(panel.getByRole('link', { name: 'Call +254 700 000 123' })).toHaveAttribute('href', 'tel:+254700000123');
    expect((await auditActions(request)).filter(entry => entry.action === 'partner.referral.callback.read')).toEqual([
      expect.objectContaining({ outcome: 'success', referralId: ID['SR-7K3Q-9M2D'] }),
    ]);
    await snap(page, '13-callback-revealed');
    await panel.getByRole('button', { name: 'Hide number' }).click();
    await expect(page.getByTestId('callback-number')).toHaveCount(0);
  });

  test('a referral no longer shared shows only a neutral tombstone that names no cause', async ({ page }) => {
    await signIn(page);
    await openCase(page, 'SR-6HJK-3LTE');
    const tombstone = page.getByTestId('withdrawn-tombstone');
    await expect(tombstone.getByRole('heading', { name: 'No longer shared' })).toBeVisible();
    await expect(tombstone).toContainText(
      'This report is no longer shared with your organisation. Its details and any callback number have been removed.',
    );
    await expect(page.getByRole('region', { name: 'Summary' })).toContainText('Not shown');
    await expect(page.getByRole('region', { name: 'Summary' })).toContainText('No longer shared');
    // A survivor's withdrawal and an operator's revoke must be indistinguishable.
    await expect(page.getByRole('main')).not.toContainText(/withdr|survivor|SafeRide/i);
    await expect(page.getByRole('region', { name: 'Status' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Evidence' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Internal notes' })).toHaveCount(0);
    await expectAccessible(page, 'case no longer shared');
    await snap(page, '14-case-no-longer-shared');
  });

  test("another organisation's case is simply not found, and a non-UUID ID is never requested", async ({ page, request }) => {
    await signIn(page);
    await page.goto(`/case/?id=${ID['SR-OTHR-0RG1']}`);
    await expect(page.getByText('This case was not found, or you do not have access to it.')).toBeVisible();
    await expectNoCaseContent(page);
    await expectAccessible(page, 'case not found');
    const reads = (await auditActions(request)).filter(entry => entry.action === 'partner.referral.read');
    await page.goto('/case/?id=ref_0001');
    await expect(page.getByText('No case was selected.')).toBeVisible();
    expect((await auditActions(request)).filter(entry => entry.action === 'partner.referral.read')).toHaveLength(reads.length);
  });

  test('a case that stops being shared while open turns into the tombstone on the next action (410)', async ({ page, request }) => {
    await signIn(page);
    await openCase(page, 'SR-4T8N-2XHB');
    await expect(page.getByText('SYNTHETIC. Waiting for the survivor to call')).toBeVisible();
    await request.post(`/__mock/referrals/${ID['SR-4T8N-2XHB']}/withdraw`);
    await page.getByRole('region', { name: 'Internal notes' }).getByLabel('New note').fill('SYNTHETIC. Too late.');
    await page.getByRole('button', { name: 'Add note' }).click();
    await expect(page.getByTestId('withdrawn-tombstone')).toBeVisible();
    await expect(page.getByRole('main')).not.toContainText('SYNTHETIC');
    const notes = (await auditActions(request)).filter(entry => entry.action === 'partner.referral.note');
    expect(notes).toEqual([expect.objectContaining({ outcome: 'denied' })]);
    await page.getByRole('link', { name: 'Back to cases' }).click();
    await expect(page.getByTestId('queue-row').nth(1)).toContainText('No longer shared');
  });

  test('an audit failure (503) shows a neutral error and no case content', async ({ page, request }) => {
    await signIn(page);
    await request.post('/__mock/fail-audit', { data: { count: 1 } });
    await page.getByRole('link', { name: 'SR-7K3Q-9M2D' }).click();
    await expect(page.getByText('The partner service is unavailable. Try again shortly.')).toBeVisible();
    await expect(page.getByText(/Support reference: req_mock_/)).toBeVisible();
    await expectNoCaseContent(page);
    await expect(page).toHaveTitle('(2) Case · SafeRide × HURIA');
    await expectAccessible(page, 'case service unavailable');
    await snap(page, '14b-case-unavailable-503');
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Case SR-7K3Q-9M2D' })).toBeVisible();
  });

  test('content P3 could not project is reported plainly', async ({ page }) => {
    await signIn(page);
    await page.getByRole('button', { name: 'Load more cases' }).click();
    await openCase(page, 'SR-8ZXC-1VBN');
    await expect(page.getByText('This case’s content cannot be shown here.')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Status' })).toBeVisible();
  });

  test.describe('as an organisation admin', () => {
    test('the callback number cannot be revealed (caseworkers only)', async ({ page }) => {
      await signIn(page, { as: ADMIN });
      await expect(page.getByTestId('signed-in-as')).toContainText('Zawadi Test-Admin');
      await openCase(page, 'SR-7K3Q-9M2D');
      await expect(page.getByRole('button', { name: 'Reveal callback number' })).toHaveCount(0);
      await expect(page.getByTestId('callback-not-shared')).toHaveText(
        'The survivor shared a callback number for this case. Only caseworkers can reveal it.',
      );
      await expectAccessible(page, 'case detail (admin)');
      await snap(page, '13b-case-admin');
    });
  });
});
