// 内联 SVG 图标。全部使用 currentColor，跟随主题与按钮状态。

const wrap = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;

export const icons = {
  check: wrap('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  plus: wrap('<path d="M12 5.5v13M5.5 12h13"/>'),
  close: wrap('<path d="M6 6l12 12M18 6L6 18"/>'),
  pencil: wrap(
    '<path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3z"/><path d="M14.5 6.5l3 3"/>'
  ),
  trash: wrap(
    '<path d="M4 7h16"/><path d="M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M10.5 11v6M13.5 11v6"/>'
  ),
  image: wrap(
    '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="M4.5 17l4.7-4.5a1.8 1.8 0 0 1 2.5 0l5.3 5"/>'
  ),
  chevronUp: wrap('<path d="M6 14.5l6-6 6 6"/>'),
  chevronDown: wrap('<path d="M6 9.5l6 6 6-6"/>'),
  chevronLeft: wrap('<path d="M14.5 6l-6 6 6 6"/>'),
  chevronRight: wrap('<path d="M9.5 6l6 6-6 6"/>'),
  panel: wrap('<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M10 4.5v15"/>'),
  list: wrap('<path d="M4 6.5h16M4 12h16M4 17.5h16"/>'),
  sun: wrap(
    '<circle cx="12" cy="12" r="4"/><path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4L17 7M7 17l-1.6 1.6"/>'
  ),
  moon: wrap('<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/>'),
  monitor: wrap(
    '<rect x="3" y="4.5" width="18" height="12" rx="2.5"/><path d="M9 20h6M12 16.5V20"/>'
  ),
  folder: wrap(
    '<path d="M3.5 7.5a2 2 0 0 1 2-2h3.2l1.8 2.2h8a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>'
  ),
  pin: wrap(
    '<path d="M9.5 3.5h5l-.7 5.2 3.2 3.2-4.6.6-3.4-3.4.7-5.6z"/><path d="M11 12.5L5 20"/>'
  ),
  power: wrap('<path d="M12 3.5v8"/><path d="M7.2 6.6a7 7 0 1 0 9.6 0"/>'),
  settings: wrap(
    '<circle cx="12" cy="12" r="2.9"/><path d="M19.1 14.4a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5v.3a2 2 0 1 1-4 0v-.2a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.2a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3h.1a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.2a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8v.1a1.6 1.6 0 0 0 1.5 1h.3a2 2 0 1 1 0 4h-.2a1.6 1.6 0 0 0-1.5 1z"/>'
  ),
};
