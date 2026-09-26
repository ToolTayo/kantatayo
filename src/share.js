const SONG_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,80}$/;

export function createSongShareUrl(songId, locationRef = globalThis.location) {
  const id = normalizeSongId(songId);
  if (!id) return "";
  const base = locationRef?.href || String(locationRef || "");
  if (!base) return "";
  try {
    const url = new URL(base, "http://localhost");
    url.search = "";
    url.searchParams.set("song", id);
    return url.toString();
  } catch {
    return "";
  }
}

export function parseSongShareId(locationRef = globalThis.location) {
  const href = locationRef?.href || String(locationRef || "");
  if (!href) return "";
  try {
    const value = new URL(href, "http://localhost").searchParams.get("song") || "";
    return SONG_ID_PATTERN.test(value.trim()) ? value.trim() : "";
  } catch {
    return "";
  }
}

export async function shareSong(song, { navigatorRef = globalThis.navigator, locationRef = globalThis.location, logger = console } = {}) {
  const url = createSongShareUrl(song?.id, locationRef);
  if (!url || !song) return { status: "invalid", url: "" };
  const shareData = {
    title: `${song.title} · KantaTayo`,
    text: `Sing ${song.title} by ${song.artist} on KantaTayo.`,
    url
  };

  if (typeof navigatorRef?.share === "function") {
    try {
      await navigatorRef.share(shareData);
      return { status: "shared", url };
    } catch (error) {
      if (error?.name === "AbortError") return { status: "cancelled", url };
      logger.info?.("[KantaTayo] Native share was unavailable; trying clipboard.", error);
    }
  }

  if (typeof navigatorRef?.clipboard?.writeText !== "function") return { status: "unavailable", url };
  try {
    await navigatorRef.clipboard.writeText(url);
    return { status: "copied", url };
  } catch (error) {
    logger.info?.("[KantaTayo] Clipboard share was unavailable.", error);
    return { status: "failed", url };
  }
}

function normalizeSongId(value) {
  const id = typeof value === "string" ? value.trim() : "";
  return SONG_ID_PATTERN.test(id) ? id : "";
}
