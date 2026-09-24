const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  "iframe",
  "[tabindex]:not([tabindex=\"-1\"])"
].join(",");

export function getFocusableElements(container) {
  if (!container?.querySelectorAll) return [];
  return [...container.querySelectorAll(FOCUSABLE_SELECTOR)].filter((element) => {
    if (element.hidden || element.disabled) return false;
    return !element.closest?.("[hidden]");
  });
}

export function containFocus(container, event, activeElement = container?.ownerDocument?.activeElement) {
  if (event?.key !== "Tab") return false;
  const focusable = getFocusableElements(container);
  if (!focusable.length) {
    event.preventDefault();
    container?.focus?.();
    return true;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const focusIsOutside = !container?.contains?.(activeElement);
  if ((event.shiftKey && (activeElement === first || focusIsOutside)) || (!event.shiftKey && (activeElement === last || focusIsOutside))) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
    return true;
  }
  return false;
}
