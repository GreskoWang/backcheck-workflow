// Fixed, read-only visible-DOM research recipes. No caller JavaScript, selectors,
// browser storage, application globals, fetch, navigation, or synthetic clicks.
export const RESEARCH_DOM_RECIPES = Object.freeze([
  'weibo-feed', 'bilibili-dynamic', 'bilibili-video',
  'douyin-posts', 'xiaohongshu-notes', 'generic-posts',
]);

export function assertResearchRecipe(recipe) {
  if (typeof recipe !== 'string' || !RESEARCH_DOM_RECIPES.includes(recipe)) {
    const error = new Error('Unknown fixed visible-DOM research recipe');
    error.code = 'invalid_research_recipe';
    throw error;
  }
  return recipe;
}

export function buildResearchReadFunctionDeclaration(recipe) {
  assertResearchRecipe(recipe);
  return `function() { return (${readResearchVisibleDom.toString()})(${JSON.stringify(recipe)}); }`;
}

function readResearchVisibleDom(recipe) {
  // Fixed X photo route: bounded public image state, hot-loadable without
  // restarting the shared broker or changing any lease/recovery state.
  const photoPage = new URL(document.location.href);
  if (recipe === 'generic-posts' && /^(?:www\.)?x\.com$/i.test(photoPage.hostname)
      && /^\/[A-Za-z0-9_]{1,15}\/status\/\d{15,22}\/photo\/[1-4]\/?$/.test(photoPage.pathname)) {
    // The photo canvas can be a sibling of the dialog, so inspect the exact
    // photo route's viewport, still restricted to public media source URLs.
    const nodes = document.querySelectorAll('img,div');
    const images = [];
    const observed = {candidates:nodes.length, in_viewport:0, shown:0, background:0, public_source:0};
    const seen = new Set();
    for (const image of Array.from(nodes).slice(0, 2000)) {
      const rect = image.getBoundingClientRect();
      if (!(rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight)) continue;
      observed.in_viewport++;
      let shown = true, depth = 0;
      for (let node = image; node instanceof Element; node = node.parentElement) {
        if (++depth > 256) { shown = false; break; }
        const style = getComputedStyle(node);
        if (node.hidden || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) { shown = false; break; }
      }
      if (!shown) continue;
      observed.shown++;
      let src, backing = image, representation = 'img';
      if (image.tagName !== 'IMG') {
        // X may paint a public CSS background and keep its matching IMG
        // transparent. Only the already-visible background source is examined.
        const background = getComputedStyle(image).backgroundImage || '';
        if (background && background !== 'none') observed.background++;
        const match = /^url\(["']?(https:\/\/[^"')]+)["']?\)$/.exec(background);
        if (!match) continue;
        try { src = new URL(match[1], document.baseURI); } catch { continue; }
        representation = 'visible_css_background';
        const peers = image.parentElement?.querySelectorAll('img') || [];
        backing = Array.from(peers).slice(0, 8).find(candidate => {
          try { return new URL(candidate.currentSrc || candidate.getAttribute('src'), document.baseURI).href === src.href; } catch { return false; }
        });
      } else {
        try { src = new URL(image.currentSrc || image.getAttribute('src'), document.baseURI); } catch { continue; }
      }
      if (src.protocol !== 'https:' || src.hostname !== 'pbs.twimg.com' || !src.pathname.startsWith('/media/') || src.username || src.password) continue;
      observed.public_source++;
      if (seen.has(src.href)) continue;
      seen.add(src.href);
      images.push({src:src.href, representation, imageState:{complete:Boolean(backing?.complete), naturalWidth:Number(backing?.naturalWidth)||0,
        naturalHeight:Number(backing?.naturalHeight)||0, width:rect.width, height:rect.height, inViewport:true, inPhotoPage:true}});
    }
    return {schema_version:1, recipe, items:[], page_state:{url:photoPage.href, completion:'visible_dom_only', historical_completion_proven:false,
      photo_readiness:{version:1, items:images, observed, truncated:nodes.length > 2000, visual_review_required:true}}};
  }
  const configs = {
    'weibo-feed': {
      hosts: ['weibo.com', 'www.weibo.com', 's.weibo.com', 'm.weibo.cn'],
      cards: ['article,[class*="Feed_wrap"],.WB_feed_type', '.card-wrap,.card9'],
      bodies: ['[class*="detail_wbtext"],.WB_text,.weibo-text', '.content .text'],
      reposts: '[class*="Feed_retweet"],.WB_feed_expand,.retweet,[class*="retweet"]',
      dates: '[class*="head-info_time"],.WB_from a,.time,time',
      authors: '[class*="head_name"],.WB_info a,.m-text-cut,.name',
      kind: 'post',
    },
    'bilibili-dynamic': {
      hosts: ['bilibili.com', 'www.bilibili.com', 'space.bilibili.com', 't.bilibili.com'],
      cards: ['.bili-dyn-list__item,.bili-dyn-item', '.dyn-card,[class*="dynamic-card"]'],
      bodies: ['.bili-dyn-content__orig,.bili-dyn-content__orig__desc,.bili-rich-text,.dyn-card-text,.opus-module-content'],
      // Live space search uses content__orig for both own and quoted content.
      // Only its reference variant identifies the quoted card.
      reposts: '.bili-dyn-content__orig.reference,.bili-dyn-item__orig,.dyn-orig,[class*="repost-card"]',
      dates: '.bili-dyn-time,.dyn-card-time,time',
      authors: '.bili-dyn-title__text,.dyn-card-user-name,.bili-dyn-content__orig__author span',
      kind: 'dynamic',
    },
    'bilibili-video': {
      hosts: ['bilibili.com', 'www.bilibili.com', 'space.bilibili.com'],
      cards: ['.bili-video-card,.small-item,.video-card', 'li'],
      bodies: ['.bili-video-card__info--tit,.title,[title]'],
      reposts: '', dates: '.bili-video-card__info--date,.time,.date,time',
      authors: '.bili-video-card__info--author,.up-name', kind: 'video_listing',
    },
    'douyin-posts': {
      hosts: ['douyin.com', 'www.douyin.com'],
      cards: ['[data-e2e="user-post-list"] li,.user-post-list li,li'],
      bodies: ['[data-e2e="video-desc"],[data-e2e="aweme-title"],.title'],
      reposts: '', dates: '[data-e2e="video-publish-time"],.publish-time,time',
      authors: '[data-e2e="video-author-name"],.author-name', kind: 'post_listing',
    },
    'xiaohongshu-notes': {
      hosts: ['xiaohongshu.com', 'www.xiaohongshu.com'],
      cards: ['section.note-item,.note-item'],
      bodies: ['.title,.note-text,.note-content,.desc'],
      reposts: '', dates: '.date,.time,time', authors: '.author .name,.username',
      kind: 'note_listing',
    },
    'generic-posts': {
      hosts: null, cards: ['article,[role="article"]'], bodies: [],
      reposts: 'blockquote', dates: 'time', authors: '[rel="author"]', kind: 'article',
    },
  };
  const config = configs[recipe];
  // Controller-only state in the isolated world, never in DOM attributes,
  // page application state or browser storage. Distinguishes real DOM cards
  // while lazy media loads; these IDs are observations, never public post IDs.
  const observationStateKey = '__codexFixedResearchDomObservationsV1';
  let observationState = null;
  if (recipe === 'bilibili-dynamic') {
    if (!Object.prototype.hasOwnProperty.call(globalThis, observationStateKey)) {
      Object.defineProperty(globalThis, observationStateKey, {value:{
        epoch:`dom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,10)}`,
        cards:new WeakMap(), next:0,
      }});
    }
    observationState = globalThis[observationStateKey];
  }
  function cardObservationId(card, author, date, ownText, repost, media) {
    if (!observationState) return null;
    const signature = JSON.stringify([author,date,ownText,repost.map(part=>[part.author,part.text])]);
    const mediaKeys = media.items.map(entry=>`${entry.kind}:${entry.url || ''}`).sort();
    const previous = observationState.cards.get(card);
    const mediaCompatible = !previous?.media.length || !mediaKeys.length
      || previous.media.every(key=>mediaKeys.includes(key))
      || mediaKeys.every(key=>previous.media.includes(key));
    if (!previous || previous.signature !== signature || !mediaCompatible) {
      const value = {id:`${observationState.epoch}:${++observationState.next}`,signature,media:mediaKeys};
      observationState.cards.set(card,value);
      return value.id;
    }
    previous.media = [...new Set([...previous.media,...mediaKeys])];
    return previous.id;
  }
  const visibilityCache = new WeakMap();
  const skippedTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'META', 'LINK', 'IFRAME', 'OBJECT', 'EMBED']);
  const snapshotBudget = { nodes: 200000, chars: 4000000, exhausted: false };
  let budget = snapshotBudget;
  let cardBudgetExhausted = false;
  const normalize = value => String(value || '').replace(/\r/g, '').replace(/[\t\f\v ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const attr = (node, name) => typeof node?.getAttribute === 'function' ? node.getAttribute(name) : null;
  function visible(node) {
    if (!node || node.nodeType !== 1) return false;
    if (visibilityCache.has(node)) return visibilityCache.get(node);
    let result = true;
    if (skippedTags.has(node.tagName) || node.hidden || node.isContentEditable || attr(node, 'aria-hidden') === 'true' || attr(node, 'inert') !== null) result = false;
    if (result) {
      const style = getComputedStyle(node);
      result = style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse' && style.contentVisibility !== 'hidden' && Number(style.opacity || 1) !== 0;
    }
    if (result && node.parentElement) result = visible(node.parentElement);
    if (result && typeof node.getBoundingClientRect === 'function') {
      const box = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      result = style.display === 'contents' || (box.width > 0 && box.height > 0);
    }
    visibilityCache.set(node, result);
    return result;
  }
  function select(root, selector) {
    if (!selector || typeof root?.querySelectorAll !== 'function') return [];
    return Array.from(root.querySelectorAll(selector)).filter(visible);
  }
  function outermost(nodes) {
    const candidates = new Set(nodes);
    return nodes.filter(node => {
      for (let parent = node.parentElement; parent; parent = parent.parentElement) if (candidates.has(parent)) return false;
      return true;
    });
  }
  const viewportHeight = typeof innerHeight === 'number' ? innerHeight : 0;
  const viewportWidth = typeof innerWidth === 'number' ? innerWidth : 0;
  function inViewport(node, margin = 0) {
    if (!viewportHeight || !viewportWidth) return false;
    const rect = node.getBoundingClientRect();
    return rect.bottom > -margin && rect.top < viewportHeight + margin && rect.right > 0 && rect.left < viewportWidth;
  }
  function readText(root, excluded = []) {
    let truncated = false;
    const parts = [];
    function walk(node) {
      if (budget.nodes <= 0 || budget.chars <= 0 || snapshotBudget.nodes <= 0 || snapshotBudget.chars <= 0) {
        budget.exhausted = true;
        if (snapshotBudget.nodes <= 0 || snapshotBudget.chars <= 0) snapshotBudget.exhausted = true;
        truncated = true; return;
      }
      budget.nodes--;
      if (budget !== snapshotBudget) snapshotBudget.nodes--;
      if (node.nodeType === 3) {
        if (!visible(node.parentElement)) return;
        const value = String(node.nodeValue || '');
        const remaining = Math.min(budget.chars, snapshotBudget.chars);
        const consumed = Math.min(value.length, remaining);
        parts.push(value.substring(0, consumed));
        budget.chars -= consumed;
        if (budget !== snapshotBudget) snapshotBudget.chars -= consumed;
        if (value.length > remaining) {
          truncated = true; budget.exhausted = true;
          if (snapshotBudget.chars <= 0) snapshotBudget.exhausted = true;
        }
        return;
      }
      if (!visible(node) || excluded.includes(node)) return;
      if (node.tagName === 'BR') { parts.push('\n'); return; }
      if (node.tagName === 'IMG') {
        const alt = attr(node, 'alt') || '';
        if (/(?:emoticon|emoji|表情)/i.test(attr(node, 'class') || '') || /^\[[^\]]{1,30}\]$/.test(alt)) parts.push(alt);
        return;
      }
      const block = /^(P|DIV|SECTION|ARTICLE|LI|UL|OL|H[1-6]|BLOCKQUOTE|HEADER|FOOTER)$/.test(node.tagName);
      if (block) parts.push('\n');
      for (const child of Array.from(node.childNodes || [])) {
        walk(child);
        if (budget.exhausted || snapshotBudget.exhausted) break;
      }
      if (block) parts.push('\n');
    }
    walk(root);
    return { text: normalize(parts.join('')), truncated };
  }
  function textOf(root) { return root ? readText(root).text : ''; }
  function httpUrl(raw) {
    if (typeof raw !== 'string' || !raw) return null;
    try { const url = new URL(raw, document.baseURI); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; }
    catch { return null; }
  }
  const pageUrl = httpUrl(document.location?.href || document.baseURI);
  const pageHost = pageUrl ? new URL(pageUrl).hostname : '';
  function sourceLink(raw) {
    const url = httpUrl(raw);
    if (!url) return null;
    const parsed = new URL(url);
    if (config.hosts && !config.hosts.includes(parsed.hostname)) return null;
    const path = parsed.pathname;
    let match = null;
    if (recipe === 'weibo-feed') match = path.match(/^\/(?:status|detail)\/([A-Za-z0-9]+)\/?$/) || path.match(/^\/\d{5,}\/([A-Za-z0-9]+)\/?$/);
    else if (recipe === 'bilibili-dynamic') match = path.match(/^\/(?:opus|dynamic|dynamic\/detail)\/(\d+)\/?$/) || (parsed.hostname === 't.bilibili.com' ? path.match(/^\/(\d+)\/?$/) : null);
    else if (recipe === 'bilibili-video') match = path.match(/^\/video\/(BV[0-9A-Za-z]+)\/?$/);
    else if (recipe === 'douyin-posts') match = path.match(/^\/(?:video|note)\/(\d+)\/?$/);
    else if (recipe === 'xiaohongshu-notes') match = path.match(/^\/(?:explore|discovery\/item)\/([0-9a-f]{24})\/?$/) || path.match(/^\/user\/profile\/[0-9a-f]{24}\/([0-9a-f]{24})\/?$/);
    else { match = path.match(/\/(?:status|posts?|articles?|notes?)\/([\w-]+)\/?$/); }
    if (!match && recipe !== 'generic-posts') return null;
    return { source_id: match ? match[1] : url, post_url: url };
  }
  function findLink(card, excluded = []) {
    let links = select(card, 'time a[href],a[href]');
    links = links.filter(link => !excluded.some(node => node.contains(link)));
    const dated = links.filter(link => config.dates && (link.matches?.(config.dates) || select(link, 'time').length));
    for (const link of [...dated, ...links]) {
      const result = sourceLink(attr(link, 'href'));
      if (result && recipe === 'generic-posts' && result.source_id === result.post_url && !dated.includes(link) && attr(link, 'rel') !== 'bookmark') continue;
      if (result) return result;
    }
    return null;
  }
  function dateOf(card, excluded = []) {
    for (const node of select(card, config.dates).filter(node => !excluded.some(other => other.contains(node)))) {
      const shown = textOf(node);
      const datetime = attr(node, 'datetime');
      const title = attr(node, 'title');
      if (datetime && /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.+Z-]+)?$/.test(datetime)) return { date: datetime, date_basis: 'visible_time_datetime', date_text: shown };
      if (title && /\d{4}[-年/.]\d{1,2}/.test(title)) return { date: title, date_basis: 'visible_date_title', date_text: shown };
      if (shown) return { date: shown, date_basis: 'visible_date_text', date_text: shown };
    }
    return { date: null, date_basis: 'not_visible', date_text: null };
  }
  function mediaOf(card, kind) {
    const entries = [];
    let placeholderCount = 0;
    for (const image of select(card, 'img')) {
      const marker = `${attr(image, 'class') || ''} ${attr(image, 'alt') || ''}`;
      if (/(?:avatar|emoticon|emoji|头像|表情)/i.test(marker) || /^\[[^\]]{1,30}\]$/.test(attr(image, 'alt') || '') || image.closest?.('[class*="avatar"],[class*="emoji"],[class*="emoticon"]')) continue;
      const url = httpUrl(image.currentSrc || attr(image, 'src'));
      if (!url || /(?:placeholder|transparent|loading|blank)(?:[._/-]|$)/i.test(new URL(url).pathname)) { placeholderCount++; continue; }
      const imageUrl = new URL(url);
      const imageBox = image.getBoundingClientRect();
      if (recipe === 'bilibili-dynamic' && /(?:^|\.)hdslb\.com$/i.test(imageUrl.hostname)
          && imageUrl.pathname.startsWith('/bfs/face/') && imageBox.width <= 64 && imageBox.height <= 64) continue;
      entries.push({ kind: kind.includes('listing') ? 'cover' : 'image', url, alt: normalize(attr(image, 'alt')) || null });
    }
    for (const video of select(card, 'video')) {
      const url = httpUrl(video.currentSrc || attr(video, 'src'));
      if (url) entries.push({ kind: 'video', url, alt: null });
      const poster = httpUrl(attr(video, 'poster'));
      if (poster) entries.push({ kind: 'video-poster', url: poster, alt: null });
    }
    let declaredCount = null;
    for (const node of select(card, '[class*="pic-num"],[class*="picNum"],[class*="image-count"],[class*="photo-count"],.media-count,[aria-label]')) {
      const label = normalize(attr(node, 'aria-label')) || textOf(node);
      const match = label.match(/(?:共\s*|全部\s*|共计\s*)?(\d+)\s*(?:张(?:图|照片|图片)?|images?|photos?)/i);
      if (match) declaredCount = Math.max(declaredCount || 0, Number(match[1]));
    }
    const unique = entries.filter((entry, index) => entries.findIndex(other => other.kind === entry.kind && other.url === entry.url) === index);
    const imageCount = unique.filter(entry => ['image', 'cover'].includes(entry.kind)).length;
    return { items: unique, urls: [...new Set(unique.map(entry => entry.url))], visible_image_count: imageCount,
      visible_video_count: select(card, 'video').length, declared_count: declaredCount,
      gap: placeholderCount > 0 || (declaredCount !== null && imageCount < declaredCount),
      placeholder_count: placeholderCount, scope: 'current_visible_dom', requires_detail: kind.includes('listing') };
  }
  function expansionOf(card) {
    const markers = [];
    for (const node of select(card, 'button,[role="button"],a,span')) {
      // The observed Bilibili article "全文" control is a plain text span.
      // Inspect only short leaf spans so a long body is not read yet again.
      if (node.tagName === 'SPAN') {
        const children = Array.from(node.childNodes || []);
        if (children.some(child => child.nodeType !== 3)
            || children.reduce((size, child) => size + String(child.nodeValue || '').length, 0) > 80) continue;
      }
      const text = textOf(node);
      if (/^(?:展开(?:全文|更多)?|全文|查看全文|查看更多|更多|展开全部|show more|read more)(?:\s*[>›»…]*)?$/i.test(text)) markers.push({ kind: 'expand_text', text });
      if (/^(?:查看|展开)(?:全部)?\s*\d*\s*(?:张)?(?:图片|照片|图集)$/.test(text)) markers.push({ kind: 'open_gallery', text });
    }
    return { needed: markers.some(marker => marker.kind === 'expand_text'), markers };
  }
  function clipped(card) {
    const candidates = [card, ...select(card, 'p,div,span')];
    return candidates.some(node => {
      const style = getComputedStyle(node);
      const clamp = Number(style.webkitLineClamp || style.lineClamp || 0);
      return clamp > 0 && node.scrollHeight > node.clientHeight + 1;
    });
  }
  let cards = [];
  const routeMatches = !config.hosts || config.hosts.includes(pageHost);
  if (routeMatches) {
    for (const selector of config.cards) {
      // Known article/card containers remain observations even when a lazy
      // placeholder or DOM revision omits its source link. Broad LI fallbacks
      // require a matching public post link to avoid unrelated navigation.
      cards = outermost(select(document, selector)).filter(card => selector !== 'li' && recipe !== 'douyin-posts' || findLink(card, select(card, config.reposts)));
      if (cards.length) break;
    }
  }
  let detail = false;
  const currentSource = routeMatches ? sourceLink(pageUrl) : null;
  if (cards.length === 1 && currentSource && (recipe !== 'generic-posts' || currentSource.source_id !== currentSource.post_url)) detail = true;
  if (!cards.length && currentSource && recipe !== 'generic-posts') {
    const roots = select(document, 'main,article,[data-e2e="aweme-detail"],.note-detail-mask .note-container,.opus-detail');
    if (roots.length) { cards = [outermost(roots)[0]]; detail = true; }
  }
  const renderedCards = cards;
  // Infinite Bilibili feeds retain old cards. Read the viewport plus one screen
  // of overlap, not every card accumulated since the top of the page.
  const windowed = recipe === 'bilibili-dynamic' && !detail;
  const windowUnavailable = windowed && (!viewportHeight || !viewportWidth);
  if (windowed) cards = windowUnavailable ? [] : renderedCards.filter(card => inViewport(card, viewportHeight));
  const items = [];
  for (const card of cards) {
    if (snapshotBudget.exhausted || snapshotBudget.nodes <= 0 || snapshotBudget.chars <= 0) {
      snapshotBudget.exhausted = true; break;
    }
    // A pathological card must not spend all subsequent cards' text budget.
    budget = { nodes: 50000, chars: 1000000, exhausted: false };
    const repostNodes = outermost(select(card, config.reposts));
    const source = (detail ? currentSource : null) || findLink(card, repostNodes);
    const date = dateOf(card, repostNodes);
    const author = textOf(select(card, config.authors).find(node => !repostNodes.some(other => other.contains(node)))) || null;
    const full = readText(card);
    const bodies = detail ? [] : config.bodies.flatMap(selector => select(card, selector)).filter(node => !repostNodes.some(other => other === node || other.contains(node)));
    const own = bodies.length ? outermost(bodies).map(node => readText(node, repostNodes)) : [readText(card, repostNodes)];
    const ownText = normalize(own.map(result => result.text).join('\n'));
    const repost = repostNodes.map(node => {
      const body = readText(node);
      return { ...findLink(node), author: textOf(select(node, config.authors)[0]) || null, text: body.text, text_collection_truncated: body.truncated };
    });
    const expansion = expansionOf(card);
    const visuallyClipped = clipped(card);
    const kind = detail ? 'post_detail' : config.kind;
    const media = mediaOf(card, kind);
    const item = { source_id: source?.source_id || null, post_url: source?.post_url || null,
      ...date, author,
      dom_observation_id: cardObservationId(card, author, date.date, ownText, repost, media),
      full_visible_text: full.text, own_visible_text: ownText, repost,
      media, expansion,
      truncation: { text_collection_truncated: full.truncated || own.some(result => result.truncated) || repost.some(result => result.text_collection_truncated), visual_ellipsis_detected: visuallyClipped,
        list_summary: !detail && config.kind.includes('listing'), needs_detail: expansion.needed || visuallyClipped || (!detail && config.kind.includes('listing')) },
      card_kind: kind, stable_deduplication: Boolean(source), duplicate_observations: 1 };
    cardBudgetExhausted ||= budget.exhausted;
    const existing = item.source_id && items.find(other => other.source_id === item.source_id);
    if (!existing) items.push(item);
    else {
      existing.duplicate_observations++;
      if (item.full_visible_text.length > existing.full_visible_text.length) { existing.full_visible_text = item.full_visible_text; existing.own_visible_text = item.own_visible_text; existing.truncation = item.truncation; existing.expansion = item.expansion; }
      if (!existing.date && item.date) { existing.date = item.date; existing.date_basis = item.date_basis; existing.date_text = item.date_text; }
      existing.repost = [...existing.repost, ...item.repost].filter((value, index, array) => array.findIndex(other => other.source_id === value.source_id && other.text === value.text) === index);
      existing.media.items = [...existing.media.items, ...item.media.items].filter((value, index, array) => array.findIndex(other => other.kind === value.kind && other.url === value.url) === index);
      existing.media.urls = [...new Set([...existing.media.urls, ...item.media.urls])];
      existing.media.visible_image_count = existing.media.items.filter(entry => ['image', 'cover'].includes(entry.kind)).length;
      existing.media.visible_video_count = Math.max(existing.media.visible_video_count, item.media.visible_video_count);
      existing.media.declared_count = Math.max(existing.media.declared_count || 0, item.media.declared_count || 0) || null;
      existing.media.placeholder_count = Math.max(existing.media.placeholder_count, item.media.placeholder_count);
      existing.media.gap = existing.media.placeholder_count > 0 || (existing.media.declared_count !== null && existing.media.visible_image_count < existing.media.declared_count);
    }
  }
  budget = snapshotBudget;
  const outsideCards = node => !renderedCards.some(card => card === node || card.contains(node));
  const activeHint = node => outsideCards(node) && (!windowed || inViewport(node));
  const hintNodes = select(document, '[role="status"],footer,.list-end,.end-tip,[class*="no-more"],[class*="nomore"],[class*="load-end"]').filter(activeHint);
  const endHints = hintNodes.map(textOf).filter(text => /^(?:没有更多(?:了|内容)?|已(?:经)?(?:显示|加载)全部(?:内容)?|到底了|no more (?:posts|results|content)|end of list|nothing more to load)[。.!\s]*$/i.test(text));
  const loadingNodes = select(document, '[aria-busy="true"],[role="progressbar"],.loading,[class*="loading"],[class*="skeleton"]').filter(activeHint);
  const loginNodes = select(document, '[class*="login-panel"],[class*="loginModal"],[class*="login-modal"],[class*="login-popup"],[data-e2e="login-dialog"]').filter(outsideCards);
  const verifyNodes = select(document, '#captcha,[class*="captcha"],[class*="verification"],[class*="verify-dialog"]').filter(outsideCards);
  const pageFallback = !renderedCards.length ? textOf(document.body) : '';
  const loginHints = loginNodes.map(textOf).filter(Boolean);
  if (!loginHints.length && !cards.length && /(?:登录后(?:查看|可见)|请先登录|sign in to (?:view|continue)|log in to (?:view|continue))/i.test(pageFallback)) loginHints.push('visible_page_requires_login');
  const verificationHints = verifyNodes.map(textOf).filter(Boolean);
  if (!verificationHints.length && !cards.length && /(?:请完成验证|安全验证|验证码|verify (?:you are|your identity)|unusual traffic)/i.test(pageFallback)) verificationHints.push('visible_page_requires_verification');
  const pagination = { observed: false, next: null, at_last_page: null, verified: false, reason: 'no_registered_visible_next_control' };
  if (recipe === 'bilibili-video') {
    const fixedNextSelectors = [
      '.be-pager .be-pager-next',
      '.vui_pagenation button[aria-label="下一页"]',
      '.vui_pagination button[aria-label="下一页"]',
      '.pagination button[aria-label="下一页"]',
      '.bili-pagination button[aria-label="下一页"]',
      '.vui_pagenation .vui_pagenation--btn-side',
      '.vui_pagination .vui_pagination--btn-side',
    ];
    for (const selector of fixedNextSelectors) {
      const buttons = select(document, selector).filter(outsideCards);
      const index = buttons.findIndex(node => /^(?:下一页|下页|next)(?:\s*[>›»]*)?$/i.test(textOf(node)) || /^(?:下一页|next)$/i.test(attr(node, 'aria-label') || ''));
      if (index < 0) continue;
      const button = buttons[index];
      const disabled = button.disabled === true || attr(button, 'disabled') !== null || attr(button, 'aria-disabled') === 'true' || /(?:^|\s)(?:disabled|is-disabled|be-pager-disabled)(?:\s|$)/.test(attr(button, 'class') || '');
      pagination.observed = true;
      pagination.at_last_page = disabled;
      // A visible disabled next control supports only this DOM state, not
      // complete collection of previous pages or all media/comments.
      pagination.verified = true;
      pagination.reason = disabled ? 'registered_next_control_disabled' : 'registered_next_control_enabled';
      if (!disabled) pagination.next = { selector, expected_text: textOf(button), index };
      break;
    }
  }
  const pageState = { url: pageUrl, title: typeof document.title === 'string' ? document.title : '', route_matches_recipe: routeMatches,
    visible_card_count: cards.length, rendered_card_count: renderedCards.length, windowed, window_unavailable: windowUnavailable,
    collection_window: windowed ? 'viewport_plus_one_screen' : 'rendered_dom',
    extracted_item_count: items.length, unresolved_source_count: items.filter(item => !item.stable_deduplication).length, loading: loadingNodes.length > 0,
    loading_count: loadingNodes.length, login_hints: loginHints, verification_hints: verificationHints,
    explicit_end_hints: [...new Set(endHints)], endpoint_hint_observed: endHints.length > 0,
    expansion_count: items.filter(item => item.expansion.needed).length,
    truncation_count: items.filter(item => item.truncation.text_collection_truncated || item.truncation.visual_ellipsis_detected).length,
    extraction_truncated: snapshotBudget.exhausted || cardBudgetExhausted || windowUnavailable,
    truncation_reason: windowUnavailable ? 'viewport_unavailable' : snapshotBudget.exhausted ? 'snapshot_budget' : cardBudgetExhausted ? 'card_budget' : null,
    pagination, completion: 'visible_dom_only', historical_completion_proven: false,
    warnings: ['Rendered DOM observations only; virtualized, unmounted, collapsed, media and comments may remain unread.'] };
  if (!routeMatches) pageState.warnings.push('recipe_host_mismatch');
  if (!cards.length && !pageState.loading && !loginHints.length && !verificationHints.length) pageState.warnings.push('no_matching_visible_cards; this is not proof of no posts');
  if (pageState.extraction_truncated) pageState.warnings.push('visible_text_budget_exhausted_or_window_unavailable; stop and reread smaller page state before claiming text coverage');
  return { schema_version: 1, recipe, items, page_state: pageState };
}
