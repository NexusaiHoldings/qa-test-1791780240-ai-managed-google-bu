/**
 * active-theme — the resolved ThemeContract this company wears.
 * Written by provisioning (_step_substrate_install): an approved mood
 * board's derived theme wins, else the CMO's authored ThemeContract
 * (company-theme-authoring-001 / visual phase 3b). Do NOT hand-edit.
 */
import type { ThemeContract } from "./contract";

export const activeTheme: ThemeContract = {
  "type": {
    "fontBody": "inter",
    "fontHeading": "inter"
  },
  "color": {
    "bg": "#ffffff",
    "text": "#15213b",
    "accent": "#1f4fd8",
    "border": "#d9e0ec",
    "danger": "#b3261e",
    "success": "#1b7a47",
    "surface": "#f5f7fb",
    "textMuted": "#52607a",
    "accentText": "#ffffff",
    "surfaceAlt": "#eaeef6",
    "borderStrong": "#b8c3d6"
  },
  "shape": {
    "radius": 6
  }
};
