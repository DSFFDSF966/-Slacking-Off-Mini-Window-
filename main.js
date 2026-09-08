const {
  app,
  BrowserWindow,
  globalShortcut,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  session,
  dialog,
  screen
} = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const https = require('https');
const http = require('http');
const xpath = require('xpath');
const { DOMParser } = require('@xmldom/xmldom');
const { loadTxtNovel } = require('./txt-reader');

app.setAppUserModelId('local.stealth.pip');
// 使用硬件加速，视频站点的播放器和解码器在 Electron 中更稳定

// ===== 全局稳定性：错误兜底，防止崩溃 =====
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.message, err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
app.on('render-process-gone', (_e, details) => {
  console.error('[render-process-gone]', details.reason, details.exitCode);
  // 渲染进程崩溃后，通知渲染进程恢复（如果主窗口还在）
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.reload(); } catch (e) {}
  }
});
app.on('child-process-gone', (_e, details) => {
  console.error('[child-process-gone]', details.type, details.reason);
});

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
const PROGRESS_PATH = path.join(app.getPath('userData'), 'reading-progress.json');
const DEFAULT_HOTKEYS = {
  hide: 'Alt+H',
  chrome: 'F12',
  pin: 'Control+T',
  toc: 'F8',
  help: 'F1'
};

const DEFAULT_SITES = [
  { name: 'B站', url: 'https://www.bilibili.com' },
  { name: '百度', url: 'https://www.baidu.com' },
  { name: 'YouTube', url: 'https://www.youtube.com' },
  { name: '知乎', url: 'https://www.zhihu.com' },
  { name: '网易云', url: 'https://music.163.com' },
  { name: 'QQ音乐', url: 'https://y.qq.com' },
  { name: '七猫小说', url: 'https://www.qimao.com' },
  { name: '番茄小说', url: 'https://fanqienovel.com' },
  { name: '起点中文', url: 'https://www.qidian.com' },
  { name: '6v电影', url: 'https://www.6vhao.tv' }
];

// 内置搜索源（参考 binbyu/Reader 书源思路，开放可扩展）
const DEFAULT_SEARCH_SOURCES = [
  { name: '七猫小说', url: 'https://www.qimao.com', searchUrl: 'https://www.qimao.com/search/?keyword={k}' },
  { name: '纵横中文', url: 'https://www.zongheng.com', searchUrl: 'https://search.zongheng.com/search?keyword={k}' },
  { name: '起点中文', url: 'https://www.qidian.com', searchUrl: 'https://www.qidian.com/search?kw={k}' },
  { name: '笔趣阁', url: 'https://www.biquge.lu', searchUrl: 'https://www.biquge.lu/search?q={k}' },
  { name: '百度小说', url: 'https://www.baidu.com', searchUrl: 'https://www.baidu.com/s?wd={k}+小说+TXT下载' },
  { name: '搜狗搜索', url: 'https://www.sogou.com', searchUrl: 'https://www.sogou.com/web?query={k}+TXT小说下载' }
];

// 内置搜索源（参考 binbyu/Reader 书源思路）
const SEARCH_SOURCES = {
  novel: DEFAULT_SEARCH_SOURCES
};

// ========== binbyu/Reader 书源解析（在线小说搜索+阅读） ==========
let BOOK_SOURCES = [];

function loadBookSources() {
  try {
    const bsPath = path.join(__dirname, 'bs.json');
    if (fs.existsSync(bsPath)) {
      let raw = fs.readFileSync(bsPath, 'utf-8');
      // 去掉 UTF-8 BOM
      if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
      const data = JSON.parse(raw);
      BOOK_SOURCES = data.book_sources || [];
      console.log('加载书源: ' + BOOK_SOURCES.length + ' 个');
    }
  } catch (e) {
    console.error('加载书源失败: ' + e.message);
  }
}

// HTTP 请求（支持 GBK/UTF-8，忽略SSL证书错误）
function httpGet(url, charset) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9'
      },
      rejectUnauthorized: false, // 忽略自签名证书
      timeout: 15000
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // 跟随重定向
        const redirectUrl = new URL(res.headers.location, url).href;
        res.resume();
        httpGet(redirectUrl, charset).then(resolve).catch(reject);
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        // charset: 1=UTF-8, 2=GBK
        if (charset === 2) {
          try {
            const iconv = require('iconv-lite');
            resolve(iconv.decode(buf, 'gbk'));
          } catch (e) {
            resolve(buf.toString('utf-8'));
          }
        } else {
          resolve(buf.toString('utf-8'));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
  });
}

// XPath 查询（返回字符串数组）
function xpathQuery(doc, expression) {
  const results = [];
  try {
    const nodes = xpath.select(expression, doc);
    nodes.forEach(function(node) {
      if (node.nodeType === 2) { // 属性节点
        results.push(node.value);
      } else {
        results.push((node.textContent || '').trim());
      }
    });
  } catch (e) {
    // XPath 解析失败，返回空
  }
  return results;
}

// 搜索小说
async function searchBooks(sourceIndex, keyword) {
  const source = BOOK_SOURCES[sourceIndex];
  if (!source) throw new Error('书源不存在');
  const searchUrl = source.query_url.replace('%s', encodeURIComponent(keyword));
  const html = await httpGet(searchUrl, source.query_charset);
  const doc = new DOMParser().parseFromString(html, 'text/html');

  const names = xpathQuery(doc, source.book_name_xpath);
  const urls = xpathQuery(doc, source.book_mainpage_xpath);
  const authors = xpathQuery(doc, source.book_author_xpath || '');

  const results = [];
  for (let i = 0; i < names.length; i++) {
    let bookUrl = urls[i] || '';
    if (bookUrl && !bookUrl.startsWith('http')) {
      bookUrl = new URL(bookUrl, source.host).href;
    }
    results.push({
      name: names[i],
      url: bookUrl,
      author: authors[i] || '',
      source: source.title
    });
  }
  return results;
}

// 获取章节列表
async function getChapters(sourceIndex, bookUrl) {
  const source = BOOK_SOURCES[sourceIndex];
  if (!source) throw new Error('书源不存在');
  const html = await httpGet(bookUrl, source.query_charset);
  const doc = new DOMParser().parseFromString(html, 'text/html');

  const titles = xpathQuery(doc, source.chapter_title_xpath);
  const urls = xpathQuery(doc, source.chapter_url_xpath);

  const chapters = [];
  for (let i = 0; i < titles.length; i++) {
    let chapterUrl = urls[i] || '';
    if (chapterUrl && !chapterUrl.startsWith('http')) {
      chapterUrl = new URL(chapterUrl, source.host).href;
    }
    chapters.push({ title: titles[i], url: chapterUrl });
  }
  return chapters;
}

// 获取章节正文
async function getChapterContent(sourceIndex, chapterUrl) {
  const source = BOOK_SOURCES[sourceIndex];
  if (!source) throw new Error('书源不存在');
  const html = await httpGet(chapterUrl, source.query_charset);
  const doc = new DOMParser().parseFromString(html, 'text/html');

  // 正文可能是多个节点（如 <p>），也可能是单个容器
  let content = '';
  try {
    const nodes = xpath.select(source.content_xpath, doc);
    nodes.forEach(function(node) {
      if (node.nodeType === 1) { // 元素节点
        content += node.textContent + '\n\n';
      } else {
        content += node.textContent + '\n';
      }
    });
  } catch (e) {}

  // 内容过滤（去广告）
  if (source.content_filter_type === 1 && source.content_filter_keyword) {
    // 关键字过滤
    const keywords = source.content_filter_keyword.split('|').filter(k => k.trim());
    keywords.forEach(k => { content = content.split(k).join(''); });
  } else if (source.content_filter_type === 2 && source.content_filter_keyword) {
    // 正则过滤
    try {
      const re = new RegExp(source.content_filter_keyword, 'g');
      content = content.replace(re, '');
    } catch (e) {}
  }

  // 清理多余空行
  content = content.replace(/\n{3,}/g, '\n\n').trim();
  return content;
}

// ============================================================
// 统一小说数据接口（支持 API 类型 + XPath 类型，带超时和备用源）
// ============================================================
let NOVEL_SOURCES = [];

function loadNovelSources() {
  try {
    const nsPath = path.join(__dirname, 'novel-sources.json');
    if (fs.existsSync(nsPath)) {
      let raw = fs.readFileSync(nsPath, 'utf-8');
      if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
      const data = JSON.parse(raw);
      NOVEL_SOURCES = (data.sources || []).filter(s => s.enabled !== false);
      console.log('加载小说源: ' + NOVEL_SOURCES.length + ' 个');
    }
  } catch (e) {
    console.error('加载小说源失败: ' + e.message);
    NOVEL_SOURCES = [];
  }
}

// 带超时的 HTTP 请求（JSON）
function httpGetJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const timeout = options.timeout || 15000;
    const req = mod.get(url, {
      headers: options.headers || { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      timeout: timeout,
      rejectUnauthorized: false
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('JSON解析失败: ' + e.message));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
  });
}

// 从嵌套对象中按路径取值（如 "data.ret_data"）
function getByPath(obj, path) {
  if (!path) return obj;
  return path.split('.').reduce((o, k) => (o && o[k] !== undefined) ? o[k] : null, obj);
}

// 番茄小说搜索（从 gs1147/fanqie-booksource 抄的 API）
async function searchFanqie(keyword) {
  const url = 'https://novel.snssdk.com/api/novel/channel/homepage/search/search/v1/' +
    '?device_platform=android&parent_enterfrom=novel_channel_search.tab.&offset=0&aid=1967&q=' +
    encodeURIComponent(keyword);
  const data = await httpGetJson(url, {
    headers: { 'User-Agent': 'com.ss.android.article.news/7.0.3 (Linux; U; Android 12; zh_CN; Pixel 6)' },
    timeout: 10000
  });
  const books = getByPath(data, 'data.ret_data') || [];
  const results = [];
  const seen = new Set();
  for (const b of books) {
    const bid = b.book_id || '';
    if (!bid || seen.has(bid)) continue;
    seen.add(bid);
    let cover = b.audio_thumb_uri || b.thumb_url || '';
    if (cover.startsWith('//')) cover = 'https:' + cover;
    results.push({
      id: String(bid),
      name: (b.title || '').replace(/<[^>]+>/g, ''),
      author: b.author || '',
      cover: cover,
      category: b.category || '',
      intro: b.introduction || '',
      source: 'fanqie',
      sourceName: '番茄小说'
    });
  }
  return results;
}

// 统一小说搜索（遍历所有启用的源，带超时和错误处理）
async function novelSearch(keyword) {
  const results = [];
  const errors = [];
  // 1. 先搜番茄小说（API 类型，速度快）
  try {
    const fanqieResults = await searchFanqie(keyword);
    results.push(...fanqieResults);
  } catch (e) {
    errors.push('番茄小说: ' + e.message);
  }
  // 2. 再搜 binbyu/Reader 格式的书源（XPath 类型）
  for (let i = 0; i < BOOK_SOURCES.length; i++) {
    try {
      const r = await searchBooks(i, keyword);
      if (r && r.results && r.results.length > 0) {
        for (const b of r.results) {
          results.push({
            id: b.url || b.name,
            name: b.name || '',
            author: b.author || '',
            cover: b.cover || '',
            category: '',
            intro: b.intro || '',
            source: 'bs_' + i,
            sourceName: BOOK_SOURCES[i].title || '书源' + i,
            bookUrl: b.url || ''
          });
        }
      }
    } catch (e) {
      errors.push(BOOK_SOURCES[i].title + ': ' + e.message);
    }
    // 最多搜3个 XPath 书源，避免太慢
    if (results.length >= 20) break;
  }
  return { ok: true, results: results.slice(0, 30), errors: errors };
}

// 番茄小说获取目录
async function getFanqieChapters(bookId) {
  const url = 'https://fanqienovel.com/api/reader/directory/detail?bookId=' + bookId;
  const data = await httpGetJson(url, { timeout: 10000 });
  const chapters = getByPath(data, 'data.directory') || [];
  return chapters.map((c, i) => ({
    id: String(c.item_id || c.chapter_id || i),
    title: c.title || ('第' + (i + 1) + '章'),
    index: i
  }));
}

// 番茄小说获取正文
async function getFanqieContent(chapterId) {
  const url = 'https://fanqienovel.com/api/reader/full?itemId=' + chapterId;
  const data = await httpGetJson(url, { timeout: 10000 });
  let content = getByPath(data, 'data.content') || '';
  // 番茄小说正文是 HTML，转成纯文本
  content = content.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim();
  return content;
}

// 统一获取目录
async function novelChapters(book) {
  if (book.source === 'fanqie') {
    return await getFanqieChapters(book.id);
  } else if (book.source && book.source.startsWith('bs_')) {
    const idx = parseInt(book.source.replace('bs_', ''));
    return await getChapters(idx, book.bookUrl);
  }
  throw new Error('不支持的书源类型');
}

// 统一获取正文
async function novelContent(book, chapter) {
  if (book.source === 'fanqie') {
    return await getFanqieContent(chapter.id);
  } else if (book.source && book.source.startsWith('bs_')) {
    const idx = parseInt(book.source.replace('bs_', ''));
    return await getChapterContent(idx, chapter.url || chapter.id);
  }
  throw new Error('不支持的书源类型');
}

// 导出小说为 TXT
async function exportNovelTxt(book, chapters, progressCb) {
  let content = book.name + '\n' + (book.author ? '作者：' + book.author + '\n' : '') + '\n';
  for (let i = 0; i < chapters.length; i++) {
    try {
      const chapterContent = await novelContent(book, chapters[i]);
      content += '\n\n' + chapters[i].title + '\n\n' + chapterContent + '\n';
      if (progressCb) progressCb(i + 1, chapters.length);
    } catch (e) {
      content += '\n\n' + chapters[i].title + '\n\n[章节获取失败: ' + e.message + ']\n';
    }
    // 避免请求过快被封
    if (i % 5 === 4) await new Promise(r => setTimeout(r, 500));
  }
  return content;
}

const DEFAULT_CONFIG = {
  opacity: 1,
  alwaysOnTop: true,
  lastUrl: '',
  speed: 1,
  showTaskbar: false,
  muted: false,
  volume: 1,
  zoom: 1,
  customTitle: '小窗',
  customSites: DEFAULT_SITES,
  novelFont: 'Microsoft YaHei',
  toolbar: { quickSite: true, speed: true, mute: false, volume: false, opacity: true, help: false },
  backgroundImage: '',
  hideScrollbar: true,
  darkMode: false,
  autoRefresh: 0,
  bossTransparent: false,
  bossOpacity: 0.25,
  pauseOnBlur: true,
  favorites: [],
  history: [],
  customSearchSources: [],
  customQuickSources: [], // 用户自定义快速搜索源
  mediaControls: false, // 媒体控制栏开关
  bounds: { width: 560, height: 380 },
  hotkeys: { ...DEFAULT_HOTKEYS },
  // ===== v2 新增：会话/布局状态 =====
  version: 2,
  lastMode: 'web',          // 上次窗口模式：web / book / video
  lastVideoPath: '',        // 上次本地视频路径
  splitState: { active: false, ratio: 0.5, reversed: false }, // 分屏状态
  lineHeight: 1.9           // 小说默认行距
};

let mainWindow = null;
let tray = null;
let hidden = false;
let config = { ...DEFAULT_CONFIG };
let currentSpeed = 1;
let targetWindow = { hwnd: 0, title: '' };

function winWindowScript(mode, hwnd, alpha) {
  const scriptPath = app.isPackaged
    ? path.join(process.resourcesPath, 'win-window.ps1')
    : path.join(__dirname, 'win-window.ps1');
  return new Promise((resolve, reject) => {
    let ownHwnd = 0;
    try {
      const handle = mainWindow && mainWindow.getNativeWindowHandle();
      ownHwnd = handle && handle.length >= 8 ? Number(handle.readBigInt64LE(0)) : (handle ? handle.readInt32LE(0) : 0);
    } catch (_) {}
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Mode', mode,
      '-ExcludeHwnd', String(ownHwnd),
      '-Hwnd', String(hwnd || 0), '-Alpha', String(alpha == null ? 255 : alpha)];
    execFile('powershell.exe', args, { windowsHide: true, timeout: 10000 }, (error, stdout) => {
      if (error) return reject(error);
      try { resolve(stdout.trim() ? JSON.parse(stdout.trim()) : { ok: true }); }
      catch (_) { resolve({ ok: true }); }
    });
  });
}

// 遍历所有 webContents 应用倍速（包括 iframe 里的视频）
function applySpeedToAll() {
  const { webContents } = require('electron');
  const rate = currentSpeed;
  // 递归遍历 Shadow DOM + iframe，找到所有 video/audio 元素
  const js = `(function(r){
    window.__pipSpeed = r;
    function findMedia(root) {
      var results = [];
      if (!root) return results;
      try {
        var medias = root.querySelectorAll('video,audio');
        for (var i = 0; i < medias.length; i++) results.push(medias[i]);
        // 递归遍历 Shadow DOM
        var all = root.querySelectorAll('*');
        for (var j = 0; j < all.length; j++) {
          if (all[j].shadowRoot) {
            var shadowMedias = findMedia(all[j].shadowRoot);
            results = results.concat(shadowMedias);
          }
        }
      } catch(e) {}
      return results;
    }
    function setSpeed() {
      var medias = findMedia(document);
      medias.forEach(function(v){
        try { if (v.playbackRate !== r) v.playbackRate = r; } catch(e) {}
      });
    }
    setSpeed();
    if (!window.__pipSpeedObs) {
      window.__pipSpeedObs = new MutationObserver(function(){ setSpeed(); });
      window.__pipSpeedObs.observe(document.body || document.documentElement, { childList: true, subtree: true });
    }
    if (window.__pipSpeedTimer) clearInterval(window.__pipSpeedTimer);
    var count = 0;
    window.__pipSpeedTimer = setInterval(function(){
      setSpeed();
      count++;
      if (count >= 120) clearInterval(window.__pipSpeedTimer);
    }, 500);
  })(${rate})`;
  webContents.getAllWebContents().forEach(function(wc) {
    try {
      if (!wc.isDestroyed()) {
        wc.executeJavaScript(js, false).catch(function(){});
      }
    } catch (_) {}
  });
}

const AD_HOSTS = [
  // 谷歌系
  'doubleclick.net', 'googleadservices.com', 'googlesyndication.com',
  'adservice.google.com', 'google-analytics.com', 'googletagmanager.com',
  'googletagservices.com', 'googleads.g.doubleclick.net',
  // 广告网络
  'adnxs.com', 'adsrvr.org', 'amazon-adsystem.com', 'scorecardresearch.com',
  'moatads.com', 'criteo.com', 'taboola.com', 'outbrain.com',
  'pubmatic.com', 'rubiconproject.com', 'openx.net', 'casalemedia.com',
  'exponential.com', 'mathtag.com', 'advertising.com', 'atdmt.com',
  'contextweb.com', 'yieldmo.com', 'sharethrough.com', 'emxdgt.com',
  'connatix.com', 'seedtag.com', 'myvisualiq.net', '3lift.com',
  // 百度系
  'cpro.baidu.com', 'cbjs.baidu.com', 'cm.bilibili.com', 'pos.baidu.com',
  'cpro.baidustatic.com', 'bdstatic.com', 'hm.baidu.com',
  // 阿里系
  'uczzd.cn', 'tanx.com', 'tbcdn.cn', 'alimama.com',
  // 其他
  'umeng.com', 'umengcloud.com', 'cnzz.com', 'cnzz.net',
  '51.la', '51yes.com', 'ajs.com', 'segmentfault.com',
  'jiathis.com', 'bshare.cn', 'addthis.com', 'addthiscdn.com',
  'weboftrust.com', 'mywot.com', 'siteadvisor.com',
  'narrative.io', 'narrativeads.com', 'revcontent.com',
  'content.ad', 'contentad.net', 'mgid.com', 'plista.com',
  'zemanta.com', 'skimlinks.com', 'viglink.com', 'sovrn.com'
];

const AD_PATH_RE = /(\/pagead|\/adsense|\/adserver|\/adx\/)/i;

function shouldBlockUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    for (let i = 0; i < AD_HOSTS.length; i++) {
      const h = AD_HOSTS[i];
      if (host === h || host.endsWith('.' + h)) return true;
    }
    if (host === 'api.bilibili.com' && /web-show|cube\/deliver/i.test(u.pathname + u.search)) return true;
    if (AD_PATH_RE.test(u.pathname + u.search)) return true;
  } catch (_) { return false; }
  return false;
}

// 合并默认站点和用户站点，按 URL 去重，默认站点在前
function mergeSites(defaultSites, userSites) {
  const seen = new Set();
  const result = [];
  defaultSites.forEach(function(s) {
    if (!seen.has(s.url)) { seen.add(s.url); result.push(s); }
  });
  userSites.forEach(function(s) {
    if (s && s.url && !seen.has(s.url)) { seen.add(s.url); result.push(s); }
  });
  return result;
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      let rawText = fs.readFileSync(CONFIG_PATH, 'utf8');
      // 去掉 BOM
      if (rawText.charCodeAt(0) === 0xFEFF) rawText = rawText.slice(1);
      const raw = JSON.parse(rawText);
      config = {
        ...DEFAULT_CONFIG,
        ...raw,
        hotkeys: { ...DEFAULT_HOTKEYS, ...(raw.hotkeys || {}) },
        customSites: mergeSites(DEFAULT_SITES, Array.isArray(raw.customSites) ? raw.customSites : [])
      };
      // ===== 配置校验（防止损坏/非法值导致启动异常）=====
      if (!config.bounds || typeof config.bounds.width !== 'number' || typeof config.bounds.height !== 'number') {
        config.bounds = { ...DEFAULT_CONFIG.bounds };
      }
      if (typeof config.bounds.x !== 'number') config.bounds.x = undefined;
      if (typeof config.bounds.y !== 'number') config.bounds.y = undefined;
      if (!config.splitState || typeof config.splitState !== 'object') {
        config.splitState = { ...DEFAULT_CONFIG.splitState };
      }
      config.splitState = {
        active: !!config.splitState.active,
        ratio: Math.max(0.15, Math.min(0.85, Number(config.splitState.ratio) || 0.5)),
        reversed: !!config.splitState.reversed
      };
      const lh = Number(config.lineHeight);
      if (Number.isNaN(lh) || lh < 1.2 || lh > 3) config.lineHeight = DEFAULT_CONFIG.lineHeight;
      if (typeof config.lastMode !== 'string' || !['web', 'book', 'video'].includes(config.lastMode)) {
        config.lastMode = 'web';
      }
      if (typeof config.lastVideoPath !== 'string') config.lastVideoPath = '';
      config.version = 2; // 标记为已校验的最新版本
    }
  } catch (e) {
    console.error('[loadConfig] 配置文件损坏，使用默认配置:', e.message);
    // 备份损坏的配置
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        fs.copyFileSync(CONFIG_PATH, CONFIG_PATH + '.corrupted.' + Date.now());
      }
    } catch (_) {}
    config = { ...DEFAULT_CONFIG, hotkeys: { ...DEFAULT_HOTKEYS } };
  }
  currentSpeed = Number(config.speed) || 1;
}

// 立即写盘（退出/关闭等关键时机用）
function writeConfigNow() {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    if (mainWindow && !mainWindow.isDestroyed()) {
      const b = mainWindow.getBounds();
      config.bounds = { width: b.width, height: b.height, x: b.x, y: b.y };
    }
    config.speed = currentSpeed;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  } catch (_) {}
}

// 防抖保存：高频操作（透明度/倍速/滚动等）不频繁写磁盘
let saveTimer = null;
function saveConfig() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(function() { saveTimer = null; writeConfigNow(); }, 400);
}
// 立即刷新所有待写状态（退出前调用）
function flushConfig() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  writeConfigNow();
}

function clampOpacity(v) {
  const n = Number(v);
  if (Number.isNaN(n)) return 1;
  // 下限 0.05：允许很透明，但不至于完全消失找不到
  return Math.min(1, Math.max(0.05, n));
}

async function setupAdblock() {
  const ses = session.fromPartition('persist:pip');
  // 保留基础域名拦截（补充中文广告）
  ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    if (shouldBlockUrl(details.url)) { callback({ cancel: true }); return; }
    callback({});
  });
  // 使用 Electron 当前 Chromium 的真实 UA，避免站点启用不匹配的播放器版本
  // 不启用 EasyList 二次拦截，避免误伤视频站播放器请求和推荐卡片。
}

function setHidden(next) {
  if (!mainWindow) return;
  hidden = next;
  const { webContents } = require('electron');
  if (hidden) {
    if (config.pauseOnBlur !== false) {
      webContents.getAllWebContents().forEach(function(wc) {
        try { wc.setAudioMuted(true); } catch (_) {}
        try {
          wc.executeJavaScript(
            `document.querySelectorAll('video,audio').forEach(function(v){try{v.pause()}catch(e){}})`, false
          ).catch(function(){});
        } catch (_) {}
      });
    }
    mainWindow.hide();
  } else {
    mainWindow.show();
    mainWindow.setSkipTaskbar(!config.showTaskbar);
    mainWindow.focus();
    // 显示时恢复用户设置的静音状态
    webContents.getAllWebContents().forEach(function(wc) {
      try { wc.setAudioMuted(!!config.muted); } catch (_) {}
    });
  }
  if (!mainWindow.isDestroyed()) {
    mainWindow.webContents.send('hidden-changed', hidden);
  }
}

function toggleHidden() { setHidden(!hidden); }

// 获取对话框父窗口（窗口隐藏/销毁时返回 undefined，避免对话框弹不出来）
function getDialogParent() {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) return mainWindow;
  return undefined;
}

function getWebviewWebContents() {
  const all = BrowserWindow.getAllWindows();
  for (const win of all) {
    const wcs = win.webContents;
    // webview 的 webContents 可以通过 devtools 等获取，但最简单的方式是遍历
  }
  // 用 session 方式不可靠，直接在 web-contents-created 里记录
  return null;
}

let webviewContents = null;

function createWindow() {
  const b = config.bounds || DEFAULT_CONFIG.bounds;

  // 窗口位置恢复检查：只在保存的位置还在当前显示器上时才恢复，防止断开显示器后窗口在屏幕外
  let winX = typeof b.x === 'number' ? b.x : undefined;
  let winY = typeof b.y === 'number' ? b.y : undefined;
  if (winX !== undefined && winY !== undefined) {
    try {
      const disp = screen.getDisplayMatching({ x: winX, y: winY, width: b.width || 560, height: b.height || 380 });
      const wa = disp.workArea;
      const onScreen = winX < wa.x + wa.width && winX + (b.width || 560) > wa.x &&
                        winY < wa.y + wa.height && winY + (b.height || 380) > wa.y;
      if (!onScreen) { winX = undefined; winY = undefined; } // 不在屏幕上，让系统居中
    } catch (e) {}
  }

  mainWindow = new BrowserWindow({
    width: b.width || 560,
    height: b.height || 380,
    x: winX,
    y: winY,
    minWidth: 280,
    minHeight: 160,
    frame: false,
    thickFrame: true,
    alwaysOnTop: config.alwaysOnTop !== false,
    skipTaskbar: !config.showTaskbar,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#ffffff',
    show: false,
    title: config.customTitle || '小窗',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      spellcheck: true
    }
  });

  // webview安全加固：从主进程强制设置安全的preload和安全选项，防止渲染进程XSS后获得Node访问
  mainWindow.webContents.on('will-attach-webview', (_e, webPreferences, params) => {
    webPreferences.preload = path.join(__dirname, 'webview-preload.js');
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.webSecurity = true;
    if (params) {
      delete params.nodeintegration;
      delete params.nodeintegrationinsubframes;
      delete params.disablewebsecurity;
    }
  });

  mainWindow.setSkipTaskbar(!config.showTaskbar);
  mainWindow.setOpacity(clampOpacity(config.opacity));
  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.on('ready-to-show', () => {
    mainWindow.show();
    mainWindow.setSkipTaskbar(!config.showTaskbar);
  });
  mainWindow.on('show', () => mainWindow.setSkipTaskbar(!config.showTaskbar));
  // 窗口失焦：通知渲染进程暂停视频/静音；防老板透明渐变（默认关闭）
  mainWindow.on('blur', () => {
    try { mainWindow.webContents.send('window-blur'); } catch (e) {}
    if (config.bossTransparent && !hidden) {
      mainWindow.setOpacity(Math.min(clampOpacity(config.opacity), Number(config.bossOpacity) || 0.25));
    }
  });
  mainWindow.on('focus', () => {
    try { mainWindow.webContents.send('window-focus'); } catch (e) {}
    if (config.bossTransparent && !hidden) {
      mainWindow.setOpacity(clampOpacity(config.opacity));
    }
  });
  mainWindow.on('close', (e) => { e.preventDefault(); setHidden(true); flushConfig(); });
  mainWindow.on('closed', () => { mainWindow = null; });
  // 窗口移动/缩放：防抖记录位置，进程被杀也能恢复上次位置
  mainWindow.on('move', saveConfig);
  mainWindow.on('resize', saveConfig);
  mainWindow.on('unresponsive', () => {
    console.error('[main] 窗口无响应');
    // 不强制重启，只记录日志，避免丢失用户状态
  });
  mainWindow.on('responsive', () => {
    console.log('[main] 窗口恢复响应');
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[main] 渲染进程崩溃:', details.reason, details.exitCode);
    // 渲染进程崩溃后自动 reload
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.reload(); } catch (e) {}
    }
  });
}

function createTray() {
  const iconPath = path.join(__dirname, 'build', 'icon.png');
  const img = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAAD/eMzBAAAAGUlEQVQ4T2P8z8DAwMDAwMDAwMDAwMDAAAAn+AFq4s3vAAAAAElFTkSuQmCC'
  );
  tray = new Tray(img);
  tray.setToolTip(config.customTitle || '小窗');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示/隐藏', click: () => toggleHidden() },
      {
        label: '置顶', type: 'checkbox', checked: config.alwaysOnTop !== false,
        click: (item) => {
          config.alwaysOnTop = item.checked;
          if (mainWindow) mainWindow.setAlwaysOnTop(item.checked);
          saveConfig();
        }
      },
      { type: 'separator' },
      {
        label: '退出', click: () => {
          flushConfig();
          if (mainWindow) { mainWindow.removeAllListeners('close'); mainWindow.destroy(); }
          app.exit(0);
        }
      }
    ])
  );
  tray.on('double-click', () => setHidden(false));
}

function emitHotkey(name) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('hotkey', name);
  }
}

function registerHotkeys() {
  globalShortcut.unregisterAll();
  const hk = { ...DEFAULT_HOTKEYS, ...(config.hotkeys || {}) };
  // 只有老板键（隐身/显示）注册为全局热键——这个需要随时触发
  // 其他热键（去顶栏/置顶/目录/说明书）改为应用内热键，不拦截系统打字
  if (hk.hide) {
    try { globalShortcut.register(String(hk.hide), () => toggleHidden()); } catch (_) {}
  }
  // ` 键作为备用老板键
  try { globalShortcut.register('`', () => toggleHidden()); } catch (_) {}
}

function loadProgressMap() {
  try {
    if (fs.existsSync(PROGRESS_PATH)) {
      return JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf8')) || {};
    }
  } catch (_) {}
  return {};
}

function saveProgressMap(map) {
  try {
    fs.mkdirSync(path.dirname(PROGRESS_PATH), { recursive: true });
    fs.writeFileSync(PROGRESS_PATH, JSON.stringify(map, null, 2), 'utf8');
  } catch (_) {}
}

// ===== 进度读写缓存：滚动等高频保存只改内存，防抖写盘 =====
let progressCache = null;
let progressWriteTimer = null;
function getProgressMap() {
  if (!progressCache) progressCache = loadProgressMap();
  return progressCache;
}
function scheduleProgressWrite() {
  if (progressWriteTimer) clearTimeout(progressWriteTimer);
  progressWriteTimer = setTimeout(function() {
    progressWriteTimer = null;
    saveProgressMap(getProgressMap());
  }, 500);
}
function flushProgress() {
  if (progressWriteTimer) { clearTimeout(progressWriteTimer); progressWriteTimer = null; }
  saveProgressMap(getProgressMap());
}

function wireIpc() {
  ipcMain.handle('get-state', () => ({
    opacity: clampOpacity(config.opacity),
    alwaysOnTop: config.alwaysOnTop !== false,
    url: config.lastUrl,
    speed: currentSpeed,
    showTaskbar: !!config.showTaskbar,
    muted: !!config.muted,
    volume: Number(config.volume) || 1,
    zoom: Number(config.zoom) || 1,
    customTitle: config.customTitle || '小窗',
    customSites: config.customSites || DEFAULT_SITES,
    novelFont: config.novelFont || 'Microsoft YaHei',
    toolbar: { ...DEFAULT_CONFIG.toolbar, ...(config.toolbar || {}) },
    backgroundImage: config.backgroundImage || '',
    hideScrollbar: config.hideScrollbar !== false,
    darkMode: !!config.darkMode,
    autoRefresh: Number(config.autoRefresh) || 0,
    bossTransparent: config.bossTransparent === true,
    bossOpacity: Number(config.bossOpacity) || 0.25,
    pauseOnBlur: !!config.pauseOnBlur,
    targetWindow: targetWindow.title ? { ...targetWindow } : null,
    favorites: Array.isArray(config.favorites) ? config.favorites : [],
    history: Array.isArray(config.history) ? config.history.slice(0, 100) : [],
    searchSources: {
      novel: [...DEFAULT_SEARCH_SOURCES, ...(Array.isArray(config.customSearchSources) ? config.customSearchSources : [])]
    },
    customSearchSources: Array.isArray(config.customSearchSources) ? config.customSearchSources : [],
    customQuickSources: Array.isArray(config.customQuickSources) ? config.customQuickSources : [],
    hidden,
    hotkeys: { ...DEFAULT_HOTKEYS, ...(config.hotkeys || {}) },
    defaults: { ...DEFAULT_HOTKEYS },
    welcomePath: path.join(__dirname, 'welcome.html'),
    webviewPreload: path.join(__dirname, 'webview-preload.js'),
    sampleTxt: path.join(__dirname, 'examples', '测试小说.txt'),
    lastMode: config.lastMode || 'web',
    lastVideoPath: config.lastVideoPath || '',
    splitState: config.splitState || { active: false, ratio: 0.5, reversed: false },
    lineHeight: Number(config.lineHeight) || 1.9,
    version: config.version || 2
  }));

  ipcMain.handle('save-hotkeys', (_e, hk) => {
    config.hotkeys = { ...DEFAULT_HOTKEYS, ...(hk || {}) };
    saveConfig();
    registerHotkeys();
    return config.hotkeys;
  });

  // 收藏夹
  ipcMain.handle('add-favorite', (_e, fav) => {
    if (!fav || !fav.url) return config.favorites;
    // 去重
    config.favorites = (config.favorites || []).filter(function(f) { return f.url !== fav.url; });
    config.favorites.unshift({ name: fav.name || fav.url, url: fav.url, time: Date.now() });
    if (config.favorites.length > 200) config.favorites = config.favorites.slice(0, 200);
    saveConfig();
    return config.favorites;
  });
  ipcMain.handle('remove-favorite', (_e, url) => {
    config.favorites = (config.favorites || []).filter(function(f) { return f.url !== url; });
    saveConfig();
    return config.favorites;
  });
  // 历史记录
  ipcMain.handle('add-history', (_e, item) => {
    if (!item || !item.url) return config.history;
    config.history = (config.history || []).filter(function(h) { return h.url !== item.url; });
    config.history.unshift({ url: item.url, title: item.title || item.url, time: Date.now() });
    if (config.history.length > 100) config.history = config.history.slice(0, 100);
    saveConfig();
    return config.history;
  });
  ipcMain.handle('clear-history', () => {
    config.history = [];
    saveConfig();
    return [];
  });
  ipcMain.handle('save-history', (_e, items) => {
    config.history = Array.isArray(items) ? items.slice(0, 100) : [];
    saveConfig();
    return config.history;
  });

  // 搜索源管理（开放可扩展，参考 binbyu/Reader）
  ipcMain.handle('save-search-sources', (_e, sources) => {
    config.customSearchSources = Array.isArray(sources) ? sources.filter(function(s) {
      return s && s.name && s.searchUrl;
    }) : [];
    saveConfig();
    return config.customSearchSources;
  });
  ipcMain.handle('import-search-sources', (_e, jsonStr) => {
    try {
      const arr = JSON.parse(jsonStr);
      if (!Array.isArray(arr)) throw new Error('不是数组');
      const valid = arr.filter(function(s) { return s && s.name && s.searchUrl; });
      config.customSearchSources = [...(config.customSearchSources || []), ...valid];
      // 去重
      const seen = new Set();
      config.customSearchSources = config.customSearchSources.filter(function(s) {
        if (seen.has(s.name)) return false;
        seen.add(s.name);
        return true;
      });
      saveConfig();
      return { ok: true, count: valid.length, all: config.customSearchSources };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('export-search-sources', () => {
    return JSON.stringify(config.customSearchSources || [], null, 2);
  });

  // 在线小说书源（binbyu/Reader 格式）
  ipcMain.handle('get-book-sources', () => {
    return BOOK_SOURCES.map((s, i) => ({ index: i, title: s.title, host: s.host }));
  });
  ipcMain.handle('search-books', async (_e, sourceIndex, keyword) => {
    try {
      const results = await searchBooks(sourceIndex, keyword);
      return { ok: true, results };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('get-chapters', async (_e, sourceIndex, bookUrl) => {
    try {
      const chapters = await getChapters(sourceIndex, bookUrl);
      return { ok: true, chapters };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('get-chapter-content', async (_e, sourceIndex, chapterUrl) => {
    try {
      const content = await getChapterContent(sourceIndex, chapterUrl);
      return { ok: true, content };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ===== 统一小说数据接口 =====
  ipcMain.handle('novel-search', async (_e, keyword) => {
    try {
      return await novelSearch(keyword);
    } catch (e) {
      return { ok: false, error: e.message, results: [] };
    }
  });
  ipcMain.handle('novel-chapters', async (_e, book) => {
    try {
      const chapters = await novelChapters(book);
      return { ok: true, chapters };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('novel-content', async (_e, book, chapter) => {
    try {
      const content = await novelContent(book, chapter);
      return { ok: true, content };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('novel-export', async (_e, book, chapters) => {
    try {
      const content = await exportNovelTxt(book, chapters);
      // 保存到下载目录
      const savePath = path.join(app.getPath('downloads'), (book.name || '小说') + '.txt');
      fs.writeFileSync(savePath, content, 'utf8');
      return { ok: true, path: savePath, size: content.length };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // 媒体控制：播放/暂停
  ipcMain.handle('media-play-pause', async () => {
    const { webContents } = require('electron');
    const all = webContents.getAllWebContents();
    for (const wc of all) {
      if (wc.isDestroyed()) continue;
      try {
        await wc.executeJavaScript(`
          (function() {
            const videos = document.querySelectorAll('video');
            const audios = document.querySelectorAll('audio');
            let played = false;
            videos.forEach(function(v) {
              if (v.paused) { v.play(); played = true; }
              else { v.pause(); }
            });
            audios.forEach(function(a) {
              if (a.paused) { a.play(); played = true; }
              else { a.pause(); }
            });
            return played ? 'play' : 'pause';
          })();
        `);
      } catch (e) {}
    }
    return true;
  });

  ipcMain.on('set-opacity', (_e, value) => {
    config.opacity = clampOpacity(value);
    if (mainWindow) mainWindow.setOpacity(config.opacity);
    saveConfig();
  });

  ipcMain.on('save-url', (_e, url) => {
    if (url && !String(url).startsWith('file:')) {
      config.lastUrl = String(url);
      saveConfig();
    }
  });

  ipcMain.on('toggle-hidden', () => toggleHidden());

  ipcMain.on('set-always-on-top', (_e, on) => {
    config.alwaysOnTop = !!on;
    if (mainWindow) mainWindow.setAlwaysOnTop(config.alwaysOnTop);
    saveConfig();
  });

  ipcMain.on('set-speed', (_e, rate) => {
    currentSpeed = Math.min(4, Math.max(0.5, Number(rate) || 1));
    config.speed = currentSpeed;
    saveConfig();
    applySpeedToAll();
    // 频繁重试：iframe / 站内播放器 可能还没加载完，每500ms重试，共10次
    let tries = 0;
    const retry = setInterval(() => {
      tries++;
      applySpeedToAll();
      if (tries >= 10) clearInterval(retry);
    }, 500);
  });

  ipcMain.on('set-show-taskbar', (_e, show) => {
    config.showTaskbar = !!show;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setSkipTaskbar(!config.showTaskbar);
    }
    saveConfig();
  });

  ipcMain.on('set-muted', (_e, muted) => {
    config.muted = !!muted;
    // 遍历所有 webContents（主窗口+webview+所有iframe），全部静音
    const { webContents } = require('electron');
    webContents.getAllWebContents().forEach(function(wc) {
      try { wc.setAudioMuted(!!muted); } catch (_) {}
    });
    saveConfig();
  });

  ipcMain.on('set-volume', (_e, vol) => {
    const v = Math.min(1, Math.max(0, Number(vol) || 0));
    config.volume = v;
    if (webviewContents) {
      const js = `(function(){document.querySelectorAll('video,audio').forEach(function(el){try{el.volume=${v}}catch(e){}})})()`;
      try { webviewContents.executeJavaScript(js, false).catch(function(){}); } catch (_) {}
    }
    saveConfig();
  });

  ipcMain.on('set-ignore-mouse', (_e, ignore) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setIgnoreMouseEvents(!!ignore, { forward: !!ignore });
    }
  });

  // 保存自定义设置（标题、快捷网站、小说字体）
  ipcMain.handle('save-custom', (_e, settings) => {
    if (settings.customTitle !== undefined) {
      config.customTitle = String(settings.customTitle || '小窗').trim() || '小窗';
      if (mainWindow) mainWindow.setTitle(config.customTitle);
      if (tray) tray.setToolTip(config.customTitle);
    }
    if (Array.isArray(settings.customSites)) {
      config.customSites = settings.customSites.filter(s => s && s.name && s.url);
    }
    if (settings.novelFont) {
      config.novelFont = String(settings.novelFont);
    }
    saveConfig();
    return { customTitle: config.customTitle, customSites: config.customSites, novelFont: config.novelFont };
  });

  // 保存顶栏按钮显示配置
  ipcMain.handle('save-toolbar', (_e, tb) => {
    config.toolbar = { ...DEFAULT_CONFIG.toolbar, ...(tb || {}) };
    saveConfig();
    return config.toolbar;
  });

  // 保存缩放比例
  ipcMain.on('set-zoom', (_e, z) => {
    config.zoom = Math.min(3, Math.max(0.5, Number(z) || 1));
    saveConfig();
  });

  // 选择背景图片（转 base64 存入 config）
  ipcMain.handle('select-background', async () => {
    const res = await dialog.showOpenDialog(getDialogParent(), {
      title: '选择背景图片',
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }],
      properties: ['openFile']
    });
    if (res.canceled || !res.filePaths || !res.filePaths[0]) return null;
    try {
      const buf = fs.readFileSync(res.filePaths[0]);
      if (buf.length > 5 * 1024 * 1024) return { error: '图片超过5MB，请压缩后再试' };
      let ext = path.extname(res.filePaths[0]).slice(1).toLowerCase();
      if (ext === 'jpg') ext = 'jpeg';
      config.backgroundImage = `data:image/${ext};base64,${buf.toString('base64')}`;
      saveConfig();
      return { ok: true };
    } catch (e) {
      return { error: e.message || String(e) };
    }
  });

  // 清除背景图片
  ipcMain.handle('clear-background', () => {
    config.backgroundImage = '';
    saveConfig();
    return { ok: true };
  });

  // 保存额外设置（滚动条/夜间模式/自动刷新）
  ipcMain.handle('save-extras', (_e, extras) => {
    if (extras.hideScrollbar !== undefined) config.hideScrollbar = !!extras.hideScrollbar;
    if (extras.darkMode !== undefined) config.darkMode = !!extras.darkMode;
    if (extras.autoRefresh !== undefined) config.autoRefresh = Number(extras.autoRefresh) || 0;
    if (extras.bossTransparent !== undefined) config.bossTransparent = !!extras.bossTransparent;
    if (extras.bossOpacity !== undefined) config.bossOpacity = Math.min(1, Math.max(0.1, Number(extras.bossOpacity) || 0.25));
    if (extras.mediaControls !== undefined) config.mediaControls = !!extras.mediaControls;
    if (extras.pauseOnBlur !== undefined) config.pauseOnBlur = !!extras.pauseOnBlur;
    if (extras.customQuickSources !== undefined && Array.isArray(extras.customQuickSources)) config.customQuickSources = extras.customQuickSources;
    saveConfig();
    return {
      hideScrollbar: config.hideScrollbar,
      darkMode: config.darkMode,
      autoRefresh: config.autoRefresh,
      bossTransparent: config.bossTransparent,
      bossOpacity: config.bossOpacity,
      mediaControls: config.mediaControls,
      pauseOnBlur: !!config.pauseOnBlur,
    };
  });

  ipcMain.handle('pick-target-window', async () => {
    try {
      // 给用户时间把鼠标移到目标窗口，再用 WindowFromPoint 取窗
      await new Promise(resolve => setTimeout(resolve, 3000));
      const result = await winWindowScript('pick', 0, 255);
      if (!result || !result.hwnd) return { ok: false, error: '没有取到目标窗口，请重试' };
      targetWindow = { hwnd: Number(result.hwnd), title: String(result.title || '') };
      return { ok: true, ...targetWindow };
    } catch (e) { return { ok: false, error: e.message || '取窗失败' }; }
  });
  ipcMain.handle('set-target-opacity', async (_e, value) => {
    const alpha = Math.max(13, Math.min(255, Math.round(Number(value) * 2.55)));
    if (!targetWindow.hwnd) return { ok: false, error: '请先选择目标窗口' };
    try { await winWindowScript('set', targetWindow.hwnd, alpha); return { ok: true, value: Math.round(alpha / 2.55) }; }
    catch (e) { targetWindow = { hwnd: 0, title: '' }; return { ok: false, error: '目标窗口已关闭或不支持透明度' }; }
  });
  ipcMain.handle('reset-target-opacity', async () => {
    if (!targetWindow.hwnd) return { ok: false, error: '请先选择目标窗口' };
    try { await winWindowScript('reset', targetWindow.hwnd, 255); return { ok: true }; }
    catch (e) { targetWindow = { hwnd: 0, title: '' }; return { ok: false, error: '目标窗口已关闭' }; }
  });

  ipcMain.on('window-close', () => setHidden(true));
  ipcMain.on('window-minimize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
  });

  ipcMain.handle('load-progress', (_e, key) => {
    return getProgressMap()[String(key || '')] || null;
  });

  ipcMain.on('save-progress', (_e, key, data) => {
    if (!key) return;
    getProgressMap()[String(key)] = data || {};
    scheduleProgressWrite();
  });

  // 保存会话/布局状态（模式、本地视频、分屏、行距）
  ipcMain.handle('save-ui-state', (_e, s) => {
    if (s && typeof s === 'object') {
      if (typeof s.lastMode === 'string' && ['web', 'book', 'video'].includes(s.lastMode)) {
        config.lastMode = s.lastMode;
      }
      if (s.lastVideoPath !== undefined) {
        config.lastVideoPath = String(s.lastVideoPath || '');
      }
      if (s.splitState && typeof s.splitState === 'object') {
        config.splitState = {
          active: !!s.splitState.active,
          ratio: Math.max(0.15, Math.min(0.85, Number(s.splitState.ratio) || 0.5)),
          reversed: !!s.splitState.reversed
        };
      }
      const lh = Number(s.lineHeight);
      if (!Number.isNaN(lh) && lh >= 1.2 && lh <= 3) config.lineHeight = lh;
      saveConfig();
    }
    return { ok: true };
  });

  ipcMain.handle('open-txt', async () => {
    const res = await dialog.showOpenDialog(getDialogParent(), {
      title: '打开 TXT',
      filters: [{ name: '文本', extensions: ['txt'] }, { name: '全部', extensions: ['*'] }],
      properties: ['openFile']
    });
    if (res.canceled || !res.filePaths || !res.filePaths[0]) return null;
    try { return loadTxtNovel(res.filePaths[0]); }
    catch (e) { return { error: e.message || String(e) }; }
  });

  // 按路径打开 TXT（启动恢复 / 历史记录恢复用）
  ipcMain.handle('open-txt-path', async (_e, filePath) => {
    try {
      if (!filePath || !fs.existsSync(filePath)) return { error: '文件不存在或已被移动' };
      return loadTxtNovel(filePath);
    } catch (e) { return { error: e.message || String(e) }; }
  });

  ipcMain.handle('open-media', async () => {
    const res = await dialog.showOpenDialog(getDialogParent(), {
      title: '打开 TXT 或本地视频',
      filters: [
        { name: '支持的文件', extensions: ['txt', 'mp4', 'webm', 'mkv', 'avi', 'mov'] },
        { name: '文本', extensions: ['txt'] },
        { name: '视频', extensions: ['mp4', 'webm', 'mkv', 'avi', 'mov'] },
        { name: '全部', extensions: ['*'] }
      ],
      properties: ['openFile']
    });
    if (res.canceled || !res.filePaths || !res.filePaths[0]) return null;
    const p = res.filePaths[0];
    try {
      if (/\.txt$/i.test(p)) return { kind: 'book', data: loadTxtNovel(p) };
      if (/\.(mp4|webm|mkv|avi|mov)$/i.test(p)) return { kind: 'video', path: p };
      return { error: '仅支持 txt / mp4 / webm / mkv / avi / mov' };
    } catch (e) { return { error: e.message || String(e) }; }
  });

  ipcMain.handle('drop-txt', async (_e, filePath) => {
    try {
      if (!filePath || !fs.existsSync(filePath)) return { error: '文件不存在' };
      if (!/\.txt$/i.test(filePath)) return { error: '请选择 txt 文件' };
      return loadTxtNovel(filePath);
    } catch (e) { return { error: e.message || String(e) }; }
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => setHidden(false));
  // 每个 webContents（包括跨域 iframe）加载完成后，自动应用倍速
  app.on('web-contents-created', (_e, wc) => {
    wc.on('did-finish-load', () => {
      if (currentSpeed !== 1) applySpeedToAll();
    });
    wc.on('dom-ready', () => {
      if (currentSpeed !== 1) applySpeedToAll();
    });
  });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);

    // UA伪装：去掉Electron标识，防止网站拒绝
    try {
      app.userAgentFallback = app.userAgentFallback.replace(/ (PipReader|Electron)\/\S+/g, '');
    } catch (e) {}

    loadConfig();
    loadBookSources();
    loadNovelSources();
    setupAdblock();
    wireIpc();

    // 权限默认拒绝：只允许无害的，其他都拒绝
    const ses = session.fromPartition('persist:pip');
    ses.setPermissionRequestHandler((wc, permission, callback) => {
      const ALLOW = new Set(['fullscreen', 'clipboard-sanitized-write', 'media']);
      if (ALLOW.has(permission)) return callback(true);
      callback(false); // 默认拒绝其他所有权限
    });

    // 下载处理：自动保存到下载目录，处理文件名冲突
    ses.on('will-download', (_e, item) => {
      try {
        const dlDir = app.getPath('downloads');
        const name = path.basename(item.getFilename() || 'download');
        let dest = path.join(dlDir, name);
        if (fs.existsSync(dest)) {
          const ext = path.extname(name);
          const base = name.slice(0, name.length - ext.length);
          let i = 1;
          do { dest = path.join(dlDir, base + ' (' + (i++) + ')' + ext); } while (fs.existsSync(dest));
        }
        item.setSavePath(dest);
      } catch (e) { console.error('[download] error:', e.message); }
    });

    // webContents创建处理：给每个webview设置窗口打开处理器（禁止弹窗，在小窗内打开）
  app.on('web-contents-created', (_e, contents) => {
    if (contents.getType() !== 'webview') return;
    contents.on('did-start-navigation', (_ev, url) => {
      if (url && /douyin|iesdouyin|aweme|huoshan|bilibili/i.test(String(url))) {
        try { contents.setAudioMuted(!!config.muted); } catch (_) {}
        if (currentSpeed !== 1) {
          try { applySpeedToAll(); } catch (_) {}
        }
      }
    });
    contents.on('did-attach-webview', () => {
      if (currentSpeed !== 1) {
        try { applySpeedToAll(); } catch (_) {}
      }
    });
    contents.setWindowOpenHandler(({ url }) => {
      if (mainWindow && !mainWindow.isDestroyed() && /^(https?:|about:)/.test(url)) {
        mainWindow.webContents.send('webview-open-url', url);
      }
      return { action: 'deny' };
      });
    });

    createWindow();
    createTray();
    registerHotkeys();
  });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    flushConfig();
    flushProgress();
  });
  app.on('window-all-closed', (e) => e.preventDefault());
}
