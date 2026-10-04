export function isStandaloneDisplay(windowRef = globalThis.window) {
  return Boolean(windowRef?.matchMedia?.("(display-mode: standalone)")?.matches || windowRef?.navigator?.standalone === true);
}

export function isIOSDevice(windowRef = globalThis.window) {
  const navigatorRef = windowRef?.navigator || {};
  const userAgent = typeof navigatorRef.userAgent === "string" ? navigatorRef.userAgent : "";
  const platform = typeof navigatorRef.platform === "string" ? navigatorRef.platform : "";
  return /iPad|iPhone|iPod/i.test(userAgent) || (platform === "MacIntel" && Number(navigatorRef.maxTouchPoints) > 1);
}

export function createInstallController({ windowRef = globalThis.window, buttons = [], onStatus = () => {}, logger = console } = {}) {
  const installButtons = Array.from(buttons || []).filter(Boolean);
  let deferredPrompt = null;
  let installed = isStandaloneDisplay(windowRef);
  const manualInstall = isIOSDevice(windowRef);

  const sync = () => {
    const actionable = !installed && (Boolean(deferredPrompt) || manualInstall);
    installButtons.forEach((button) => {
      button.hidden = !actionable;
      button.disabled = !actionable;
      if (manualInstall && !deferredPrompt) {
        button.textContent = "Add to Home Screen";
        button.setAttribute?.("aria-label", "Learn how to add KantaCue to the home screen");
        button.title = "Add KantaCue to the home screen";
      } else {
        button.textContent = "Install KantaCue";
        button.setAttribute?.("aria-label", "Install KantaCue as an app");
        button.title = "Install KantaCue as an app";
      }
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
    onStatus("KantaCue is installed on this device.");
  };

  const handleClick = async () => {
    if (installed) return { status: "unavailable" };
    if (!deferredPrompt && manualInstall) {
      onStatus("On iPhone or iPad, tap Share, then choose Add to Home Screen.");
      return { status: "manual" };
    }
    if (!deferredPrompt) return { status: "unavailable" };
    const promptEvent = deferredPrompt;
    deferredPrompt = null;
    sync();
    try {
      await promptEvent.prompt();
      const choice = await promptEvent.userChoice;
      if (choice?.outcome === "accepted") onStatus("KantaCue was added to your apps.");
      else onStatus("Install dismissed. You can install KantaCue later.");
      return { status: choice?.outcome === "accepted" ? "accepted" : "dismissed" };
    } catch (error) {
      logger.info?.("[KantaCue] Install prompt was unavailable.", error);
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
    isActionable: () => !installed && (Boolean(deferredPrompt) || manualInstall),
    isManualInstall: () => manualInstall && !installed,
    dispose: () => {
      windowRef?.removeEventListener?.("beforeinstallprompt", handleBeforeInstallPrompt);
      windowRef?.removeEventListener?.("appinstalled", handleInstalled);
      installButtons.forEach((button) => button.removeEventListener?.("click", handleClick));
    }
  };
}
