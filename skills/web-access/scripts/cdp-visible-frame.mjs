// Fixed same-origin, visible-frame adapter. No arbitrary script or CDP access.
export function validateFrameSelector(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^iframe(?:#[A-Za-z_][A-Za-z0-9_-]{0,79})?$/.test(value)) {
    throw new Error('frameSelector must be iframe or iframe#public-id');
  }
  return value;
}

function visibleFrame(selector) {
  const nodes = document.querySelectorAll(selector);
  if (nodes.length > 32) return { error: 'frame_limit' };
  let frame;
  for (const node of nodes) {
    if (node.tagName !== 'IFRAME') continue;
    let visible = true, current = node, depth = 0;
    while (current) {
      if (++depth > 128 || current.hidden || current.isContentEditable || current.getAttribute('aria-hidden') === 'true') { visible = false; break; }
      const css = getComputedStyle(current);
      if (css.display === 'none' || css.visibility === 'hidden' || css.visibility === 'collapse' || Number(css.opacity || 1) <= 0) { visible = false; break; }
      if ((css.transform && css.transform !== 'none') || (css.perspective && css.perspective !== 'none') || (css.zoom && css.zoom !== 'normal' && Number(css.zoom) !== 1)) { visible = false; break; }
      current = current.parentElement;
    }
    const r = node.getBoundingClientRect();
    if (!visible || r.width <= 0 || r.height <= 0 || r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) continue;
    const x = (Math.max(0, r.left) + Math.min(innerWidth, r.right)) / 2;
    const y = (Math.max(0, r.top) + Math.min(innerHeight, r.bottom)) / 2;
    if (document.elementFromPoint(x, y) !== node) continue;
    if (frame) return { error: 'frame_ambiguous' };
    frame = node;
  }
  if (!frame) return { error: 'frame_not_visible' };
  try {
    const win = frame.contentWindow;
    const doc = frame.contentDocument;
    const url = new URL(doc?.URL || '');
    if (!win || !doc || !['https:', 'http:'].includes(url.protocol) || url.origin !== location.origin || url.username || url.password) return { error: 'frame_not_same_origin' };
    if (/(?:^|\/)(?:login|signin|oauth|auth|password|account|settings|checkout|payment)(?:\/|$)/i.test(url.pathname)) return { error: 'frame_sensitive_route' };
    return { frame, win, doc };
  } catch { return { error: 'frame_not_same_origin' }; }
}

export function wrapVisibleFrame(original, click = false) {
  return `function(spec, activate) {
    if (!spec || !spec.frameSelector) return (${original})(spec, activate);
    const resolved = (${visibleFrame.toString()})(spec.frameSelector);
    if (resolved.error) return { found: false, error: resolved.error };
    const local = { ...spec }; delete local.frameSelector;
    const w = resolved.win;
    const invoke = (doActivate) => ((document, Element, Node, NodeFilter, getComputedStyle, innerWidth, innerHeight, location) => (${original})(local, doActivate))(
      resolved.doc, w.Element, w.Node, w.NodeFilter, w.getComputedStyle.bind(w), w.innerWidth, w.innerHeight, w.location);
    if (!${click}) return invoke(false);
    const point = invoke(false);
    if (!point || point.error) return point;
    const rect = resolved.frame.getBoundingClientRect();
    const x = rect.left + resolved.frame.clientLeft + point.x;
    const y = rect.top + resolved.frame.clientTop + point.y;
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight || document.elementFromPoint(x,y) !== resolved.frame) return { error: 'frame_occluded' };
    if (activate) {
      const result = invoke(true);
      if (!result || result.error) return result;
      return { ...result, x, y };
    }
    return { ...point, x, y };
  }`;
}
