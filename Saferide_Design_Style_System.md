# SafeRide Design System Foundation

The September 2026 visual reskin supersedes the historical colour and radius
values below. Use `src/theme/tokens.ts` and
`docs/product/saferide-ui-reskin-reference.md` for the current ivory/lavender
palette, rounded surfaces, selected reference, and mobile verification evidence.
Existing semantic states, accessibility rules, and product behaviour still apply.

This document is the working visual and accessibility contract for the SafeRide mobile app. It replaces the previous sector-agnostic style notes with a SafeRide-specific system for safety reporting, privacy-preserving evidence workflows, offline legal aid, and Kenyan public-transport contexts.

Implementation source of truth:

- Runtime tokens: `src/theme/tokens.ts`
- App theme bridge: `src/theme/SimpleThemeProvider.tsx`
- Legacy provider shim: `src/theme/ThemeProvider.tsx`
- Usage and visual QA guide: `docs/migration/design-system-usage-visual-qa.md`
- Manual fixture surface: `src/screens/__fixtures__/DesignSystemFixtures.tsx`

Scope for this foundation: tokens, theme behavior, accessibility baselines, and migration guidance. Screen restyling and component rewrites belong in follow-up UI implementation issues.

## Design Intent

SafeRide should feel calm, discreet, trustworthy, and warm. The interface must support high-stress reporting moments without using alarm-heavy colors as the default visual language. The light theme uses a soft blush canvas, white surfaces, plum trust actions, softened teal safety states, clay consent cues, and restrained blue evidence cues so the app feels comforting without becoming a one-note pink or beige product. Safety states, consent prompts, evidence handling, offline status, and privacy controls have distinct semantic colors so screens can communicate state without relying on one blue brand color.

The light theme is the primary production mode. Dark mode and high-contrast mode are scaffolded through the same semantic tokens so future screens can adopt them without replacing local styles twice.

## Theme Modes

| Mode | Status | Intent |
| --- | --- | --- |
| `light` | Primary | Default SafeRide UI. Warm blush canvas, white surfaces, plum trust primary, separate safety/evidence/privacy states. |
| `dark` | Scaffolded | Low-light mode with the same semantic roles and Paper theme mapping. Validate screen-by-screen before defaulting to system dark mode in production. |
| `highContrast` | Scaffolded | Explicit high-contrast theme for manual accessibility settings. Uses black borders, strong text contrast, and a black focus ring. |
| `system` | Available preference | Resolves to `light` or `dark` from `Appearance` when explicitly selected. The provider defaults to `light` until dark-mode QA and a user setting are wired. High contrast remains explicit until an accessibility preference is wired. |

Use `mode` from `useTheme()` when a component needs to know the resolved design mode. Use `colorScheme` only for legacy light/dark branching.

## Color Tokens

All component colors should come from `useTheme().colors` or from `themeColors[mode]`. New code should not introduce raw hex values in screen styles unless the value is a temporary migration note with a named token target.

### Core Roles

| Token | Light value | Purpose |
| --- | --- | --- |
| `canvas` / `background` | `#FFF8F3` | App background and full-screen surfaces. |
| `surface` / `card` | `#FFFFFF` | Cards, form fields, dialogs, sheets. |
| `surfaceAlt` / `muted` | `#F8EFE8` | Grouped sections, subtle fills, inactive surfaces. |
| `foreground` / `textPrimary` | `#211513` | Main text and icons. |
| `textSecondary` | `#604A43` | Helper copy, secondary labels, timestamps. |
| `textTertiary` | `#80665D` | Placeholders, disabled copy, low-priority metadata. |
| `border` / `divider` | `#E6D3C8` / `#F0E1D7` | Inputs, list dividers, card outlines. |
| `primary` | `#713B5D` | Primary action, active navigation, trusted affordances. Primary buttons are solid, not gradient-led. |
| `primaryMuted` | `#F4E5EE` | Selected chips, primary callout background. |
| `accent` | `#F3E7F0` | Informational panels that should not read as urgent. |
| `focusRing` | `#713B5D` | Standard visible focus indicator in light mode. |

### SafeRide Semantic States

| State | Token set | Light value | Use when |
| --- | --- | --- | --- |
| Critical | `critical`, `criticalForeground`, `criticalMuted` | `#8C2430` | Immediate risk, hard blockers, or safety-critical failure. Prefer `destructive` for actions and `critical` for state. |
| Safety | `safety`, `safetyForeground`, `safetyMuted` | `#0D6F63` | Trusted safety actions, safe route/support confirmations, resolved safety checks. |
| Warning | `warning`, `warningForeground`, `warningMuted` | `#9A5A18` | Time-sensitive cautions, incomplete setup, non-blocking risk. |
| Offline | `offline`, `offlineForeground`, `offlineMuted` | `#6A6260` | No network, local assistant fallback, offline mode. |
| Queued | `queued`, `queuedForeground`, `queuedMuted` | `#6A6260` | Per-object sync/upload queue state, pending replay, deferred remote actions. |
| Consent | `consent`, `consentForeground`, `consentMuted` | `#8B4F22` | Explicit consent, legal acknowledgement, sharing permission. |
| Evidence | `evidence`, `evidenceForeground`, `evidenceMuted` | `#2F648C` | Evidence capture, attached media, chain-of-custody status. |
| Support | `support`, `supportForeground`, `supportMuted` | `#3D7652` | Provider directory, support resources, referral availability. |
| Case | `case`, `caseForeground`, `caseMuted` | `#47606A` | Case timeline, current case status, submitted/local/blocked case states. |
| Success | `success`, `successForeground`, `successMuted` | `#2E7D4F` | Completed saves, sent reports, confirmed settings. |
| Destructive | `destructive`, `destructiveForeground`, `dangerMuted` | `#A9313A` | Delete, revoke, reset, unsafe failure. |
| Privacy | `privacy`, `privacyForeground`, `privacyMuted` | `#714268` | Private mode, redaction, data visibility, sensitive fields. |
| Info | `info`, `infoForeground`, `infoMuted` | `#2F648C` | Neutral legal guidance, explainers, system updates. |
| Unavailable | `unavailable`, `unavailableForeground`, `unavailableMuted` | `#6A6260` | Disabled, future, blocked, or not-implemented capabilities. |

Muted semantic colors are backgrounds. Solid semantic colors are text, icon, border, or filled-control colors. Filled controls must use the matching foreground token.

## Typography

Tokens are defined in `typography` and use zero letter spacing by default. Current families stay compatible with the existing app, but all text must continue to respect React Native font scaling.

| Token | Size / line height | Use |
| --- | --- | --- |
| `titleXL` | 28 / 34, 700 | Screen titles and major empty states. |
| `titleL` | 22 / 28, 600 | Section headers, large card titles. |
| `titleM` | 20 / 26, 600 | Card headers and dialog headings. |
| `titleS` | 18 / 24, 600 | Compact group labels. |
| `bodyL` | 18 / 26, 400 | Long-form guidance where readability matters. |
| `bodyM` | 17 / 24, 400 | Default body copy and row labels. |
| `bodyS` | 15 / 22, 400 | Helper copy and dense metadata. |
| `caption` | 13 / 18, 400 | Badges, timestamps, disclaimers. |
| `label` | 15 / 20, 600 | Field labels and chip labels. |
| `button` | 17 / 22, 600 | Buttons and primary actions. |

Do not clamp text to a single line when truncation can hide safety, consent, or legal meaning. Rows and chips should grow vertically under larger dynamic type settings.

## Spacing, Shape, and Layout

Use `spacing` for all fixed gaps. The base rhythm is `4 / 8 / 12 / 16 / 20 / 24 / 32 / 40` with `spacing.gutter = 16` for screen gutters.

Layout constants:

- Minimum touch target: `44` pt.
- Preferred touch target: `48` pt.
- Action height: `52` pt.
- List row and form field height: `56` pt.
- Max readable copy width: `340` pt.
- Docked CTA bottom inset: `16` pt plus safe-area clearance.

Radii:

- Cards and framed sections: `8` pt.
- Inputs: `8` pt.
- Buttons: `10` pt.
- Chips/state pills: `16` pt.
- Sheets: `16` pt.
- Badges: `8` pt.

Use `radii.round` only for circular controls or full pills. Cards, forms, rows, and framed sections should stay restrained; do not make large page surfaces look like pill bubbles.

## Elevation, Feedback, and Motion

Elevation is intentionally quiet. Use `elevation.card` for grouped content, `elevation.floating` for docked or floating actions, and `elevation.sheet` for modal sheets. Avoid stacking multiple elevated surfaces inside each other.

Feedback tokens:

- Pressed opacity: `0.86`.
- Disabled opacity: `0.42`.
- Selection overlay: `rgba(113,59,93,0.12)`.
- Danger overlay: `rgba(169,49,58,0.10)`.

Motion durations:

- Quick state changes: `120ms`.
- Standard transitions: `180ms`.
- Deliberate transitions: `240ms`.
- Sheet transitions: `320ms`.

Layer tokens use `base`, `raised`, `header`, `footer`, `sheet`, `dialog`, `toast`, and `quickExit`. Use them instead of ad hoc z-index values.

Motion should never be required to understand whether evidence, consent, or emergency state changed. Pair animation with text, icon, or semantic color state.

## Theme Provider Contract

`SimpleThemeProvider` remains the app-level provider to avoid broad import churn. It now supplies:

```tsx
const { colors, tokens, semanticStates, mode, colorScheme, setTheme, paperTheme } = useTheme();
```

The provider also wraps children with React Native Paper's `PaperProvider`, using the same SafeRide color roles mapped onto MD3 theme fields. Future Paper components should not create separate Paper themes.

Use semantic state metadata when building reusable status components:

```tsx
const state = semanticStates.evidence;
const backgroundColor = colors[state.muted];
const color = colors[state.color];
```

For repeated object states, use the exported primitives before creating screen-local styles: `StatePill`, `StatusBanner`, `LoadingState`, `UnavailableState`, `FormSection`, `EvidenceRow`, `ProviderRow`, `CaseTimelineItem`, and `ConsentSummary`.

## Accessibility Baselines

Contrast:

- Body text and meaningful icons: at least 4.5:1 against the background.
- Large text: at least 3:1.
- Focus rings, selected borders, and non-text indicators: at least 3:1.
- Filled semantic states must use their paired foreground tokens.

Touch and layout:

- Interactive controls must be at least 44 x 44 pt.
- Primary actions should use the 52 pt action height.
- Adjacent destructive and primary actions need clear spacing or confirmation.
- Controls must remain reachable with safe-area and keyboard insets applied.

Screen readers:

- Buttons use verb-noun labels, for example "Save evidence" or "Share report".
- Icon-only controls need explicit accessibility labels.
- Consent controls announce the current state and consequence.
- Evidence and privacy controls announce whether data is local, queued, synced, hidden, or shared.
- Error messages are associated with the field or action that caused them.

Focus order:

- Default order is top-to-bottom, left-to-right.
- Keep related evidence, consent, and privacy controls grouped in the tree.
- Dialog focus starts on the title or first actionable control, then remains inside the dialog until dismissed.

Dynamic type:

- Components should allow font scaling and expansion through at least Extra Large.
- Text cannot overlap previous or next content at larger sizes.
- Chips and list rows wrap instead of shrinking below readable sizes.
- Critical legal or safety copy should not be hidden behind ellipses.

High contrast:

- Use `setTheme('highContrast')` once an app setting is wired.
- Do not special-case individual screens with local high-contrast colors; add missing tokens instead.

## Hard-Coded Color Migration Path

1. Keep existing screens stable until their owning redesign issue starts.
2. When touching a component, replace local hex values with `colors.<role>` or `tokens.colors[mode].<role>`.
3. Prefer semantic state tokens over visual descriptions. Use `evidence`, not `blue`; use `privacy`, not `purple`.
4. If a needed role is missing, add it to `ThemeColors`, all theme modes, and this document before using it.
5. Reusable UI components should consume `useTheme()` and token exports directly. Screens should pass intent, not raw colors, whenever possible.
6. Do not introduce new one-off shadows, radii, or spacing values unless the value is part of a documented component exception.
7. Validate changed screens with light mode first, then dark and high-contrast snapshots before enabling those modes for users.

## Review Checklist

- [ ] No new raw hex colors in screen/component styles unless documented as a temporary migration target.
- [ ] Semantic states use the token pair for background and foreground.
- [ ] Text contrast meets the baseline for light mode.
- [ ] Minimum touch target is 44 x 44 pt.
- [ ] Dynamic type does not clip safety, consent, evidence, or privacy copy.
- [ ] Icon-only controls have labels.
- [ ] Focus order follows the visual and task order.
- [ ] React Native Paper components use the app provider theme.
- [ ] Dark/high-contrast assumptions are either verified or explicitly noted in the PR.
