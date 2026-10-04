/** Tiny element builder. Text is always set via textContent - page and model text is untrusted. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { className?: string; text?: string; attrs?: Record<string, string>; onClick?: () => void } = {},
  ...children: (Node | null)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.className) el.className = props.className;
  if (props.text !== undefined) el.textContent = props.text;
  for (const [name, value] of Object.entries(props.attrs ?? {})) el.setAttribute(name, value);
  if (props.onClick) el.addEventListener('click', props.onClick);
  for (const c of children) if (c) el.append(c);
  return el;
}

/** A favicon, or an empty box of the same size so titles stay aligned. Decorative either way. */
export function favicon(url: string | undefined): HTMLElement {
  if (!url) return h('span', { className: 'icon' });
  const img = h('img', { attrs: { alt: '' } });
  img.src = url;
  return img;
}

/** Saves text as a file through a temporary link. */
export function download(filename: string, type: string, text: string) {
  const a = h('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
