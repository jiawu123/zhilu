export interface SurfaceOrigin { x: number; y: number }
let activation: (SurfaceOrigin & { target: Element; at: number }) | null = null;
export function rememberSurfaceOrigin(event: MouseEvent) {
  activation = event.detail > 0 && event.target instanceof Element
    ? { x: event.clientX, y: event.clientY, target: event.target, at: performance.now() } : null;
}
export function surfaceOrigin(trigger: HTMLElement | null): SurfaceOrigin | null {
  if (activation && trigger?.contains(activation.target) && performance.now() - activation.at < 1000) return { x: activation.x, y: activation.y };
  const box = trigger?.getBoundingClientRect();
  return box ? { x: box.left + box.width / 2, y: box.top + box.height / 2 } : null;
}
/** A tapered fold between the panel and the point that opened it. */
export function drawerMotion(panel: HTMLElement, origin: SurfaceOrigin | null, opening: boolean): Animation | null {
  if (!panel.animate || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return null;
  const box = panel.getBoundingClientRect();
  const x = origin?.x ?? box.left + box.width / 2;
  const y = origin?.y ?? box.top + box.height / 2;
  const dx = x - (box.left + box.width / 2), dy = y - (box.top + box.height / 2);
  const frames: Keyframe[] = [
    { opacity: 0, transform: `translate(${dx}px,${dy}px) scale(.045,.015)`, clipPath: "polygon(28% 0,72% 0,88% 55%,100% 100%,0 100%,12% 55%)", offset: 0 },
    { opacity: .7, transform: `translate(${dx * .25}px,${dy * .25}px) scale(.55,.5)`, clipPath: "polygon(0 0,100% 0,86% 58%,57% 100%,43% 100%,14% 58%)", offset: .4 },
    { opacity: 1, transform: "translate(0,0) scale(1,1)", clipPath: "polygon(0 0,100% 0,100% 58%,100% 100%,0 100%,0 58%)", offset: 1 },
  ];
  return panel.animate(opening ? frames : [...frames].reverse().map(frame => ({ ...frame, offset: 1 - (frame.offset as number) })), {
    duration: opening ? 460 : 380, easing: "cubic-bezier(.2,.7,.2,1)", fill: "both",
  });
}
