/**
 * LookAtify content script — measures the page and captures every slice.
 *
 * The script is injected on demand by the service worker. It drives the
 * scroll-and-capture loop and always restores the page to its original state.
 *
 * Three things go wrong on a real page, and each has its own answer here:
 *
 *   1. the page does not always scroll to the position that was asked for.
 *      A smooth-scrolling page glides there, and a page that is shorter than
 *      expected clamps at the bottom. The capture therefore waits for the
 *      scroll to settle and then uses the position the page really reached.
 *   2. fixed elements — chat widgets, review badges, cookie bars — sit on top
 *      of the content in every frame. They are hidden for the whole capture,
 *      and a MutationObserver catches the ones that are injected later.
 *   3. carousels, marquees and reveal-on-scroll sections keep moving while
 *      the capture runs, so the same area looks different in every slice.
 *      Animations are switched off, and the content is given time to load.
 *
 * The stitching helpers are loaded with a dynamic import: a content script
 * runs as a classic script, so a static `import` statement would be a syntax
 * error. The module must therefore be listed in `web_accessible_resources`.
 */

/** Load the pure stitching helpers. */
async function loadStitchHelpers() {
  const module = await import(chrome.runtime.getURL("lib/stitch.js"));
  return {
    findStickyElements: module.findStickyElements,
    hideStickyElements: module.hideStickyElements,
    planSlices: module.planSlices,
    restoreStickyElements: module.restoreStickyElements,
    captureStyleText: module.captureStyleText,
    capturedHeightFor: module.capturedHeightFor,
    HIDDEN_ATTRIBUTE: module.HIDDEN_ATTRIBUTE,
    CAPTURE_STYLE_ID: module.CAPTURE_STYLE_ID,
  };
}

/** Minimum delay between two visible-tab captures (Chrome allows ~2/s). */
const CAPTURE_THROTTLE_MS = 520;

/** How long to wait for layout and lazy content to settle after a scroll. */
const SETTLE_MS = 220;

/** How long to wait for the scroll position to stop changing. */
const SCROLL_SETTLE_TIMEOUT_MS = 1200;

/** How long to wait for the images in view to finish loading. */
const IMAGE_SETTLE_TIMEOUT_MS = 2500;

/**
 * Wait for a number of milliseconds.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait until the document height stops changing.
 *
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
async function waitForStableHeight(timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  let previous = -1;

  while (Date.now() < deadline) {
    const current = document.documentElement.scrollHeight;
    if (current === previous) return;
    previous = current;
    await delay(120);
  }
}

/**
 * Scroll to a position and wait until the page is really there.
 *
 * The requested position is not always the one the page ends up at: a
 * smooth-scrolling page glides there over several frames, and a page that is
 * shorter than the plan assumed clamps at its maximum. The real position is
 * what the stitch has to use, otherwise the slices are placed at the wrong
 * place and the content is duplicated or cut off.
 *
 * @param {number} targetY The wanted scroll position, in CSS pixels.
 * @returns {Promise<number>} The scroll position the page reached.
 */
async function scrollToPosition(targetY) {
  window.scrollTo(0, targetY);

  const deadline = Date.now() + SCROLL_SETTLE_TIMEOUT_MS;
  let previous = -1;

  while (Date.now() < deadline) {
    await delay(50);
    const current = window.scrollY;
    if (current === previous) return current;
    previous = current;
  }

  return window.scrollY;
}

/**
 * Wait for the images that are in view to finish loading.
 *
 * A lazy image that is still loading shows as an empty box in the capture,
 * and the page grows as the images arrive, which shifts every later slice.
 *
 * @returns {Promise<void>}
 */
async function waitForImagesInView() {
  // The images that are in view and have not arrived yet.
  const pending = Array.from(document.images).filter((image) => {
    if (image.complete) return false;
    const rect = image.getBoundingClientRect();
    return rect.bottom > -200 && rect.top < window.innerHeight + 200;
  });

  if (pending.length === 0) return;

  // Every image gets a deadline of its own, so one slow image cannot hold
  // the whole capture up for long.
  await Promise.all(
    pending.map(
      (image) =>
        new Promise((resolve) => {
          const timer = setTimeout(resolve, IMAGE_SETTLE_TIMEOUT_MS);
          const finish = () => {
            clearTimeout(timer);
            resolve();
          };
          image.addEventListener("load", finish, { once: true });
          image.addEventListener("error", finish, { once: true });
        }),
    ),
  );
}

/**
 * Install the style that hides the marked elements and stops all movement.
 *
 * @param {string} styleText
 * @param {string} styleId
 * @returns {HTMLStyleElement}
 */
function installCaptureStyle(styleText, styleId) {
  const existing = document.getElementById(styleId);
  if (existing) existing.remove();

  const style = document.createElement("style");
  style.id = styleId;
  style.textContent = styleText;
  (document.head || document.documentElement).appendChild(style);
  return style;
}

/**
 * Remove the capture style.
 *
 * @param {HTMLStyleElement|null} style
 * @returns {void}
 */
function removeCaptureStyle(style) {
  style?.remove();
}

/**
 * Watch for elements that appear while the capture runs.
 *
 * Chat widgets and review badges are often injected a second after the page
 * has loaded. Anything that is added to the page and is fixed or sticky is
 * hidden straight away, so it cannot show up in the later slices.
 *
 * @param {string} hiddenAttribute
 * @returns {MutationObserver}
 */
function watchForNewOverlays(hiddenAttribute) {
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;

        const element = /** @type {Element} */ (node);
        if (element.hasAttribute(hiddenAttribute)) continue;

        const style = window.getComputedStyle(element);
        if (style.position !== "fixed" && style.position !== "sticky") continue;

        element.setAttribute(hiddenAttribute, "");
      }
    }
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });
  return observer;
}

/**
 * Hide every fixed or sticky element in the document.
 *
 * @param {string} hiddenAttribute
 * @returns {void}
 */
function hideAllOverlays(hiddenAttribute) {
  for (const element of document.querySelectorAll("*")) {
    const style = window.getComputedStyle(element);
    if (style.position !== "fixed" && style.position !== "sticky") continue;
    element.setAttribute(hiddenAttribute, "");
  }
}

/**
 * Capture the visible viewport.
 *
 * @param {number} index Slice index.
 * @param {number} scrollY Current scroll position.
 * @returns {Promise<{index: number, scrollY: number, dataUrl: string}>}
 */
async function captureFrame(index, scrollY) {
  const response = await chrome.runtime.sendMessage({
    type: "LOOKATIFY_CAPTURE_FRAME",
    index,
    scrollY,
  });

  if (!response || !response.ok) {
    throw new Error((response && response.error) || "The browser refused to capture the tab.");
  }

  return { index, scrollY, dataUrl: response.dataUrl };
}

/**
 * Run the full-page capture.
 *
 * @param {{viewportOnly: boolean, debug: boolean}} options
 * @returns {Promise<Object>} The capture result.
 */
async function capturePage({ viewportOnly, debug = false }) {
  const {
    findStickyElements,
    hideStickyElements,
    planSlices,
    restoreStickyElements,
    captureStyleText,
    sliceLayout,
    capturedHeightFor,
    HIDDEN_ATTRIBUTE,
    CAPTURE_STYLE_ID,
  } = await loadStitchHelpers();

  const warnings = [];
  const originalScrollY = window.scrollY;
  const originalStyles = [];

  const viewportHeight = window.innerHeight;
  const viewportWidth = window.innerWidth;
  const devicePixelRatio = window.devicePixelRatio || 1;

  if (document.querySelector('input[type="password"]')) {
    warnings.push(
      "This page has a password field. Make sure it does not contain sensitive information before analysing.",
    );
  }

  const scrollable = document.scrollingElement || document.documentElement;
  const hasInnerScroll = Array.from(document.querySelectorAll("*")).some((element) => {
    if (element === scrollable || element === document.body) return false;
    const style = window.getComputedStyle(element);
    if (!/(auto|scroll)/.test(style.overflowY)) return false;
    return element.scrollHeight > element.clientHeight + 4;
  });
  if (hasInnerScroll) {
    warnings.push(
      "This page scrolls inside an inner container; only the outer page was captured.",
    );
  }

  const pageHeight = Math.max(
    document.documentElement.scrollHeight,
    document.body ? document.body.scrollHeight : 0,
  );

  const stored = await chrome.storage.local.get("lookatify_settings");
  const maxHeight = stored.lookatify_settings?.maxCaptureHeight || 16000;

  const plan = planSlices({
    scrollHeight: pageHeight,
    viewportHeight,
    devicePixelRatio,
    maxHeight,
  });

  if (viewportOnly) {
    plan.slices = plan.slices.slice(0, 1);
    plan.totalHeightCss = viewportHeight;
    plan.totalHeightDevice = Math.round(viewportHeight * devicePixelRatio);
  }

  if (plan.truncated) {
    warnings.push(
      `The page is ${pageHeight}px tall, so only the first ${Math.round(plan.totalHeightCss)}px were captured.`,
    );
  }

  const slices = [];
  let stickyElements = [];
  let captureStyle = null;
  let overlayWatcher = null;

  // The page can grow while the capture runs: a lazy image arrives, a
  // section reveals itself, a banner pushes the footer down. The height is
  // therefore measured again after every scroll, and the plan is extended
  // when there is more page left than the plan expected.
  let lastMeasuredHeight = pageHeight;
  let nextSliceIndex = 0;

  try {
    // The style stops the animations and hides the marked elements, so it
    // has to be in place before the first frame.
    captureStyle = installCaptureStyle(captureStyleText(), CAPTURE_STYLE_ID);

    // Fixed elements repeat in every slice, so they are hidden from the very
    // first frame. Sticky elements are part of the layout, so they are kept
    // in the first frame and hidden from the second one onwards.
    stickyElements = findStickyElements(document);
    originalStyles.push(...stickyElements);
    for (const entry of stickyElements) {
      if (entry.position === "fixed") hideStickyElements([entry]);
    }

    overlayWatcher = watchForNewOverlays(HIDDEN_ATTRIBUTE);

    while (nextSliceIndex < plan.slices.length) {
      const slice = plan.slices[nextSliceIndex];
      const reachedY = await scrollToPosition(slice.scrollY);
      await delay(SETTLE_MS);
      await waitForStableHeight();
      await waitForImagesInView();

      // The page may have grown while the slice was being prepared.
      const currentHeight = Math.max(
        document.documentElement.scrollHeight,
        document.body ? document.body.scrollHeight : 0,
      );
      if (currentHeight > lastMeasuredHeight) {
        lastMeasuredHeight = currentHeight;
        const grown = planSlices({
          scrollHeight: currentHeight,
          viewportHeight,
          devicePixelRatio,
          maxHeight,
        });
        // The plan is rebuilt from the top, so the slices that were already
        // taken keep their place.
        plan.slices = grown.slices;
        plan.totalHeightCss = grown.totalHeightCss;
        plan.truncated = grown.truncated;
      }

      // Repeating headers are only hidden after the first frame, so the top
      // of the page still shows the real header.
      if (slice.index === 0) {
        for (const entry of stickyElements) {
          if (entry.position === "sticky") hideStickyElements([entry]);
        }
      } else {
        hideAllOverlays(HIDDEN_ATTRIBUTE);
      }

      const frame = await captureFrame(slice.index, reachedY);
      slices.push(frame);

      nextSliceIndex += 1;
      await delay(CAPTURE_THROTTLE_MS);
    }
  } finally {
    overlayWatcher?.disconnect();
    removeCaptureStyle(captureStyle);
    restoreStickyElements(originalStyles);
    window.scrollTo(0, originalScrollY);
  }

  // The canvas is only as tall as the content that was really captured.
  const lastScrollY = slices.length > 0 ? slices[slices.length - 1].scrollY : 0;
  const capturedHeight = viewportOnly
    ? viewportHeight
    : capturedHeightFor({
        lastScrollY,
        viewportHeight,
        pageHeight,
        maxHeight,
      });

  return {
    ok: true,
    slices,
    width: viewportWidth,
    height: capturedHeight,
    viewportHeight,
    devicePixelRatio,
    pageHeight,
    truncated: plan.truncated,
    viewportOnly: Boolean(viewportOnly),
    debug: Boolean(debug),
    warnings,
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return undefined;

  // The service worker pings to find out whether the script is already there.
  if (message.type === "LOOKATIFY_PING") {
    sendResponse({ ok: true });
    return undefined;
  }

  if (message.type !== "LOOKATIFY_CAPTURE_START") return undefined;

  capturePage({
    viewportOnly: Boolean(message.viewportOnly),
    debug: Boolean(message.debug),
  })
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({ ok: false, error: error.message || "The capture failed." }));

  // Keep the message channel open for the async response.
  return true;
});
