# Storage Flow

## Target Upload Flow

```text
Expo app
  -> POST /api/cases/:id/evidence
  -> API validates MIME, size, ownership, and retention metadata
  -> API returns MinIO signed PUT URL
  -> Expo uploads directly to MinIO
  -> POST /api/cases/:caseId/evidence/:attachmentId/complete
  -> API hashes object and commits metadata (uploaded, scan pending, quarantined)
  -> API scan worker streams the object to clamd (ClamAV)
  -> clean: released | infected: rejected | errors: retried, then failed (quarantined)
```

## Implemented Scaffold

- Size validation capped at 100 MB.
- MIME type is required.
- Upload manifests are stored with attachment metadata.
- SHA-256 hash verification runs after upload completion.
- Malware scanning: ClamAV (clamd) through `services/evidenceMalwareScan.ts`
  and `services/clamav/`, in the API process, once the privacy controls'
  `malwareScanPolicy` names the running scanner. Flow, records and operations:
  [`infra/selfhost/README.md`](../../infra/selfhost/README.md#malware-scanning-clamav).
- Signed upload URLs expire after 5 minutes.

## Security Notes

Clients do not receive arbitrary bucket access. They receive a short-lived object-specific signed URL after API authorization.

## Current Mobile Path

Mobile case submissions request object-specific signed upload URLs from the API, upload evidence to MinIO/S3-compatible storage, then call the completion endpoint so the API can hash and finalize metadata.

## Partner Sharing: Metadata-Stripped Derivatives

Originals keep their EXIF GPS, device make/model and other metadata and are
never modified. Partners are only ever served a derivative:

- `npm --prefix apps/api run evidence:derivatives` (`jobs/evidenceDerivativeJob.ts`)
  takes each released attachment, strips it with `services/evidenceStrip`, re-parses
  the result to prove the metadata is gone and the pixels or samples are unchanged,
  and writes it to `evidence-derivatives/<uuid>/<uuid>` with a record in
  `saferide.evidence_derivatives` (migration 009). Each file is stripped in a
  worker thread with a 30 s and 256 MB heap budget, and each item has a 120 s
  overall timeout, so one crafted file cannot stall or exhaust the run; a file
  over budget is recorded `failed` (`resource_limit`) and not retried. Run it as a
  one-shot process (cron or timer), not inside the API server: peak memory is about
  twice the largest file plus the sandbox heap.
- JPEG, PNG, MP4/MOV/M4A/3GP, MP3 and WAV are stripped. HEIC/HEIF/AVIF, PDF, GIF,
  WebP and anything else are recorded `unsupported` and are never shareable.
- Not inspected (it would need a full decode): data a codec carries inside its own
  bitstream (H.264/HEVC SEI user data, bytes after the last JPEG scan or the PNG
  zlib stream) and encoder names LAME pads into MP3 frames. Phone cameras do not
  put location there.
- `getShareableDerivative(attachmentId)` in `services/evidenceDerivatives.ts` returns
  the derivative key to presign, or `unsupported_format`, `processing`, `failed` or
  `not_released`. It re-checks the attachment's release on every call.
- A derivative follows its attachment's retention policy and is deleted with it; the
  job then deletes the stored copy from the queue in
  `saferide.evidence_derivative_object_purges`.
