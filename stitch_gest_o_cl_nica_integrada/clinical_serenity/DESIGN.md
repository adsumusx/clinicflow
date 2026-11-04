---
name: Clinical Serenity
colors:
  surface: '#e8fff0'
  surface-dim: '#b8e4cc'
  surface-bright: '#e8fff0'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#d1fee5'
  surface-container: '#ccf8df'
  surface-container-high: '#c6f2da'
  surface-container-highest: '#c1ecd4'
  on-surface: '#002114'
  on-surface-variant: '#404943'
  inverse-surface: '#0e3727'
  inverse-on-surface: '#cffbe2'
  outline: '#707973'
  outline-variant: '#bfc9c1'
  surface-tint: '#2c694e'
  primary: '#0f5238'
  on-primary: '#ffffff'
  primary-container: '#2d6a4f'
  on-primary-container: '#a8e7c5'
  inverse-primary: '#95d4b3'
  secondary: '#3e6750'
  on-secondary: '#ffffff'
  secondary-container: '#bdeacd'
  on-secondary-container: '#426b54'
  tertiary: '#004d6c'
  on-tertiary: '#ffffff'
  tertiary-container: '#00668e'
  on-tertiary-container: '#b2e0ff'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#b1f0ce'
  primary-fixed-dim: '#95d4b3'
  on-primary-fixed: '#002114'
  on-primary-fixed-variant: '#0e5138'
  secondary-fixed: '#c0edd0'
  secondary-fixed-dim: '#a4d1b4'
  on-secondary-fixed: '#002112'
  on-secondary-fixed-variant: '#264f39'
  tertiary-fixed: '#c6e7ff'
  tertiary-fixed-dim: '#84cffd'
  on-tertiary-fixed: '#001e2d'
  on-tertiary-fixed-variant: '#004c6b'
  background: '#e8fff0'
  on-background: '#002114'
  surface-variant: '#c1ecd4'
typography:
  display-lg:
    fontFamily: Inter
    fontSize: 48px
    fontWeight: '700'
    lineHeight: 56px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Inter
    fontSize: 32px
    fontWeight: '600'
    lineHeight: 40px
    letterSpacing: -0.01em
  headline-lg-mobile:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
  headline-md:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
  body-lg:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: '400'
    lineHeight: 28px
  body-md:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  body-sm:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  label-md:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '600'
    lineHeight: 16px
    letterSpacing: 0.05em
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  unit: 4px
  container-max: 1280px
  gutter: 24px
  margin-mobile: 16px
  margin-desktop: 32px
  stack-sm: 8px
  stack-md: 16px
  stack-lg: 24px
---

## Brand & Style
The design system is anchored in a philosophy of **Modern Clinical Excellence**. It prioritizes clarity, calm, and efficiency to serve a high-stakes environment involving physical health and financial management.

The style is a refined **Minimalism** with **Corporate Modern** influences. It utilizes significant whitespace to reduce cognitive load for practitioners and patients alike. The aesthetic is "High-Trust," avoiding trendy decorative elements in favor of functional precision. Visual cues are subtle, ensuring that critical medical and financial data remain the focal point. The emotional response is one of organized tranquility—moving the user from the chaos of administrative tasks to the focused calm of patient care.

## Colors
The palette is centered on **Deep Sage Green**, a color that bridges the gap between medical professionalism and holistic wellness (Pilates/Physio). 

- **Primary (#2D6A4F):** Used for primary actions, branding, and active states. It suggests growth and stability.
- **Secondary (#B7E4C7):** A soft mint used for subtle backgrounds, progress bars, and accent highlights.
- **Tertiary (#1A759F):** A calm blue reserved for secondary interactive elements or specific medical data categorizations.
- **Neutrals:** White is the primary canvas. Slate (#1B4332) is used for typography to maintain high contrast while staying within the green-toned family for a softer feel than pure black.
- **Status Colors:** These are slightly desaturated to maintain the "calm" atmosphere but remain distinct for immediate recognition of appointment status or payment urgency.

## Typography
This design system utilizes **Inter** for all roles. Its high x-height and systematic glyph construction make it ideal for data-heavy health dashboards and medical records.

Hierarchy is established through weight and scale rather than decorative shifts. 
- **Headlines:** Use Semi-Bold (600) for clear section identification.
- **Body:** Regular (400) is the standard for patient notes and reports to ensure maximum legibility.
- **Labels:** Small caps or slightly tracked-out uppercase labels (12px) are used for metadata, status tags, and table headers to distinguish them from editable data.

## Layout & Spacing
The layout follows a **Fluid Grid** approach with strict constraints on maximum container widths to ensure readability of text-heavy medical documents.

- **Grid Model:** 12-column system for desktop, 4-column for mobile.
- **Rhythm:** An 8px base grid governs all spatial relationships. 
- **Desktop:** 32px side margins with 24px gutters. Dashboard widgets and cards should span 3, 4, 6, or 12 columns.
- **Mobile:** Margins shrink to 16px. Cards typically stack vertically in a single column to maintain touch-target integrity for registration forms.
- **Content Density:** Use "stack-lg" (24px) for separating major functional groups (e.g., Patient Info vs. Treatment History) and "stack-sm" (8px) for internal element grouping (e.g., Label and Input).

## Elevation & Depth
Elevation is handled through **Tonal Layers** and **Ambient Shadows** to create a sense of organized structure without clutter.

- **Level 0 (Background):** The base layer is `#F8FAFB`. This provides a soft contrast for pure white cards.
- **Level 1 (Cards/Surface):** Pure white background with a very soft, diffused shadow (0px 4px 20px rgba(27, 67, 50, 0.05)). This makes the card appear slightly lifted from the page.
- **Level 2 (Popovers/Modals):** Stronger elevation with a more pronounced shadow (0px 10px 30px rgba(27, 67, 50, 0.12)) and a 1px border in `#EDF2F4` to define edges against other white surfaces.
- **Interactive States:** On hover, interactive cards should slightly increase shadow depth (Y-offset +2px) to provide tactile feedback.

## Shapes
The shape language is **Soft**, striking a balance between the rigid precision of medical institutions and the welcoming nature of wellness studios.

- **Standard Elements:** 0.25rem (4px) corner radius for input fields, checkboxes, and small buttons.
- **Containers:** 0.5rem (8px) for cards and main UI containers.
- **Special Elements:** Status badges (chips) and main call-to-action buttons may use the `rounded-xl` (12px) setting to stand out as distinct, friendly interaction points.

## Components
- **Buttons:** Primary buttons use the Primary Green with white text. Secondary buttons use a "Ghost" style (Primary Green border and text) to reduce visual noise.
- **Status Badges:** Small, pill-shaped chips. Use "Subtle" coloring (10% opacity of the status color for the background, 100% opacity for the text). Example: "Confirmed" has a light green background with dark green text.
- **Calendar UI:** Time slots are represented as blocks with 4px border-radius. Current time is indicated by a Primary Teal line. "Blocked" or "Unavailable" slots use a light grey diagonal hash pattern.
- **Input Fields:** Use a 1px border in `#EDF2F4`. On focus, the border transitions to Primary Teal with a subtle 2px outer glow of the same color. Labels always sit above the field in `label-md` style.
- **Charts:** Financial and patient progress charts use a palette of Primary Teal, Tertiary Blue, and Secondary Mint. Avoid red unless indicating negative financial growth or health risks. Use clean lines and avoid 3D effects or heavy gradients.
- **Cards:** Used for client profiles and financial summaries. They must include a clear header area and a footer for primary actions (e.g., "View Profile" or "Edit").