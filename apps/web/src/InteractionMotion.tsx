import { useEffect } from "react";
import { rememberSurfaceOrigin } from "./surface-motion";

/** Presentation-only feedback for native controls, including keyboard activation. */
export function InteractionMotion() {
  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const running = new Map<HTMLElement, Animation>();
    const feedback = (event: Event) => {
      if (event.type === "click" && event instanceof MouseEvent) rememberSurfaceOrigin(event);
      if (reduced.matches || !(event.target instanceof Element)) return;
      const target = event.target.closest<HTMLElement>("button, a[href], summary, input, select, textarea, [role=button], [tabindex]");
      if (!target || target.matches(":disabled, [aria-disabled=true]") || !target.animate) return;
      if (event instanceof KeyboardEvent && !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
      running.get(target)?.cancel();
      const field = target.matches("textarea, select, input:not([type=checkbox]):not([type=radio])");
      const animation = target.animate(field
        ? [{ boxShadow: "0 0 0 4px #1772f51f" }, { boxShadow: "0 0 0 0px #1772f500" }]
        : [{ scale: "0.97", filter: "brightness(.96)" }, { scale: "1", filter: "brightness(1)" }],
      { duration: field ? 260 : 220, easing: "cubic-bezier(.2,.8,.2,1)" });
      running.set(target, animation);
      const forget = () => { if (running.get(target) === animation) running.delete(target); };
      animation.onfinish = forget; animation.oncancel = forget;
    };
    const stop = () => { if (reduced.matches) { for (const animation of running.values()) animation.cancel(); running.clear(); } };
    for (const event of ["click", "change", "keydown"]) document.addEventListener(event, feedback, true);
    reduced.addEventListener("change", stop);
    return () => {
      for (const event of ["click", "change", "keydown"]) document.removeEventListener(event, feedback, true);
      reduced.removeEventListener("change", stop);
      for (const animation of running.values()) animation.cancel();
    };
  }, []);
  return null;
}
