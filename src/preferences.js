import { titleCase } from "./utils.js";

export const PREFERENCE_GROUPS = [
  { key: "languages", label: "Languages", getValues: (song) => [song.language] },
  { key: "genres", label: "Genres", getValues: (song) => [song.genre] },
  { key: "moods", label: "Moods", getValues: (song) => song.mood || [] },
  { key: "difficulties", label: "Difficulty", getValues: (song) => [song.difficulty], order: ["easy", "medium", "hard"] },
  { key: "vocalRanges", label: "Vocal range", getValues: (song) => [song.vocalRange], order: ["low", "medium", "high"] },
  { key: "performanceTypes", label: "Performance type", getValues: (song) => [song.performanceType], order: ["solo", "duet", "group"] },
  { key: "eras", label: "Era", getValues: (song) => [song.era], descending: true }
];

export function getCatalogPreferenceOptions(songs = []) {
  return PREFERENCE_GROUPS.reduce((groups, group) => {
    const values = new Map();
    songs.forEach((song) => {
      group.getValues(song).forEach((value) => {
        if (typeof value !== "string") return;
        const normalized = value.trim().replace(/\s+/g, " ");
        if (!normalized) return;
        const key = normalized.toLowerCase();
        if (!values.has(key)) values.set(key, normalized);
      });
    });

    const options = [...values.values()].sort((left, right) => comparePreferenceValues(left, right, group));
    groups[group.key] = options;
    return groups;
  }, {});
}

export function preferenceValueIsSelected(values, option) {
  const key = String(option).trim().toLowerCase();
  return (Array.isArray(values) ? values : []).some((value) => String(value).trim().toLowerCase() === key);
}

export function getPreferenceSummary(preferences = {}, options = getCatalogPreferenceOptions([])) {
  const selected = [];
  PREFERENCE_GROUPS.forEach((group) => {
    (options[group.key] || []).forEach((option) => {
      if (preferenceValueIsSelected(preferences[group.key], option)) selected.push(formatPreferenceValue(option, group.key));
    });
  });
  if (selected.length === 0) return "No preferences yet";
  const visible = selected.slice(0, 4);
  const remainder = selected.length - visible.length;
  return `${visible.join(" · ")}${remainder > 0 ? ` · +${remainder} more` : ""}`;
}

function comparePreferenceValues(left, right, group) {
  const leftIndex = group.order?.indexOf(left.toLowerCase()) ?? -1;
  const rightIndex = group.order?.indexOf(right.toLowerCase()) ?? -1;
  if (leftIndex >= 0 || rightIndex >= 0) return (leftIndex < 0 ? 999 : leftIndex) - (rightIndex < 0 ? 999 : rightIndex);
  if (group.descending) return right.localeCompare(left, undefined, { numeric: true });
  return left.localeCompare(right, undefined, { numeric: true });
}

function formatPreferenceValue(value, key) {
  if (key === "eras") return value;
  return titleCase(value);
}
