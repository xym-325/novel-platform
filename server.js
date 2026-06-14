require('dotenv').config();
const express = require('express');
const multer = require('multer');
const mammoth = require('mammoth');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || '';

// --------------- 密码校验 ---------------
function checkPassword(req) {
  const pw = req.body?.password || req.query.password || req.headers['x-auth-password'];
  return pw === AUTH_PASSWORD;
}

// --------------- 中间件 ---------------
app.use(express.json());
// 静态文件服务，HTML/CSS/JS 强制 UTF-8
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    if (['.html', '.css', '.js', '.json'].includes(ext)) {
      res.setHeader('Content-Type',
        ext === '.html' ? 'text/html; charset=utf-8' :
        ext === '.css'  ? 'text/css; charset=utf-8' :
        ext === '.js'   ? 'application/javascript; charset=utf-8' :
                          'application/json; charset=utf-8');
    }
  }
}));

// --------------- 目录确保 ---------------
['uploads', 'novels', 'data'].forEach(dir => {
  const p = path.join(__dirname, dir);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

// --------------- 数据文件初始化 ---------------
const DATA_FILE = path.join(__dirname, 'data', 'novels.json');
function readData() {
  try {
    if (!fs.existsSync(DATA_FILE)) return [];
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  } catch { return []; }
}
function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

// --------------- 文件上传配置 ---------------
const storage = multer.diskStorage({
  destination: path.join(__dirname, 'uploads'),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + encodeURIComponent(file.originalname))
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.txt', '.docx', '.md'].includes(ext)) cb(null, true);
    else cb(new Error('仅支持 .txt / .docx / .md 文件'));
  },
  limits: { fileSize: 50 * 1024 * 1024 }
});

// --------------- 章节检测 ---------------
function detectChapters(text) {
  const patterns = [
    /^第[零一二三四五六七八九十百千万\d]+[章节卷部回]/gm,
    /^Chapter\s+\d+/gim,
    /^Part\s+\d+/gim,
    /^[#]{1,3}\s+.+/gm,
    /^[序楔终尾][章言声]/gm,
  ];

  // 合并所有模式匹配到的章节标记（按位置排序去重）
  const matchMap = new Map();
  for (const pattern of patterns) {
    for (const m of text.matchAll(pattern)) {
      const pos = m.index;
      if (!matchMap.has(pos)) {
        matchMap.set(pos, m[0].trim());
      }
    }
  }

  if (matchMap.size === 0) {
    return [{ title: '正文', start: 0 }];
  }

  const chapters = [...matchMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([start, title]) => ({ title, start }));

  // 如果第一章不是从文本开头开始，开头有实质内容则加"前言"
  if (chapters[0].start > 0) {
    const prefix = text.slice(0, chapters[0].start).replace(/\s/g, '');
    if (prefix.length > 50) {
      chapters.unshift({ title: '前言', start: 0 });
    }
  }

  return chapters;
}

function splitContent(text, chapters) {
  return chapters.map((ch, i) => {
    const end = i < chapters.length - 1 ? chapters[i + 1].start : text.length;
    return {
      title: ch.title,
      content: text.slice(ch.start, end).trim()
    };
  });
}

// --------------- 文本转 HTML ---------------
function textToHtml(text) {
  return text
    .split(/\n\n+/)
    .map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

// --------------- API 路由 ---------------

// 密码验证接口
app.post('/api/novels/check-password', (req, res) => {
  if (req.body.password === AUTH_PASSWORD) {
    res.json({ ok: true });
  } else {
    res.status(403).json({ error: '密码错误' });
  }
});

// 获取小说列表
app.get('/api/novels', (req, res) => {
  const novels = readData();
  const list = novels.map(n => ({
    id: n.id,
    title: n.title,
    author: n.author,
    synopsis: n.synopsis,
    tags: n.tags,
    chapterCount: n.chapters.length,
    totalWords: n.totalWords,
    createdAt: n.createdAt,
    coverColor: n.coverColor
  }));
  res.json(list);
});

// 获取单本小说详情（含章节列表，不含正文）
app.get('/api/novels/:id', (req, res) => {
  const novels = readData();
  const novel = novels.find(n => n.id === req.params.id);
  if (!novel) return res.status(404).json({ error: '小说不存在' });
  const result = { ...novel };
  result.chapters = novel.chapters.map(ch => ({
    title: ch.title,
    wordCount: ch.wordCount,
    index: ch.index
  }));
  res.json(result);
});

// 获取指定章节内容
app.get('/api/novels/:id/chapters/:index', (req, res) => {
  const novels = readData();
  const novel = novels.find(n => n.id === req.params.id);
  if (!novel) return res.status(404).json({ error: '小说不存在' });
  const chIndex = parseInt(req.params.index);
  const chapter = novel.chapters[chIndex];
  if (!chapter) return res.status(404).json({ error: '章节不存在' });
  const filePath = path.join(__dirname, 'novels', chapter.file);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: '章节文件丢失' });
  const content = fs.readFileSync(filePath, 'utf-8');
  res.json({
    title: chapter.title,
    content,
    wordCount: chapter.wordCount,
    index: chIndex,
    total: novel.chapters.length,
    novelTitle: novel.title
  });
});

// 上传小说
app.post('/api/novels', upload.single('file'), async (req, res) => {
  try {
    if (!checkPassword(req)) return res.status(403).json({ error: '密码错误，无权限操作' });
    if (!req.file) return res.status(400).json({ error: '请上传文件' });

    const { title, author, synopsis, tags } = req.body;
    if (!title) return res.status(400).json({ error: '请输入书名' });

    const filePath = req.file.path;
    const ext = path.extname(req.file.originalname).toLowerCase();
    let rawText = '';

    if (ext === '.docx') {
      const result = await mammoth.extractRawText({ path: filePath });
      rawText = result.value;
    } else {
      rawText = fs.readFileSync(filePath, 'utf-8');
    }

    if (!rawText.trim()) return res.status(400).json({ error: '文件内容为空' });

    const chapterHeaders = detectChapters(rawText);
    const chapterContents = splitContent(rawText, chapterHeaders);

    const novelId = uuidv4();
    const chapters = [];

    chapterContents.forEach((ch, i) => {
      const fileName = `${novelId}_ch${i}.html`;
      const htmlContent = textToHtml(ch.content);
      fs.writeFileSync(path.join(__dirname, 'novels', fileName), htmlContent, 'utf-8');
      chapters.push({
        index: i,
        title: ch.title,
        file: fileName,
        wordCount: ch.content.replace(/\s/g, '').length
      });
    });

    const totalWords = chapters.reduce((sum, ch) => sum + ch.wordCount, 0);

    const novel = {
      id: novelId,
      title: title.trim(),
      author: (author || '佚名').trim(),
      synopsis: (synopsis || '暂无简介').trim(),
      tags: tags ? tags.split(/[,，\s]+/).filter(Boolean) : [],
      chapters,
      totalWords,
      createdAt: new Date().toISOString(),
      coverColor: randomCoverColor()
    };

    const novels = readData();
    novels.unshift(novel);
    writeData(novels);

    res.json({ id: novelId, message: '上传成功', chapterCount: chapters.length });
  } catch (err) {
    console.error('上传失败:', err);
    res.status(500).json({ error: err.message || '上传失败' });
  }
});

// 删除小说
app.delete('/api/novels/:id', (req, res) => {
  if (!checkPassword(req)) return res.status(403).json({ error: '密码错误，无权限操作' });
  const novels = readData();
  const idx = novels.findIndex(n => n.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '小说不存在' });

  const novel = novels[idx];

  novel.chapters.forEach(ch => {
    const fp = path.join(__dirname, 'novels', ch.file);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  });

  novels.splice(idx, 1);
  writeData(novels);
  res.json({ message: '删除成功' });
});

// --------------- 工具 ---------------
function randomCoverColor() {
  const colors = [
    '#3b5998', '#8b4513', '#2e7d32', '#c62828', '#6a1b9a',
    '#00838f', '#e65100', '#4e342e', '#37474f', '#1a237e',
    '#b71c1c', '#004d40', '#311b92', '#827717', '#0d47a1'
  ];
  return colors[Math.floor(Math.random() * colors.length)];
}

// --------------- 启动 ---------------
app.listen(PORT, () => {
  console.log(`🌙 银月之庭已启动 -> http://localhost:${PORT}`);
  console.log(`   按 Ctrl+C 停止服务`);
});
