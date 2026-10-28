/**
 * The capture and stitch, run inside the page.
 *
 * The script is loaded as a string and evaluated in the isolated world, where
 * the extension APIs live. It is kept in its own file because it is long and
 * because a nested template literal is easy to get wrong.
 */

/**
 * The expression that runs the capture and returns the stitched image.
 *
 * @param {string} pagePrefix The start of the URL of the page to capture.
 * @returns {string}
 */
export function captureExpression(pagePrefix) {
  return `(async () => {
  const tabs = await chrome.tabs.query({});
  const tab = tabs.find((entry) => entry.url && entry.url.startsWith(${pagePrefix}));
  if (!tab) throw new Error('the test tab was not found');

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['/content/capture.js'],
  });

  // The content script answers the capture request. It has to be reached
  // through the tab, because a runtime message does not go to content
  // scripts.
  const result = await chrome.tabs.sendMessage(tab.id, {
    type: 'LOOKATIFY_CAPTURE_START',
    viewportOnly: false,
    debug: false,
  });
  if (!result || !result.ok) {
    return JSON.stringify({ error: (result && result.error) || 'the capture failed' });
  }

  // The frames are stitched in the page, where the stitch helpers can be
  // imported with the extension's own URL.
  const stitched = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: async (captureResult) => {
      try {
        const stitch = await import(chrome.runtime.getURL('lib/stitch.js'));

        const size = stitch.computeCanvasSize({
          width: captureResult.width,
          height: captureResult.height,
          devicePixelRatio: captureResult.devicePixelRatio,
          maxHeight: 16000,
        });
        const layout = stitch.sliceLayout(captureResult.slices, {
          canvasHeight: size.height,
          devicePixelRatio: captureResult.devicePixelRatio,
        });

        const canvas = new OffscreenCanvas(size.width, size.height);
        const context = canvas.getContext('2d');

        for (const placement of layout) {
          const slice = captureResult.slices[placement.index];
          const response = await fetch(slice.dataUrl);
          const bitmap = await createImageBitmap(await response.blob());
          const available = Math.max(1, Math.min(placement.drawHeight, bitmap.height));
          context.drawImage(
            bitmap,
            0, 0, bitmap.width, available,
            0, placement.offsetY, bitmap.width, available,
          );
          bitmap.close();
        }

        const blob = await canvas.convertToBlob({ type: 'image/png' });
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = '';
        const chunk = 0x8000;
        for (let index = 0; index < bytes.length; index += chunk) {
          binary += String.fromCharCode.apply(
            null,
            bytes.subarray(index, index + chunk),
          );
        }

        return {
          image: btoa(binary),
          width: size.width,
          height: size.height,
          pageHeight: captureResult.pageHeight,
          viewportHeight: captureResult.viewportHeight,
          devicePixelRatio: captureResult.devicePixelRatio,
          sliceCount: captureResult.slices.length,
          slices: captureResult.slices.map((slice) => {
            const placement = layout.find((entry) => entry.index === slice.index);
            return {
              index: slice.index,
              scrollY: slice.scrollY,
              offsetY: placement ? placement.offsetY : null,
              drawHeight: placement ? placement.drawHeight : null,
            };
          }),
          warnings: captureResult.warnings,
        };
      } catch (error) {
        return { error: error?.message || String(error) };
      }
    },
    args: [result],
  });

  return JSON.stringify(stitched[0] && stitched[0].result
    ? stitched[0].result
    : { error: 'no result from the page' });
})()`;
}
