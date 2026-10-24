#!/usr/bin/env node
// 可见 Edge 单页批量 DOM 采集。不会启动浏览器、寻找配置、枚举页签或调用微博接口。
// 输出是待复核素材，不是已完成的主页核查；整窗截图须由外部真实窗口采集补齐。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

export const VERSION = '1.3.8';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = value => createHash('sha256').update(value).digest('hex');
const END_TEXT = /^(没有更多了|没有更多微博了|没有更多内容了~去其他页面看看吧|暂无更多微博|已加载全部微博|还没有微博|暂无微博)[。！!]?$/;
const ACCESS_TEXT = /^更多内容请至客户端查看[。！!]?$/;
const ALLOWED_METHODS = new Set(['Browser.getVersion', 'Target.getTargetInfo',
  'Target.attachToTarget', 'Runtime.evaluate', 'Input.dispatchMouseEvent', 'Page.navigate']);

export function validateOptions(options, { externalConnection = false } = {}) {
  const o = { maxScrolls: 40, maxSeconds: 40, intervalMs: 1000, startFromTop: false, ...options };
  if (!/^\d{5,20}$/.test(String(o.uid || ''))) throw new Error('uid_invalid');
  o.uid = String(o.uid);
  if (!externalConnection || o.endpoint !== undefined) {
    let endpoint;
    try { endpoint = new URL(o.endpoint); } catch { throw new Error('endpoint_invalid'); }
    if (endpoint.protocol !== 'ws:' || !['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname)
        || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
        || !/^\/devtools\/browser\/[a-z0-9-]+$/i.test(endpoint.pathname)) throw new Error('endpoint_not_explicit_loopback_browser');
  }
  if (!/^[a-z0-9_-]{8,128}$/i.test(o.targetId || '')) throw new Error('target_id_invalid');
  for (const key of ['route', 'owner', 'pageContinuity']) {
    if (typeof o[key] !== 'string' || !/^[\p{L}\p{N}_.\/-]{1,120}$/u.test(o[key])) throw new Error(`${key}_invalid`);
  }
  if (!o.outDir || !path.isAbsolute(o.outDir)) throw new Error('out_dir_must_be_absolute');
  if (!Number.isInteger(o.maxScrolls) || o.maxScrolls < 0 || o.maxScrolls > 1000) throw new Error('max_scrolls_invalid');
  if (!Number.isFinite(o.maxSeconds) || o.maxSeconds < 1 || o.maxSeconds > 3600) throw new Error('max_seconds_must_be_1_to_3600');
  if (!Number.isFinite(o.intervalMs) || o.intervalMs < 750 || o.intervalMs > 10000) throw new Error('interval_ms_must_be_750_to_10000');
  o.canonicalUrl = `https://weibo.com/u/${o.uid}`;
  return o;
}

export function validateBrowser(version) {
  const ua = String(version?.userAgent || '');
  if (!/\bEdg\/\d/.test(ua) || /Headless/i.test(ua + String(version?.product || ''))) throw new Error('browser_not_verified_visible_edge');
  return { browser: 'Microsoft Edge', version: ua.match(/\bEdg\/[\d.]+/)[0], protocol_version: version.protocolVersion || null };
}

export function isCanonicalProfile(url, uid) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'weibo.com' && u.port === ''
      && u.pathname === `/u/${uid}` && !u.search && !u.hash && !u.username && !u.password;
  } catch { return false; }
}

export function validateTarget(info, targetId, uid) {
  if (info?.discarded === true) throw new Error('target_discarded');
  if (info?.targetId !== targetId || info.type !== 'page' || !isCanonicalProfile(info.url, uid)) throw new Error('target_or_profile_mismatch');
}

function postUrl(value, uid) {
  try {
    const u = new URL(value);
    return u.hostname === 'weibo.com' && u.protocol === 'https:' && !u.username && !u.password
      && new RegExp(`^/${uid}/[a-zA-Z0-9]+$`).test(u.pathname) ? u.origin + u.pathname : null;
  } catch { return null; }
}

// 本函数可经已批准的现有连接器运行；仅读取页面正常加载的内容，不读取输入值或浏览器存储。
export function buildReadExpression(uid) {
  if (!/^\d{5,20}$/.test(String(uid))) throw new Error('uid_invalid');
  return `JSON.stringify((${readPage.toString()})(${JSON.stringify(String(uid))}))`;
}

function readPage(uid) {
  // readPage 会被序列化后在页面上下文执行，因此终点正则必须在函数内部定义。
  const pageEndText = /^(没有更多了|没有更多微博了|没有更多内容了~去其他页面看看吧|暂无更多微博|已加载全部微博|还没有微博|暂无微博)[。！!]?$/;
  const pageAccessText = /^更多内容请至客户端查看[。！!]?$/;
  const metadata = { captured_at: new Date().toISOString(), url: location.href, title: document.title,
    ready_state: document.readyState, visibility: document.visibilityState,
    was_discarded: document.wasDiscarded === true,
    viewport: { width: innerWidth, height: innerHeight }, scroll_y: scrollY,
    document_height: document.documentElement.scrollHeight, evidence_type: 'page_dom_not_full_window_screenshot' };
  // hidden 仅表示任务页在后台；真实 URL 不匹配或丢弃后重载造成的页面连续性中断仍停止读取。
  if (location.href !== 'https://weibo.com/u/' + uid || metadata.was_discarded) {
    return { ...metadata, ui: {}, articles: [], excluded_articles: [], end_markers: [], access_boundaries: [], empty_ready: false };
  }
  // 元素本身是否渲染，与整个任务页的 document.visibilityState 是两回事。
  const visible = e => {
    const r = e.getBoundingClientRect(), s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const onScreen = e => { const r = e.getBoundingClientRect(); return visible(e) && r.bottom >= 0 && r.top <= innerHeight; };
  const cleanUrl = value => {
    if (!value) return '';
    try { const u = new URL(value, location.href); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? u.origin + u.pathname : ''; }
    catch { return ''; }
  };
  const publicContentUrl = value => {
    try {
      const u = new URL(value, location.href);
      if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return '';
      // 保存公开内容/查询参数；未知参数（含签名/认证参数）不进入研究包。
      const publicParameters = new Set(['q', 'page', 'type', 'id', 'mid', 'bvid', 'uid', 'cid', 'p',
        'keyword', 'keywords', 'search_query', 'v', 'list', 't', 'wd', 'word', 'w', 'article_id',
        'wvr', 'Refer', 'profile_ftype', 'is_all', 'fid']);
      for (const key of [...u.searchParams.keys()]) {
        if (!publicParameters.has(key)) u.searchParams.delete(key);
      }
      return u.href;
    } catch { return ''; }
  };
  const authorUid = href => {
    try { const u = new URL(href, location.href); return u.hostname === 'weibo.com' ? (u.pathname.match(/^\/u\/(\d+)$/)?.[1] || '') : ''; }
    catch { return ''; }
  };
  const offScopeSelector = 'aside,[role="complementary"],[class*="recommend"],[class*="Recommend"],[class*="comment"],[class*="Comment"],[class*="sidebar"]';
  // 同一原帖 URL 可能同时用于作者展示链接和时间链接；原生 URL 与日期分别判定。
  // 只保留实际观察到的时间格式，不从作者名、当前时间或帖子 ID 推算日期。
  const dateText = value => String(value || '').trim();
  const isObservedDate = value => /^(?:(?:\d{2,4}-\d{1,2}-\d{1,2}|\d{1,2}-\d{1,2}|\d{4}年\d{1,2}月\d{1,2}日|\d{1,2}月\d{1,2}日)(?:[T\s]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?|(?:今天|昨天|前天)(?:\s+\d{1,2}:\d{2})?|刚刚|\d+\s*(?:秒|分钟|小时|天)前)$/.test(value);
  const timestampCandidate = link => {
    const time = Array.from(link.querySelectorAll('time')).find(visible);
    const timeSemantics = time || /(?:^|\s)_?time(?:[_-]|\s|$)/i.test(String(link.className));
    const fields = [
      [time?.getAttribute('datetime'), 'header_time_datetime', 60],
      [link.getAttribute('datetime'), 'header_link_datetime', 50],
      [time?.getAttribute('title'), 'header_time_title', 40],
      [link.getAttribute('title'), 'header_link_title', 30],
      [time?.innerText, 'header_time_text', 20],
      [link.innerText, 'header_link_text', 10]
    ];
    const observed = fields.find(([value]) => isObservedDate(dateText(value)));
    return observed ? { link, date: dateText(observed[0]), basis: observed[1],
      score: observed[2] + (timeSemantics ? 100 : 0) } : null;
  };
  const quoteSelector = '.retweet,.wbpro-feed-reText';
  const nonBodySelector = 'header,footer,[class*="avatar"],[class*="Avatar"],script,style,noscript,button,input,select,textarea,.vjs-control-bar,.vjs-modal-dialog,.vjs-text-track-display';
  const allArticles = Array.from(document.querySelectorAll('article')).filter(e => !e.closest(offScopeSelector) && visible(e));
  const articles = [], excluded = [];
  for (const element of allArticles) {
    const header = element.querySelector('header');
    const links = Array.from(header?.querySelectorAll('a[href]') || []).filter(visible);
    const author = links.find(a => authorUid(a.href));
    const author_uid = author ? authorUid(author.href) : '';
    const permalinkLinks = links.filter(a => new RegExp('^https://weibo.com/' + author_uid + '/[a-zA-Z0-9]+$').test(cleanUrl(a.href)));
    const timestamp = permalinkLinks.map(timestampCandidate).filter(Boolean).sort((a, b) => b.score - a.score)[0];
    const nativeLink = timestamp?.link || permalinkLinks[0];
    const native_url = nativeLink ? cleanUrl(nativeLink.href) : '';
    if (author_uid !== uid || !native_url) {
      excluded.push({ author_uid, native_url, reason: author_uid && author_uid !== uid ? 'other_author_or_liked_recommendation' : 'outer_author_unresolved' });
      continue;
    }
    // 转发区可能是 .wbpro-feed-content 的兄弟节点，不能只在 content 子树内寻找。
    // 所有节点仍须属于这个已核实外层署名的 article；推荐、评论和头像不进入正文素材。
    const belongs = e => e && typeof e.closest === 'function' && (!e.closest('article') || e.closest('article') === element)
      && !e.closest(offScopeSelector);
    const bodyNode = e => belongs(e) && !e.closest(nonBodySelector);
    const contentCandidates = Array.from(element.querySelectorAll('.wbpro-feed-content'));
    if (!contentCandidates.length && element.querySelector('.wbpro-feed-content')) contentCandidates.push(element.querySelector('.wbpro-feed-content'));
    const content = contentCandidates.find(e => bodyNode(e) && visible(e) && !e.closest(quoteSelector));
    const original = content?.querySelector('.wbpro-feed-ogText');
    const quoteRoots = Array.from(element.querySelectorAll(quoteSelector)).filter(e => bodyNode(e) && visible(e)
      && !e.parentElement?.closest(quoteSelector));
    const emojiAlt = e => e.tagName === 'IMG' && /^\[[^\]\r\n]+\]$/.test(e.getAttribute('alt') || '')
      ? e.getAttribute('alt') : '';
    const readText = (root, allowQuoted = false) => {
      if (!root) return '';
      const walk = e => {
        if (e.nodeType === 3) return e.nodeValue || '';
        // Vue 的注释占位和其他非 Element 节点没有 closest/getComputedStyle。
        if (e.nodeType && e.nodeType !== 1) return '';
        if (!bodyNode(e) || (!allowQuoted && e !== root && e.matches(quoteSelector))) return '';
        if (e.tagName === 'IMG') return emojiAlt(e);
        if (e.tagName === 'VIDEO' || e.tagName === 'SOURCE') return '';
        const style = getComputedStyle(e);
        if (style.visibility === 'hidden' || style.display === 'none') return '';
        if (e.tagName === 'BR') return '\n';
        // 无 childNodes 的简化离线 fixture 仍兼容；真实 DOM 按位置保留图片表情 alt。
        if (!e.childNodes) return e.innerText || '';
        const value = Array.from(e.childNodes).map(walk).join('');
        return /^(DIV|P|SECTION|LI|BLOCKQUOTE|H[1-6])$/.test(e.tagName) ? '\n' + value + '\n' : value;
      };
      return walk(root).replace(/[\t ]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    };
    const roots = [content && { node: content, content_region: 'own', region_id: 'own' },
      ...quoteRoots.map((node, i) => ({ node, content_region: 'quoted', region_id: `quote-${i + 1}` }))].filter(Boolean);
    const inRegion = (e, region) => bodyNode(e) && visible(e) && (region.content_region === 'quoted'
      || !e.closest(quoteSelector));
    const contentLinks = [], media = [], foldedRegions = [], quotedContents = [];
    for (const region of roots) {
      const regionLinks = Array.from(region.node.querySelectorAll('a[href]')).filter(e => inRegion(e, region));
      for (const a of regionLinks) {
        const url = publicContentUrl(a.href);
        if (url) contentLinks.push({ text: readText(a, region.content_region === 'quoted'), url,
          content_region: region.content_region, region_id: region.region_id });
      }
      for (const e of region.node.querySelectorAll('img,video')) {
        if (!inRegion(e, region) || emojiAlt(e)) continue;
        const src = e.currentSrc || e.src || '';
        // 平台表情、等级图标和作者头像不是正文图片；真正图片槽内的图片优先保留。
        if (e.tagName === 'IMG' && !e.closest('.woo-picture-slot')
          && /(?:face\.t\.sinajs\.cn|h5\.sinaimg\.cn|tvax\d*\.sinaimg\.cn)/i.test(src)) continue;
        media.push({ kind: e.tagName === 'VIDEO' ? 'video' : 'image', url: cleanUrl(src),
          alt: e.getAttribute('alt') || '', poster: cleanUrl(e.getAttribute('poster') || ''),
          content_region: region.content_region, region_id: region.region_id });
      }
      const folded = Array.from(region.node.querySelectorAll('a,span'))
        .some(e => inRegion(e, region) && e.innerText.trim() === '展开');
      if (folded) foldedRegions.push(region.region_id);
      if (region.content_region === 'quoted') {
        // 引用原帖的时间链接可在引用 footer 中；只作为来源元数据，不并入本人互动。
        const sourceLink = Array.from(region.node.querySelectorAll('a[href]')).filter(e => belongs(e) && visible(e))
          .find(a => /^https:\/\/weibo\.com\/\d+\/[a-zA-Z0-9]+$/.test(cleanUrl(a.href))
            && (/(?:^|\s)_?time[_-]/.test(String(a.className)) || /^\d{2,4}-\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2}/.test(a.innerText.trim())));
        const sourceUrl = sourceLink ? cleanUrl(sourceLink.href) : '';
        const sourceUid = sourceUrl.split('/')[3] || '';
        const quotedAuthor = sourceUid ? regionLinks.find(a => authorUid(a.href) === sourceUid) : null;
        quotedContents.push({ region_id: region.region_id, text: readText(region.node, true),
          author_uid: sourceUid, author: quotedAuthor?.innerText || '', source_url: sourceUrl, folded,
          attribution: 'quoted_content_not_subject_authored' });
      }
    }
    const ownText = readText(original);
    const ownContentText = readText(content);
    const outerFooters = Array.from(element.querySelectorAll('footer'))
      .filter(e => belongs(e) && visible(e) && !e.closest(quoteSelector));
    const outerFooter = outerFooters.length === 1 ? outerFooters[0] : null;
    articles.push({ author_uid, author: author?.getAttribute('aria-label') || author?.innerText || '', native_url,
      date: timestamp?.date || '',
      date_status: timestamp ? 'observed_header_time' : 'pending_no_qualified_header_time',
      date_basis: timestamp?.basis || null,
      text: [ownContentText, ...quotedContents.map(q => q.text)].filter(Boolean).join('\n\n'),
      text_scope: 'subject_article_body_and_explicit_quote_regions_excluding_comments',
      own_text: ownText, own_content_text: ownContentText,
      quoted_content_may_be_present: quoteRoots.length > 0, quoted_contents: quotedContents,
      content_links: contentLinks, media,
      media_observation: 'loaded_body_dom_only_not_absence_proof',
      folded: foldedRegions.length > 0, folded_regions: foldedRegions,
      interactions_visible: outerFooter?.getAttribute('aria-label') || '',
      interactions_attribution: outerFooter ? 'outer_footer_only_not_interaction_review_completion' : 'outer_footer_unresolved_pending',
      element_on_screen: onScreen(element),
      element_on_screen_basis: 'viewport_geometry_not_page_foreground'
    });
  }
  // UI 状态只判断正常可见 UI 控件，不读全页正文；文章里谈论验证码、限流不构成拦截。
  const ui = { login_wall: false, challenge: false, rate_limited: false };
  const uiNodes = Array.from(document.querySelectorAll('[role="dialog"],[role="alert"],.woo-modal-main,[class*="captcha"],[class*="verify"],[class*="error"],form'))
    .filter(e => !e.closest('article,' + offScopeSelector) && onScreen(e));
  if (Array.from(document.querySelectorAll('iframe[title*="验证"],iframe[title*="captcha"],iframe[src*="captcha"],iframe[src*="verify"]'))
    .some(e => !e.closest('article,' + offScopeSelector) && onScreen(e))) ui.challenge = true;
  for (const element of uiNodes) {
    const text = element.innerText.trim();
    const controls = Array.from(element.querySelectorAll('button,a,[role="button"]')).map(e => e.innerText.trim());
    const modal = element.matches('[role="dialog"],.woo-modal-main');
    if ((modal || allArticles.length === 0) && (element.querySelector('input[type="password"]') || controls.some(t => /^(登录|立即登录|扫码登录|验证码登录)$/.test(t)))) ui.login_wall = true;
    if (text.length < 240 && /^(安全验证|请完成验证|请完成安全验证|访问异常|请输入验证码|拖动滑块|请按顺序点击)/.test(text)) ui.challenge = true;
    if (text.length < 240 && /(访问过于频繁|访问频繁|请求过于频繁|请求频繁|操作过于频繁|操作频繁|稍后再试)/.test(text)) ui.rate_limited = true;
  }
  const endings = [], accessBoundaries = [];
  // 只接受同一 feed 容器内、最后 article 后、可见且精确匹配的平台结束节点。
  // 文章、评论、推荐卡和侧栏内的同词文本永远不是主页终点。
  // 虚拟列表的文章共同祖先不包含作为同级节点渲染的终点提示；优先使用主页 main。
  let feed = document.querySelector('main') || allArticles[0]?.parentElement;
  if (feed && allArticles.length && !allArticles.every(e => feed.contains(e))) {
    while (feed.parentElement && !allArticles.every(e => feed.contains(e))) feed = feed.parentElement;
  }
  if (feed && !['BODY', 'HTML'].includes(feed.tagName)) {
    const lastBottom = allArticles.length ? Math.max(...allArticles.map(e => e.getBoundingClientRect().bottom)) : 0;
    // 微博生产页的结束节点类名会动态生成；只依赖语义类名会漏掉真实终点。
    // 扫描通用文本节点后仍须同时满足精确文案、屏幕可见、位于最后一条文章之后、
    // 且不在文章/评论/推荐区，避免正文或推荐卡里的同词造成误判。
    for (const e of feed.querySelectorAll('div,span,p,[role="status"]')) {
      if (e.closest('article,' + offScopeSelector) || !onScreen(e)) continue;
      const text = e.innerText.trim();
      if (e.getBoundingClientRect().top >= lastBottom - 5) {
        const record = { text, visible: true, scope: 'feed_after_articles', inside_article: false,
          inside_comment: false, inside_recommendation: false, selector_hint: e.tagName.toLowerCase() + '.' + String(e.className).split(/\s+/).join('.') };
        if (pageEndText.test(text)) endings.push(record);
        else if (pageAccessText.test(text)) accessBoundaries.push(record);
      }
    }
  }
  return { ...metadata, ui, articles, excluded_articles: excluded,
    end_markers: endings, access_boundaries: accessBoundaries,
    empty_ready: allArticles.length === 0 && endings.length > 0 };
}

export function normalizeSnapshot(raw, uid) {
  const articles = [], excluded = [...(raw.excluded_articles || [])];
  for (const item of raw.articles || []) {
    const url = postUrl(item.native_url, uid);
    if (String(item.author_uid) !== String(uid) || !url) {
      excluded.push({ author_uid: item.author_uid || '', native_url: item.native_url || '', reason: 'outer_author_or_permalink_mismatch' });
      continue;
    }
    articles.push({ ...item, native_url: url, item_id: url.split('/').pop() });
  }
  return { ...raw, articles, excluded_articles: excluded };
}

export function hasExplicitEnd(snapshot) {
  return (snapshot.end_markers || []).some(e => e.visible === true && e.scope === 'feed_after_articles'
    && e.inside_article === false && e.inside_comment === false && e.inside_recommendation === false && END_TEXT.test(e.text));
}

export function hasExplicitAccessBoundary(snapshot) {
  return (snapshot.access_boundaries || []).some(e => e.visible === true && e.scope === 'feed_after_articles'
    && e.inside_article === false && e.inside_comment === false && e.inside_recommendation === false && ACCESS_TEXT.test(e.text));
}

export function decideStop(snapshot, state, options) {
  if (!isCanonicalProfile(snapshot.url, options.uid)) return 'target_changed';
  if (snapshot.was_discarded === true || snapshot.discarded === true) return 'page_discarded';
  if (snapshot.ui?.challenge) return 'challenge';
  if (snapshot.ui?.rate_limited) return 'rate_limited';
  if (snapshot.ui?.login_wall) return 'login_wall';
  if (!['interactive', 'complete'].includes(snapshot.ready_state)) return 'page_not_ready';
  if (hasExplicitEnd(snapshot)) return 'end_observed';
  if (hasExplicitAccessBoundary(snapshot)) return 'app_only_boundary';
  if (snapshot.articles.length === 0 && (snapshot.excluded_articles || []).length === 0) return 'content_not_ready';
  if (state.scrolls >= options.maxScrolls) return 'scroll_limit';
  if (state.elapsedMs >= options.maxSeconds * 1000) return 'time_limit';
  if (state.repeatedStates >= 3) return 'repeated_state_without_end';
  return null;
}

export function mergeSnapshot(ledger, snapshot, batchId) {
  for (const item of snapshot.articles) {
    const existing = ledger.get(item.native_url);
    if (existing) {
      existing.last_seen_at = snapshot.captured_at;
      existing.source_batches.push(batchId);
      if (!existing.text_versions.some(v => v.text === item.text)) existing.text_versions.push({ batch_id: batchId, text: item.text, folded: item.folded });
      existing.folded_seen ||= item.folded;
      for (const media of item.media || []) {
        if (!existing.media_observed.some(m => m.kind === media.kind && m.url === media.url)) existing.media_observed.push(media);
      }
      continue;
    }
    ledger.set(item.native_url, { item_id: item.item_id, url: item.native_url, author_uid: item.author_uid,
      author: item.author, published_at_visible: item.date, first_seen_at: snapshot.captured_at,
      last_seen_at: snapshot.captured_at, source_batches: [batchId], text_versions: [{ batch_id: batchId, text: item.text, folded: item.folded }],
      folded_seen: Boolean(item.folded), media_observed: item.media || [],
      review: { text: 'pending', detail: 'pending', media: 'pending', subject_interactions: 'pending', screenshot: 'not_assessed_risk_evidence' },
      attribution: 'outer_header_and_native_permalink_match_subject_uid' });
  }
  return ledger;
}

export function buildPending(ledger) {
  const rows = [...ledger.values()];
  return { text_review: rows.map(e => e.url), detail: rows.map(e => e.url),
    folded: rows.filter(e => e.folded_seen).map(e => e.url), media: rows.map(e => e.url),
    subject_interactions: rows.map(e => e.url), full_window_route_evidence: 'pending',
    risk_screenshots: 'determine_after_item_review' };
}

class Connection {
  constructor(endpoint) {
    this.socket = new WebSocket(endpoint); this.nextId = 0; this.pending = new Map(); this.lastSentAt = 0;
    this.socket.addEventListener('message', event => {
      let m; try { m = JSON.parse(String(event.data)); } catch { return; }
      const p = this.pending.get(m.id); if (!p) return;
      this.pending.delete(m.id); clearTimeout(p.timer);
      m.error ? p.reject(new Error('cdp_' + m.error.code)) : p.resolve(m.result);
    });
    this.socket.addEventListener('close', () => this.rejectPending('connection_closed'));
    this.socket.addEventListener('error', () => this.rejectPending('connection_error'));
  }
  rejectPending(code) { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(code)); } this.pending.clear(); }
  async open() {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('connection_timeout')), 7000);
      this.socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('connection_error')); }, { once: true });
    });
  }
  async call(method, params = {}, sessionId) {
    if (!ALLOWED_METHODS.has(method)) throw new Error('cdp_method_not_allowed');
    await sleep(Math.max(0, 120 - (Date.now() - this.lastSentAt)));
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error('connection_not_open');
    this.lastSentAt = Date.now();
    const id = ++this.nextId;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('cdp_timeout')); }, 7000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  close() { this.rejectPending('connection_closed_by_collector'); this.socket.close(); }
}

// adapter.call(method, params, sessionId) 必须复用调用者已批准且独占的现有 Edge 连接。
// 本入口不新建、不 open、不 close 连接；端点发现/授权也不属于它的职责。
// adapter.sessionId 可复用同一目标已有的附着会话；URL/target/browser 验证始终执行。
// 仅使用以下固定调用，不导出任意页面执行或任意 CDP 的代理入口。
export async function collectWithConnection(options, adapter) {
  const o = validateOptions(options, { externalConnection: true });
  if (!adapter || typeof adapter.call !== 'function') throw new Error('existing_connection_adapter_required');
  if (adapter.sessionId !== undefined && (typeof adapter.sessionId !== 'string' || !adapter.sessionId)) throw new Error('existing_target_session_invalid');
  // 独立新目录确保不覆盖前序台账；续跑保留页面位置，但必须使用新的输出目录。
  if (fs.existsSync(o.outDir)) throw new Error('out_dir_already_exists_use_new_batch_directory');
  fs.mkdirSync(o.outDir, { recursive: true });
  const startedAt = new Date().toISOString(), startMs = Date.now(), ledger = new Map();
  const status = { schema: 'weibo-edge-dom-batch-1.1', tool_version: VERSION, route_id: o.route,
    owner: o.owner, edge_page_continuity_id: o.pageContinuity, target_id: o.targetId,
    account_url: o.canonicalUrl, started_at: startedAt, from_start: false, requested_start_from_top: o.startFromTop,
    status: 'partial', platform_complete: false, reviewed_items: 0, stop_reason: 'not_started',
    full_window_route_evidence: 'pending', risk_screenshots: 'determine_after_item_review',
    batches: 0, scrolls: 0, raw_batches: [], visibility_states_observed: [] };
  const commandsFile = path.join(o.outDir, 'operations.jsonl');
  let sessionId = adapter.sessionId, latest, priorSignature = '', repeatedStates = 0, lastCallAt = 0;
  const connection = { call: async (method, params = {}, scopedSession) => {
    if (!ALLOWED_METHODS.has(method)) throw new Error('cdp_method_not_allowed');
    await sleep(Math.max(0, 120 - (Date.now() - lastCallAt)));
    lastCallAt = Date.now();
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(() => adapter.call(method, params, scopedSession)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('existing_connection_call_timeout')), 7000); })]);
    } finally { clearTimeout(timer); }
  } };
  const record = event => fs.appendFileSync(commandsFile, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
  const persist = () => {
    const items = [...ledger.values()].map(e => JSON.stringify(e)).join('\n') + (ledger.size ? '\n' : '');
    fs.writeFileSync(path.join(o.outDir, 'items.jsonl'), items, 'utf8');
    status.item_ledger_sha256 = hash(items); status.discovered_items = ledger.size;
    status.pending_items = ledger.size; status.ended_at = new Date().toISOString();
    fs.writeFileSync(path.join(o.outDir, 'pending.json'), JSON.stringify(buildPending(ledger), null, 2));
    fs.writeFileSync(path.join(o.outDir, 'status.json'), JSON.stringify(status, null, 2));
  };
  const read = async () => {
    const { targetInfo } = await connection.call('Target.getTargetInfo', { targetId: o.targetId });
    validateTarget(targetInfo, o.targetId, o.uid);
    const result = await connection.call('Runtime.evaluate', { expression: buildReadExpression(o.uid), returnByValue: true }, sessionId);
    if (result.exceptionDetails || typeof result.result?.value !== 'string') throw new Error('dom_read_failed');
    return normalizeSnapshot(JSON.parse(result.result.value), o.uid);
  };
  const save = snapshot => {
    const batch = String(++status.batches).padStart(4, '0'), filename = `batch-${batch}.json`;
    const raw = JSON.stringify(snapshot, null, 2);
    fs.writeFileSync(path.join(o.outDir, filename), raw, { flag: 'wx' });
    status.raw_batches.push({ path: filename, sha256: hash(raw), captured_at: snapshot.captured_at });
    mergeSnapshot(ledger, snapshot, batch);
    latest = snapshot;
    if (typeof snapshot.visibility === 'string' && !status.visibility_states_observed.includes(snapshot.visibility)) {
      status.visibility_states_observed.push(snapshot.visibility);
    }
    const signature = JSON.stringify([snapshot.scroll_y, snapshot.document_height, snapshot.articles.map(e => e.native_url)]);
    repeatedStates = signature === priorSignature ? repeatedStates + 1 : 0; priorSignature = signature;
    record({ operation: 'scoped_dom_read', batch, unique_posts: ledger.size, excluded_cards: snapshot.excluded_articles.length,
      visibility: snapshot.visibility, ui: snapshot.ui, scroll_y: snapshot.scroll_y });
    persist();
    process.stdout.write(`batch ${batch}: ${ledger.size} unique posts, ${snapshot.articles.length} subject cards, review pending\n`);
  };
  try {
    status.browser = validateBrowser(await connection.call('Browser.getVersion'));
    const { targetInfo } = await connection.call('Target.getTargetInfo', { targetId: o.targetId });
    validateTarget(targetInfo, o.targetId, o.uid);
    if (!sessionId) ({ sessionId } = await connection.call('Target.attachToTarget', { targetId: o.targetId, flatten: true }));
    save(await read());
    const firstBoundary = decideStop(latest, { scrolls: -1, elapsedMs: 0, repeatedStates: 0 }, o);
    if (firstBoundary && firstBoundary !== 'end_observed') { status.stop_reason = firstBoundary; return status; }
    if (o.startFromTop) {
      if (Date.now() - startMs >= o.maxSeconds * 1000) { status.stop_reason = 'time_limit'; return status; }
      record({ operation: 'navigate_canonical_start', url: o.canonicalUrl });
      await connection.call('Page.navigate', { url: o.canonicalUrl }, sessionId);
      // Page.navigate may complete before the virtualized feed mounts. Poll
      // the public DOM for a bounded period; transient empty snapshots are not
      // persisted as a false route boundary.
      let navigatedSnapshot, navigationTimedOut = false;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        // Empty/loading DOM is a readiness state, so decideStop deliberately
        // returns it before time_limit. Enforce the shared budget here too;
        // otherwise 20 readiness polls can overrun a short requested budget.
        const remainingMs = o.maxSeconds * 1000 - (Date.now() - startMs);
        if (remainingMs <= 0) { navigationTimedOut = true; break; }
        await sleep(Math.min(o.intervalMs, remainingMs));
        navigatedSnapshot = await read();
        const readiness = decideStop(navigatedSnapshot,
          { scrolls: -1, elapsedMs: Date.now() - startMs, repeatedStates: 0 }, o);
        if (!['page_not_ready', 'content_not_ready'].includes(readiness)) break;
      }
      repeatedStates = 0; priorSignature = null;
      if (navigatedSnapshot) save(navigatedSnapshot);
      if (navigationTimedOut) { status.stop_reason = 'time_limit'; return status; }
      status.from_start = isCanonicalProfile(latest.url, o.uid) && latest.scroll_y >= 0 && latest.scroll_y <= 5
        && latest.was_discarded !== true && latest.discarded !== true
        && ['interactive', 'complete'].includes(latest.ready_state) && !Object.values(latest.ui).some(Boolean);
    }
    while (true) {
      const reason = decideStop(latest, { scrolls: status.scrolls, elapsedMs: Date.now() - startMs, repeatedStates }, o);
      if (reason) { status.stop_reason = reason; break; }
      const width = Number(latest.viewport?.width), height = Number(latest.viewport?.height);
      if (!(width >= 200 && height >= 200)) throw new Error('viewport_unusable');
      const deltaY = Math.min(720, Math.floor(height * 0.65));
      await connection.call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: Math.floor(width * 0.65),
        y: Math.floor(height * 0.65), deltaX: 0, deltaY }, sessionId);
      status.scrolls += 1;
      record({ operation: 'normal_wheel', delta_y: deltaY });
      await sleep(o.intervalMs);
      save(await read());
    }
  } catch (error) {
    status.stop_reason = /^[a-z0-9_]+$/i.test(error.message) ? error.message : 'collector_error';
    record({ operation: 'stop_error', code: status.stop_reason });
  } finally {
    status.enumeration = status.stop_reason === 'end_observed' ? 'end_observed' : 'partial';
    status.natural_endpoint_observed = status.stop_reason === 'end_observed';
    status.final_url = latest?.url || null;
    status.final_scroll_y = latest?.scroll_y ?? null;
    status.final_visibility = latest?.visibility ?? null;
    persist();
    process.stdout.write(`stopped: ${status.stop_reason}; ${ledger.size} unique posts; platform remains incomplete\n`);
  }
  return status;
}

// 独立 CLI 才建立自己的连接。复用集成请调用 collectWithConnection，勿再次运行本包装。
export async function collect(options) {
  const o = validateOptions(options);
  let ownConnection;
  try {
    return await collectWithConnection(o, { call: async (...args) => {
      ownConnection ||= new Connection(o.endpoint);
      await ownConnection.open();
      return await ownConnection.call(...args);
    } });
  } finally { ownConnection?.close(); }
}

const HELP = `Visible Edge Weibo DOM batch collector ${VERSION}
node edge_dom_batch.mjs --endpoint ws://127.0.0.1:PORT/devtools/browser/ID \\
  --target-id TARGET --uid UID --out-dir ABSOLUTE_NEW_DIRECTORY \\
  --route ROUTE_ID --owner OWNER --page-continuity PAGE_ID
Optional: --max-scrolls 40 --max-seconds 40 --interval-ms 1000 --start-from-top
--max-scrolls 0 reads once without scrolling; default continues current page position.
Only a caller-designated target in the verified existing real Edge session is allowed.
Background (visibility=hidden) pages can be read and scrolled; visibility is preserved.
No forced focus, visibility spoofing, browser launch,
profile lookup, tab enumeration, credentials, private API, page closure or screenshots.
All outputs remain partial/pending; explicit end_observed is not review completion.
Reuse an approved connection: import collectWithConnection(options, adapter).
adapter.call(method, params, sessionId) uses the existing connection; no open/close
is invoked. Optional adapter.sessionId reuses its already-bound target session.
In this reuse mode only, options.endpoint may be omitted.
Offline tests: node test_edge_dom_batch.mjs
`;

function parseArgs(args) {
  const names = { '--endpoint': 'endpoint', '--target-id': 'targetId', '--uid': 'uid', '--out-dir': 'outDir',
    '--route': 'route', '--owner': 'owner', '--page-continuity': 'pageContinuity',
    '--max-scrolls': 'maxScrolls', '--max-seconds': 'maxSeconds', '--interval-ms': 'intervalMs' };
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--start-from-top') { parsed.startFromTop = true; continue; }
    const key = names[args[i]];
    if (!key || !args[i + 1] || args[i + 1].startsWith('--') || key in parsed) throw new Error('arguments_invalid');
    parsed[key] = ['maxScrolls', 'maxSeconds', 'intervalMs'].includes(key) ? Number(args[++i]) : args[++i];
  }
  return parsed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.includes('--help')) process.stdout.write(HELP);
  else {
    try { const result = await collect(parseArgs(process.argv.slice(2))); process.exitCode = result.stop_reason === 'end_observed' ? 0 : 2; }
    catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 2; }
  }
}
