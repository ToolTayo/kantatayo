export function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  })[character]);
}

export function formatSongMeta(song) {
  return [song.language, titleCase(song.difficulty), titleCase(song.performanceType)].filter(Boolean);
}

export function titleCase(value = "") {
  return String(value).replace(/\b\w/g, (character) => character.toUpperCase());
}
