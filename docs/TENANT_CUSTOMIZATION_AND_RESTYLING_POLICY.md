# Tenant Customization & Restyling Policy
**Architectural Invariant Guide — Scoped CSS, Design Tokens & Isolation Standards**
*Document Version: 1.0.0 | Author: Platform UI & Frontend Architecture Sentinel*

---

## 1. Executive Summary & Purpose

The TMS Whitelabel Core platform powers multiple independent merchant storefronts from a single, unified codebase. To ensure that styling one store never bleeds into, overrides, or breaks another store, all customizations must strictly follow **Pattern A (Scoped CSS)** and **Pattern B (Design Tokens)**.

---

## 2. Invariant Architecture: Pattern A vs. Pattern B

### 2.1. Pattern A: Scoped CSS with `[data-tenant]`

Every HTML document rendered by the storefront mounts the active merchant's identifier onto the root element:
```html
<html data-tenant="keby254" lang="en">
```

> [!IMPORTANT]
> **Pattern A Rule**:
> Custom CSS overrides must **always** be scoped by the `[data-tenant="<slug>"]` attribute selector.
> Never write global unscoped CSS rules that modify base element tags (`button`, `header`, `h1`).

```css
/* ✅ CORRECT: Strictly scoped to the specific merchant */
[data-tenant="keby254"] .hero-banner {
  background: linear-gradient(135deg, #1b4332 0%, #2d6a4f 100%);
  border-radius: 16px;
}

[data-tenant="keby254"] .btn-checkout {
  background-color: #52b788;
  color: #081c15;
}

/* ❌ FORBIDDEN: Will bleed across other merchants */
.hero-banner {
  background: #1b4332;
}
button {
  background: #52b788;
}
```

### 2.2. Pattern B: `tenant.config.ts` 8-Token Design System

Every tenant profile is declared in a type-safe `tenant.config.ts` configuration file containing exactly 8 standard design tokens:

```typescript
export interface TenantConfig {
  slug: string;
  name: string;
  tagline: string;
  theme: {
    primaryColor: string;       // Token 1: Brand Primary (Buttons, Active states)
    primaryHover: string;       // Token 2: Hover / Interaction State
    surfaceBackground: string;  // Token 3: Card & Container Background
    pageBackground: string;     // Token 4: Global App Background
    textPrimary: string;        // Token 5: Main Heading & Body Typography
    textMuted: string;          // Token 6: Secondary labels & timestamps
    accentColor: string;        // Token 7: Badges, Pills, Sale tags
    borderColor: string;        // Token 8: Subtle dividers and card borders
  };
  typography: {
    fontFamily: string;
    headingFont: string;
  };
  navigation: {
    logoUrl: string;
    showSearch: boolean;
    categories: string[];
  };
}
```

---

## 3. Storefront Asset Management Invariants

1. **Asset Staging**:
   - Merchant logos, product banners, and icons must be hosted under `/public/tenants/<tenant-slug>/` or a secure CDN.
   - Assets must not exceed **250 KB** for logos and **800 KB** for hero banners to preserve sub-second mobile page loads.
2. **Font Loading**:
   - Web fonts must be loaded asynchronously using `font-display: swap`.
   - Maximum 2 font families per tenant (1 heading font + 1 body font).
3. **Responsive Breakpoints**:
   - Storefront styling must look pristine on:
     - 360px – 430px (Standard mobile screens / WhatsApp in-app browser).
     - 768px (Tablets).
     - 1024px+ (Desktop).

---

## 4. Verification & Regression CI Guard

Before any new tenant theme or customization is merged into `main`:
1. The **Multi-Tenant Storefront Audit Sentinel** runs an automated AST scan across all `.css`, `.scss`, and `.tsx` files.
2. If any unscoped rule is detected, CI fails immediately with:
   ```
   [ERROR] Violation of Pattern A: Unscoped selector found in themes.css.
   Rule must be prefixed with [data-tenant="<slug>"].
   ```
