const fs = require('fs');
const path = require('path');
const iconv = require('iconv-lite');

// 参考 Reader 常见章节标题：第X章 / 楔子 / 序章 等
const CHAPTER_RE =
  /^(第[零〇一二三四五六七八九十百千万两壹贰叁肆伍陆柒捌玖拾佰仟\d]+[章节回集卷部].{0,40}|楔子.{0,20}|序章?.{0,20}|前言.{0,20}|引子.{0,20}|尾声.{0,20}|终章.{0,20}|Chapter\s*\d+.{0,40}|CHAPTER\s*\d+.{0,40}|【[^】]{1,40}】)$/;

function decodeBuffer(buf) {
  if (!buf || !buf.length) return '';
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) return buf.swap16().toString('utf16le');
  const utf8 = buf.toString('utf8');
  const bad = (utf8.match(/\uFFFD/g) || []).length;
  if (bad === 0 && !/Ã.|Â.|ä.|å.|æ.|ç./.test(utf8.slice(0, 2000))) {
    return utf8.replace(/^\uFEFF/, '');
  }
  try {
    return iconv.decode(buf, 'gbk').replace(/^\uFEFF/, '');
  } catch (_) {
    return utf8.replace(/^\uFEFF/, '');
  }
}

function compressEmptyLines(lines) {
  const out = [];
  let empty = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) {
      empty++;
      if (empty <= 1) out.push('');
    } else {
      empty = 0;
      out.push(lines[i].replace(/\s+$/g, ''));
    }
  }
  return out;
}

function parseNovel(text, fileName) {
  const rawLines = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const lines = compressEmptyLines(rawLines);
  const chapters = [];
  let current = { title: '开始', lines: [] };

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed && CHAPTER_RE.test(trimmed) && trimmed.length <= 80) {
      if (current.lines.some((x) => x.trim()) || chapters.length === 0) {
        if (current.lines.some((x) => x.trim()) || current.title !== '开始') {
          chapters.push(current);
        }
      }
      current = { title: trimmed, lines: [] };
    } else {
      current.lines.push(lines[i]);
    }
  }
  if (current.lines.some((x) => x.trim()) || chapters.length === 0) {
    chapters.push(current);
  }

  if (chapters.length === 1 && chapters[0].title === '开始') {
    const all = chapters[0].lines;
    const chunk = 100;
    const parts = [];
    for (let i = 0; i < all.length; i += chunk) {
      parts.push({
        title: '分段 ' + (parts.length + 1),
        lines: all.slice(i, i + chunk)
      });
    }
    return {
      title: path.basename(fileName, path.extname(fileName)),
      filePath: fileName,
      chapters: parts.length ? parts : [{ title: '全文', lines: all }]
    };
  }

  return {
    title: path.basename(fileName, path.extname(fileName)),
    filePath: fileName,
    chapters
  };
}

function loadTxtNovel(filePath) {
  const buf = fs.readFileSync(filePath);
  return parseNovel(decodeBuffer(buf), filePath);
}

module.exports = { loadTxtNovel, parseNovel, decodeBuffer };
