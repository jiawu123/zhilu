/** Pair the supplied 知 with a 路 outline whose weight, terminals, and counters follow the same visual style. */
export function Brand() {
  return <span className="zhilu-brand" role="img" aria-label="知路">
    <span className="zhilu-brand-zhi" aria-hidden="true" />
    <img className="zhilu-brand-lu" src="/zhilu-lu.svg" alt="" aria-hidden="true" draggable={false} />
  </span>;
}
