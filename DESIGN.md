---
version: alpha
name: SafeScroll
description: On-device moderation that obscures unsafe feed content in place while preserving the host page.
colors:
  background: "#080b10"
  surface: "#11161e"
  text: "#f4f7fb"
  muted: "#8e9aaa"
  accent: "#66e3a4"
  danger: "#ff7b86"
  warning: "#ffc06b"
typography:
  sans:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
  overlay:
    fontFamily: "system-ui, sans-serif"
rounded:
  DEFAULT: "8px"
  card: "18px"
  overlay: "12px"
spacing:
  popup-padding: "18px"
  dashboard-sidebar: "238px"
components:
  shield: {}
  button: {}
  card: {}
---

# SafeScroll Design System

## Overview

### Creative North Star

A quiet safety lens over a busy feed: show exactly which authored content is obscured and keep the surrounding website recognizable.

### Product context and register

- **Audience and job:** People browsing social feeds who want unsafe text or imagery hidden until they choose to reveal it.
- **Market and locale:** No market-specific visual convention is established. Extension-owned UI is currently English.
- **Usage scene:** A Chrome popup and dashboard, plus compact in-page shields on desktop and narrow screens.
- **Register:** Product utility. The host page keeps its layout and controls.
- **Signature:** A bounded blur with a small, legible SafeScroll status and “Show anyway” control.
- **Restraint:** Do not decorate, move, or recolor the host page outside the shielded content.
- **Anti-reference:** Full-page dimmers and large cards over one comment obscure unrelated reading and navigation.
- **Token ownership:** This file records the established runtime values. [popup.css](src/popup/popup.css) and [options.css](src/options/options.css) own extension-page tokens; [shield.js](src/content/shield.js) owns the in-page overlay values. Keep changes to these owners synchronized with this file.

## Colors

The popup and dashboard use deep blue-black surfaces, white text, mint accent, and semantic danger and warning tones. Shields use a dark translucent veil over unsafe content so high-contrast text in thumbnails cannot be read through blur. The veil belongs only to the target content area.

## Typography

Extension pages use the Inter/system stack. In-page shields use `system-ui` to render predictably over sites with unknown fonts. Short labels stay legible in compact and mobile targets.

## Layout

The popup is 370px wide; the dashboard uses a 238px sidebar at desktop width and collapses at narrow widths. In-page shields are positioned over their target and must not affect document flow. Text and media can be shielded separately; one toxic comment must not cover the video or its neighboring comments.

## Elevation & Depth

Dashboard cards use subtle borders and shadows. A shield uses backdrop blur and a translucent veil; its status pill sits above the hidden content. YouTube and Instagram use a stronger veil for bright, high-contrast photo and comment surfaces. Avoid a viewport-wide backdrop for one unit.

## Shapes

Cards are softly rounded; shield corners follow the target with an 8px radius and the status pill uses 12px. The reveal control remains compact enough for short comment lines.

## Components

### Foundational visual states

The shield has scanning, blocked, flagged, and revealed states. Blocked and flagged content is unreadable until revealed; scanning is visibly pending. A detached overlay is recreated when the page rerenders its target. Clean content has no retained shield.

### Buttons and actions

“Show anyway” is the only in-page shield action. It is a native button, stays visible at compact sizes, and must not activate an underlying YouTube or Instagram link. Child Mode guards it with the existing PIN flow.

### Navigation and data display

Host-site navigation stays usable outside the targeted unit. The popup and dashboard retain their existing navigation, statistics, and recent-verdict presentation.

### Forms and overlays

The shield is non-modal and local to a content unit. Its control is keyboard reachable. The existing loading banner is a separate fixed status surface.

### Iconography

Status uses a short text label with the existing stop or warning symbol; color alone never carries the verdict.

### Motion

Only the compact status pill adjusts smoothly to target size. No entrance animation is needed for a feed that rerenders frequently.

### Content and data visualization

Use plain status and action copy. Source labels may explain why content was hidden; never expose the toxic text inside the shield status.

## Do's and Don'ts

- **Do:** Align each shield to the classified text or media, with a safe fallback when the exact target disappears.
- **Do:** Keep the shared shield primitive consistent across YouTube, X, and other sites.
- **Don't:** Blur the video player because a thumbnail or comment was classified.
- **Don't:** Let page rerenders remove a block while the verdict remains active.
