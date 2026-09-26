export function isStandaloneDisplay(windowRef = globalThis.window) {
  return Boolean(windowRef?.matchMedia?.("(display-mode: standalone)")?.matches || windowRef?.navigator?.standalone === true);
}

export function createInstallController({ windowRef = globalThis.window, buttons = [], onStatus = () => {}, logger = console } = {}) {
  const installButtons = Array.from(buttons || []).filter(Boolean);
  let deferredPrompt = null;
  let installed = isStandaloneDisplay(windowRef);

  const sync = () => {
    const actionable = Boolean(deferredPrompt) && !installed;
    installButtons.forEach((button) => {
      button.hidden = !actionable;
      button.disabled = !actionable;
    });
    return actionable;
  };

  const handleBeforeInstallPrompt = (event) => {
    event.preventDefault?.();
    if (installed) return;
    deferredPrompt = event;
    sync();
  };

  const handleInstalled = () => {
    installed = true;
    deferredPrompt = null;
    sync();
    onStatus("KantaTayo is installed on this device.");
  };

  const handleClick = async () => {
    if (!deferredPrompt || installed) return { status: "unavailable" };
    const promptEvent = deferredPrompt;
    deferredPrompt = null;
    sync();
    try {
      await promptEvent.prompt();
      const choice = await promptEvent.userChoice;
      if (choice?.outcome === "accepted") onStatus("KantaTayo was added to your apps.");
      else onStatus("Install dismissed. You can install KantaTayo later.");
      return { status: choice?.outcome === "accepted" ? "accepted" : "dismissed" };
    } catch (error) {
      logger.info?.("[KantaTayo] Install prompt was unavailable.", error);
      onStatus("Install is not available right now.");
      return { status: "failed" };
    }
  };

  windowRef?.addEventListener?.("beforeinstallprompt", handleBeforeInstallPrompt);
  windowRef?.addEventListener?.("appinstalled", handleInstalled);
  installButtons.forEach((button) => button.addEventListener?.("click", handleClick));
  sync();

  return {
    handleBeforeInstallPrompt,
    handleInstalled,
    handleClick,
    isActionable: () => Boolean(deferredPrompt) && !installed,
    dispose: () => {
      windowRef?.removeEventListener?.("beforeinstallprompt", handleBeforeInstallPrompt);
      windowRef?.removeEventListener?.("appinstalled", handleInstalled);
      installButtons.forEach((button) => button.removeEventListener?.("click", handleClick));
    }
  };
}
