/** A fixed-duration, cancellable viewport transition; distance never changes its timing. */
export function animateScrollLeft(element: HTMLElement, target: number, onComplete: () => void): () => void {
  const start = element.scrollLeft;
  const startedAt = performance.now();
  let frame = 0;
  let cancelled = false;
  const tick = (now: number) => {
    if (cancelled) return;
    const progress = Math.min(1, Math.max(0, (now - startedAt) / 300));
    const eased = 1 - (1 - progress) ** 3;
    element.scrollLeft = start + (target - start) * eased;
    if (progress < 1) frame = requestAnimationFrame(tick);
    else onComplete();
  };
  frame = requestAnimationFrame(tick);
  return () => { cancelled = true; cancelAnimationFrame(frame); };
}
