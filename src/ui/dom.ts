// Small, stateless DOM/browser helpers shared across every feature.
// Nothing here knows about maps, routes, GPS, or any other Trailhead concept.

export const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

/** An inline `<svg><use>` referencing one of index.html's icon symbols. */
export const svgUse = (id: string) => `<svg viewBox="0 0 24 24"><use href="#${id}"/></svg>`;

let toastTimer: number | undefined;
export function toast(msg: string, ms = 3000): void {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  window.clearTimeout(toastTimer);
  if (ms > 0) toastTimer = window.setTimeout(() => el.classList.add('hidden'), ms);
}
export function hideToast(): void {
  $('toast').classList.add('hidden');
}

export function downloadFile(name: string, content: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
