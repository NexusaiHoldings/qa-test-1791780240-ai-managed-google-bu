/**
 * Navigation configuration for the site-wide sticky nav strip.
 *
 * The substrate <TopNav /> imports NAV_CONFIG from this module and renders
 * `primary` as the always-visible link row and `groups` as labelled dropdown
 * sections. Links whose `adminOnly` flag is true (or whose href lives under
 * /admin/*) are filtered out of the public nav by the nav generator and only
 * render for operator/admin sessions.
 *
 * Labels deliberately use plain trade-owner language — owners say "ranking
 * dropped" and "reviews", never acronyms — so no internal shorthand (e.g.
 * "GBP") appears anywhere in user-facing nav copy.
 */

export interface NavLink {
  /** Absolute in-app path the link points at. */
  href: string;
  /** User-facing label rendered in the nav strip. */
  label: string;
  /** When true, the nav generator hides this link from non-admin sessions. */
  adminOnly?: boolean;
}

export interface NavGroup {
  /** Section heading shown for the dropdown group. */
  label: string;
  /** Links rendered inside the group, in display order. */
  links: NavLink[];
  /** When true, the entire group is hidden from non-admin sessions. */
  adminOnly?: boolean;
}

export interface NavConfig {
  /** Always-visible top-level links. The substrate Home link stays first. */
  primary: NavLink[];
  /** Labelled dropdown sections rendered after the primary links. */
  groups: NavGroup[];
}

export const NAV_CONFIG: NavConfig = {
  primary: [
    { href: "/", label: "Home" },
    { href: "/dashboard", label: "Dashboard" },
    { href: "/posts", label: "Posts" },
    { href: "/reviews", label: "Reviews" },
    { href: "/rankings", label: "Rankings" },
  ],
  groups: [
    {
      label: "Setup",
      links: [
        { href: "/connect", label: "Connect Google" },
        { href: "/voice", label: "Voice Profile" },
        { href: "/photos", label: "Photo Library" },
      ],
    },
    {
      label: "Free tools",
      links: [{ href: "/rank-check", label: "Rank Check" }],
    },
    {
      label: "Admin",
      adminOnly: true,
      links: [
        { href: "/admin/templates", label: "Templates", adminOnly: true },
        {
          href: "/admin/publishing-health",
          label: "Publishing Health",
          adminOnly: true,
        },
      ],
    },
  ],
};

/**
 * True when a link must never appear in the public nav: either it is
 * explicitly flagged admin-only or it lives under the /admin/* namespace
 * (the nav generator marks every /admin/* path admin-only by convention).
 */
export function isAdminOnlyLink(link: NavLink): boolean {
  return link.adminOnly === true || link.href.startsWith("/admin/");
}

/**
 * Primary links visible for the given session. Admins see everything;
 * everyone else never sees admin-only entries.
 */
export function getVisiblePrimary(isAdmin: boolean): NavLink[] {
  if (isAdmin) {
    return NAV_CONFIG.primary;
  }
  return NAV_CONFIG.primary.filter((link) => !isAdminOnlyLink(link));
}

/**
 * Nav groups visible for the given session, with admin-only links stripped
 * and any group left empty by stripping removed entirely.
 */
export function getVisibleGroups(isAdmin: boolean): NavGroup[] {
  return NAV_CONFIG.groups.filter(
    (group) => isAdmin || group.adminOnly !== true,
  )
    .map((group) => ({
      ...group,
      links: isAdmin
        ? group.links
        : group.links.filter((link) => !isAdminOnlyLink(link)),
    }))
    .filter((group) => group.links.length > 0);
}
