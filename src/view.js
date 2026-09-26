export const VIEW_NAMES = new Set(["home", "discover", "favorites", "recent", "party", "preferences", "exclusive"]);

export function normalizeView(value) {
  const candidate = String(value || "").replace(/^#/, "").toLowerCase();
  return VIEW_NAMES.has(candidate) || candidate === "top" ? (candidate === "top" ? "home" : candidate) : "home";
}

export function viewFromHash(hash = "") {
  return normalizeView(hash);
}

export function viewHash(view) {
  return normalizeView(view) === "home" ? "#top" : `#${normalizeView(view)}`;
}
