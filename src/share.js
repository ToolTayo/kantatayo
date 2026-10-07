const SONG_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,80}$/;
const MEDLEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,80}$/;

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

export function createMedleyShareUrl(medleyId, locationRef = globalThis.location) {
  const id = normalizeMedleyId(medleyId);
  const base = locationRef?.href || String(locationRef || "");
  if (!id || !base) return "";
  try {
    const url = new URL(base, "http://localhost");
    url.search = "";
    url.searchParams.set("medley", id);
    url.hash = "#collections";
    return url.toString();
  } catch {
    return "";
  }
}

export function parseMedleyShareId(locationRef = globalThis.location) {
  const href = locationRef?.href || String(locationRef || "");
  if (!href) return "";
  try {
    const value = new URL(href, "http://localhost").searchParams.get("medley") || "";
    return MEDLEY_ID_PATTERN.test(value.trim()) ? value.trim() : "";
  } catch {
    return "";
  }
}

export async function shareSong(song, { navigatorRef = globalThis.navigator, locationRef = globalThis.location, logger = console } = {}) {
  const url = createSongShareUrl(song?.id, locationRef);
  if (!url || !song) return { status: "invalid", url: "" };
  return shareLink({
    title: `${song.title} · KantaCue`,
    text: `Sing ${song.title} by ${song.artist} on KantaCue.`,
    url
  }, { navigatorRef, logger });
}

export async function shareMedley(medley, { navigatorRef = globalThis.navigator, locationRef = globalThis.location, logger = console } = {}) {
  const url = createMedleyShareUrl(medley?.id, locationRef);
  if (!url || !medley) return { status: "invalid", url: "" };
  return shareLink({
    title: `${medley.title} · KantaCue`,
    text: `Explore ${medley.title}, a karaoke medley from ${medley.provider}, in KantaCue.`,
    url
  }, { navigatorRef, logger });
}

async function shareLink(shareData, { navigatorRef, logger }) {
  const { url } = shareData;
  if (typeof navigatorRef?.share === "function") {
    try {
      await navigatorRef.share(shareData);
      return { status: "shared", url };
    } catch (error) {
      if (error?.name === "AbortError") return { status: "cancelled", url };
      logger.info?.("[KantaCue] Native share was unavailable; trying clipboard.", error);
    }
  }

  if (typeof navigatorRef?.clipboard?.writeText !== "function") return { status: "unavailable", url };
  try {
    await navigatorRef.clipboard.writeText(url);
    return { status: "copied", url };
  } catch (error) {
    logger.info?.("[KantaCue] Clipboard share was unavailable.", error);
    return { status: "failed", url };
  }
}

function normalizeSongId(value) {
  const id = typeof value === "string" ? value.trim() : "";
  return SONG_ID_PATTERN.test(id) ? id : "";
}

function normalizeMedleyId(value) {
  const id = typeof value === "string" ? value.trim() : "";
  return MEDLEY_ID_PATTERN.test(id) ? id : "";
}
