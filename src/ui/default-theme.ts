// ============================================================================
// ui/default-theme.ts
//
// The fallback pack: colours and neutral words, no art at all.
//
// It exists so the game is playable before anyone has loaded a skin, and so a
// user pack that only covers half its keys still renders the other half as
// legible blocks rather than gaps. Its vocabulary is deliberately abstract —
// this is the theme that has no theme. Flavoured packs (the bundled one
// included) are data, loaded at runtime, never compiled in.
// ============================================================================

import type { LoadedTheme } from "../theme.ts";

export const PLAIN_THEME: LoadedTheme = {
  id: "plain",
  name: "Plain",
  tileSize: 64,
  root: "",
  // No art. Every key falls through to the palette.
  sprites: {},
  strings: {
    "piece.singular": "piece",
    "piece.plural": "pieces",
    "hazard.primary": "hazard",
    "action.move": "Move",
    "action.leap": "Leap",
    "action.hazard": "Hazard",
    "zone.home": "home",
    "zone.shore": "shore",
    "zone.rocks": "rocks",
    "zone.bench": "bench",
  },
  palette: {
    water: "#1d4f6b",
    void: "#101418",
    start: "#2a6b7d",
    "home.shore": "#6b7a3a",
    "home.rocks": "#8a8577",
    "home.bench": "#c2a33f",
    primary: "#e6e6e6",
    highlight: "#ffd400",
    player0: "#d64545",
    player1: "#49a463",
    player2: "#4a86d6",
    player3: "#e0a92b",
  },
};
