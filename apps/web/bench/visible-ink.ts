// Installed in the measured page before the clock starts. tldraw can mount SVG
// definitions and overscanned shapes before a stroke overlaps the canvas.
export function installVisibleInkProbe() {
  window.benchHasVisibleInk = () => {
    const canvas = document.querySelector(".tl-canvas");
    if (!canvas) return false;
    const view = canvas.getBoundingClientRect();
    const paths = canvas.querySelectorAll(
      '.tl-shape[data-shape-type="draw"] svg :is(path,polyline)',
    );
    for (const path of paths) {
      if (path.closest("defs")) continue;
      const box = path.getBoundingClientRect();
      if (
        box.width > 0 &&
        box.height > 0 &&
        box.right > Math.max(0, view.left) &&
        box.left < Math.min(innerWidth, view.right) &&
        box.bottom > Math.max(0, view.top) &&
        box.top < Math.min(innerHeight, view.bottom) &&
        path.checkVisibility({
          opacityProperty: true,
          visibilityProperty: true,
        })
      )
        return true;
    }
    return false;
  };
}

declare global {
  interface Window {
    benchHasVisibleInk: () => boolean;
  }
}
