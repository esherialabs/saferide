# SafeRide Website Image Prompts

Create these files under `web/public/images/`. Use `.webp` files for launch assets and keep final files web-optimized, ideally below 200 KB each.

## Global Art Direction

- Editorial, Mozilla-inspired civic-tech campaign photography mixed with subtle product mockup realism.
- Nairobi public transport context, but no sensational violence, panic, police-arrest scene, visible injury, exposed survivor identity, real case detail, minors, readable personal phone numbers, or readable licence plates.
- Diverse adult Kenyan women, transport workers, technologists, and support professionals shown with dignity and agency.
- SafeRide brand energy: black ink lines, strong geometry, high contrast, warm Nairobi daylight, accents of green `#53E17C`, blue `#50C9F0`, yellow `#F7EC36`, and orange `#F88539`.
- Leave negative space for bold text overlays. Prefer documentary realism with lightly stylized editorial composition.

## Required Files

## Playbook Hero Replacement Brief

The current site can render hero images on `/how-it-works`, `/for-survivors`, and `/privacy-safety-trust`. The files below may replace the existing reused launch images when final art is ready. Use 1600 x 1100 PNG or WebP, keep the subject centered enough for mobile cropping, and leave quiet space in the lower third because the template overlays two small stat cards.

### `how-it-works-hero.png`

- **Use:** `/how-it-works` hero visual.
- **Prompt:**
  > Editorial product scene showing an Android phone with a SafeRide reporting workflow: local draft, evidence step, pathway choice, and consent review, placed beside a Nairobi matatu interior detail, bright daylight, black geometric framing, SafeRide green blue yellow orange accents, no readable private case text, no real plate numbers, no exposed survivor identity, confident civic-tech campaign mood, high contrast, documentary realism with subtle product mockup.
- **Negative prompt:** police arrest, violence, crying, readable personal data, visible licence plate, minors, horror lighting, generic ride-hailing UI.

### `for-survivors-hero.png`

- **Use:** `/for-survivors` hero visual.
- **Prompt:**
  > Calm privacy-respecting Nairobi public transport scene, adult Kenyan woman rider holding a phone low with a SafeRide private draft interface visible only as safe generic labels, face turned away or anonymized by framing, warm daylight, dignified survivor-centered composition, subtle SafeRide color blocks, no incident scene, no distress close-up, no readable identity details, room for interface overlay.
- **Negative prompt:** sensational violence, exposed face in trauma, child, police station, hospital trauma, readable phone number, readable route tied to a case.

### `privacy-trust-hero.png`

- **Use:** `/privacy-safety-trust` hero visual.
- **Prompt:**
  > Premium editorial product image of SafeRide privacy controls on Android: consent gate, redaction levels, retention choices, export and delete controls, with abstract data-flow cards and Kenyan transport context in the background, crisp black outlines, SafeRide green and blue with yellow highlights, serious legal-safety tone, no real case data, no surveillance aesthetic.
- **Negative prompt:** hacker screen, biometric scan, police badge, real survivor testimony, medical diagnosis, exposed personal data, dark cyberpunk palette.

### 1. `matatu-interior.webp`

- **Use:** homepage survivor hero and community card.
- **Size:** 1600 × 1100.
- **Prompt:**
  > Editorial documentary photo inside a Nairobi matatu during daytime, adult Kenyan women commuters seated calmly, faces turned away or softly anonymized by motion blur and framing, warm sunlight through windows, colorful seat fabric, subtle SafeRide green and yellow visual accents on a phone screen without readable private text, dignified survivor-centered mood, no visible harassment, no minors, no readable licence plates, high-contrast civic-tech campaign style, wide composition with empty space on the left for headline text.
- **Negative prompt:** violence, fear, injury, crying, police arrest, readable personal data, readable licence plate, child, sexualized pose, dark horror lighting.

### 2. `route-safety-bus.webp`

- **Use:** story page hero (it was the route-safety hero before the route safety index page was replaced by the partner dashboard).
- **Size:** 1600 × 1100.
- **Prompt:**
  > Nairobi matatu stage in bright afternoon light, adult commuters and a transport operator discussing a simple route-safety board, colorful matatu partially visible with licence plate blurred, abstract route lines and SafeRide color accents integrated as editorial graphic overlays, atmosphere of practical public transport accountability, civic-tech field pilot photography, no incident scene, no police confrontation, strong black geometric framing, room on the right for text.
- **Negative prompt:** crash, crime scene, police arrest, readable licence plate, crowd panic, minors, exposed faces in distress, surveillance aesthetic.

### 3. `app-and-brand.webp`

- **Use:** open-source hero.
- **Size:** 1600 × 1100.
- **Prompt:**
  > Premium product still life of an Android phone showing a SafeRide home screen mockup with tiles for File report, Quick Chat, Case Tracker, Learn, Safety Settings, and Privacy Data, beside a simple SafeRide shield logo card, Nairobi desk setting with notebook and USB cable, green blue yellow orange brand blocks, clean high-contrast lighting, readable UI labels only from the SafeRide product, no real case data, no personal information, editorial civic-tech launch image.
- **Negative prompt:** iPhone only, generic ride-hailing app, real names, real incident text, medical images, emergency gore, cluttered desk.

### 4. `operator-pilot.webp`

- **Use:** editorial card for pilot readiness.
- **Size:** 1400 × 1050.
- **Prompt:**
  > Adult Kenyan women safety reviewers, a SACCO operator, and a civic-tech facilitator gathered around a printed matatu route map and anonymized dashboard mockups, collaborative workshop table, sticky notes in SafeRide colors, no survivor testimony visible, no private details, Nairobi daylight office or community hall, confident practical mood, editorial photo with bold black shadows and graphic composition.
- **Negative prompt:** corporate stock handshake, police interrogation, readable case notes, identifiable survivor story, minors, courtroom drama, hospital trauma scene.

### 5. `app-dashboard.webp`

- **Use:** editorial card for privacy-first AI and app dashboard.
- **Size:** 1400 × 1050.
- **Prompt:**
  > Close-up Android phone mockup showing SafeRide dashboard and on-device assistant status card, visible labels: “Saferide Gemma-3n”, “Ready offline”, “Guidance”, “Transcription”, “Offence tagging”, and quick chips like “Explain the P3 form”, warm gradient background, bold SafeRide green and blue, no real conversation, no personal data, crisp product photography with subtle Nairobi fabric texture underneath.
- **Negative prompt:** ChatGPT logo, OpenAI logo, real survivor text, medical diagnosis, police badge, readable phone number, iOS-only frame, dark hacker aesthetic.

### 6. `legal-aid-guidance.webp`

- **Use:** editorial and legal/support content cards.
- **Size:** 1400 × 1050.
- **Prompt:**
  > Warm editorial illustration-photo hybrid of a Kenyan support professional and an adult woman reviewing neutral SafeRide guidance cards on a table, cards labeled “PEP within 72 hours”, “1195 GBV helpline”, “P3 form”, “Evidence safety”, “Referral options”, privacy-respecting composition with faces partially turned away, no distress imagery, no medical procedure, no police station, SafeRide yellow and orange blocks, hopeful calm support atmosphere.
- **Negative prompt:** graphic assault imagery, crying close-up, hospital trauma, courtroom, police arrest, readable personal details, children, sensational news style.

### 7. `og.png`

- **Use:** social share image, used by Open Graph metadata.
- **Size:** 1200 × 628.
- **Prompt:**
  > Bold SafeRide social card, large SafeRide shield mark, headline “Safer journeys for every woman”, subline “Local-first reporting, consent before sharing”, abstract Nairobi route map lines, high-contrast green, blue, yellow, orange blocks on white, Mozilla-inspired editorial layout, no people, no private data, crisp vector-like graphic.

## Export Checklist

- Confirm every referenced image exists in `web/public/images/` with the exact filename.
- Blur or remove licence plates, faces in sensitive contexts, phone numbers, route IDs tied to a real case, and any personal data.
- Avoid implying SafeRide provides emergency rescue, police response, legal representation, or medical care.
- After adding images, run `npm --prefix web run build` and Playwright smoke tests to catch Next image optimizer issues.
