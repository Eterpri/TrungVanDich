import express from "express";
import axios from "axios";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const app = express();

// Initialize Gemini if key is provided
const serverApiKey = process.env.GEMINI_API_KEY;

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

const userAgents = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0",
  "Mozilla/5.0 (AppleWebKit/537.36; Chrome/122.0.0.0; Safari/537.36; Edge/122.0.0.0)"
];

const getScrapingHeaders = (targetUrl: string, retryCount: number = 0) => {
  const urlObj = new URL(targetUrl);
  return {
    "User-Agent": userAgents[retryCount % userAgents.length],
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8,vi;q=0.7",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Referer": urlObj.origin + "/",
    "Sec-Ch-Ua": '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1"
  };
};

const fetchWithRetry = async (targetUrl: string, options: any = {}) => {
  const maxRetries = 3;
  let lastError: any = null;

  for (let i = 0; i <= maxRetries; i++) {
    try {
      const response = await axios.get(targetUrl, {
        responseType: "arraybuffer",
        headers: getScrapingHeaders(targetUrl, i),
        timeout: 15000,
        maxRedirects: 5,
        validateStatus: (status) => status < 500,
        ...options
      });

      if (response.status === 403) {
        throw new Error("403 Forbidden - Website is blocking the request. This might be due to anti-scraping protection.");
      }

      if (response.status === 429) {
        throw new Error("429 Too Many Requests - Website is rate-limiting.");
      }

      return response;
    } catch (error: any) {
      lastError = error;
      console.error(`Attempt ${i + 1} failed for ${targetUrl}: ${error.message}`);
      if (i < maxRetries) {
        // Wait a bit before retry, increasing delay
        await new Promise(resolve => setTimeout(resolve, 1500 * (i + 1)));
      }
    }
  }
  throw lastError;
};

// API to fetch and parse Chinese novel content
app.post(["/api/fetch-novel", "/api/fetch-novel/"], async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL is required" });

  let targetUrl = url.trim();
  if (!targetUrl.startsWith("http")) {
    targetUrl = "https://" + targetUrl;
  }

  try {
    new URL(targetUrl);
  } catch (e) {
    return res.status(400).json({ error: "Định dạng URL không hợp lệ." });
  }

  try {
    const response = await fetchWithRetry(targetUrl);

    const contentType = response.headers["content-type"] || "";
    let charset = "utf-8";
    
    const charsetMatch = contentType.toString().match(/charset=([^;]+)/i);
    if (charsetMatch) {
      charset = charsetMatch[1].toLowerCase();
    } else {
      const gbkSites = ["69shu", "biquge", "xbiquge", "biqubao", "230book", "69shuba"];
      if (gbkSites.some(site => targetUrl.includes(site))) {
        charset = "gbk";
      }
    }

    const buffer = Buffer.from(response.data);
    let html = "";
    try {
      html = iconv.decode(buffer, charset);
    } catch (e) {
      html = iconv.decode(buffer, "utf-8");
    }
    
    if (!html || html.length < 10) {
      return res.status(500).json({ error: "Không thể giải mã nội dung trang web (Phản hồi trống)." });
    }

    const $ = cheerio.load(html);
    let title = $("h1").first().text().trim();
    if (!title) title = $(".title").first().text().trim();
    if (!title) title = $("title").text().split("_")[0].trim();

    let content = "";
    const contentSelectors = [
      ".txtnav", "#content", ".content", ".read-content", "#txt", ".txt", 
      ".post-content", ".article-content", "#chaptercontent", ".showtxt", ".chapter-content"
    ];

    for (const selector of contentSelectors) {
      const found = $(selector);
      if (found.length > 0) {
        found.find("script, ins, .ads, .ad, .bottom-ad, a, .navigation, style, iframe").remove();
        content = found.html() || "";
        if (content.trim().length > 100) break;
      }
    }

    if (!content || content.trim().length < 100) {
      let maxLen = 0;
      $("div, article, section").each((_, el) => {
        const $el = $(el);
        if ($el.is("nav, footer, header, script, style, aside, iframe")) return;
        const text = $el.text().trim();
        if (text.length > maxLen) {
          maxLen = text.length;
          content = $el.html() || "";
        }
      });
    }

    if (!content || content.trim().length < 50) {
      return res.status(404).json({ error: "Không tìm thấy nội dung truyện." });
    }

    return res.json({ title: title || "Không rõ tiêu đề", content, charset });
  } catch (error: any) {
    return res.status(500).json({ error: `Lỗi hệ thống khi tải trang: ${error.message}.` });
  }
});

// API to fetch novel metadata and chapter list
app.post("/api/novel-info", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL is required" });

  let targetUrl = url.trim();
  if (!targetUrl.startsWith("http")) targetUrl = "https://" + targetUrl;

  try {
    const gbkSites = ["69shu", "biquge", "xbiquge", "biqubao", "230book", "69shuba"];
    const isGBK = gbkSites.some(site => targetUrl.includes(site));

    const fetchPage = async (u: string) => {
      const resp = await fetchWithRetry(u);
      return iconv.decode(Buffer.from(resp.data), isGBK ? "gbk" : "utf-8");
    };

    let html = await fetchPage(targetUrl);
    let $ = cheerio.load(html);

    const isChapterPage = targetUrl.includes("/txt/") || $(".read-content").length > 0 || $("#content").length > 0;
    if (isChapterPage) {
      const tocLink = $("a:contains('目录'), a:contains('返回书页'), a:contains('返回目录')").first().attr("href");
      if (tocLink) {
        targetUrl = new URL(tocLink, targetUrl).href;
        html = await fetchPage(targetUrl);
        $ = cheerio.load(html);
      }
    }

    let title = $("h1").first().text().trim() || $(".bookname h1").text().trim();
    let author = $(".author, .writer, [itemprop='author'], .info i:contains('作者')").first().text().replace(/作者[:：]/, "").trim();
    let description = $(".description, .intro, #intro, [itemprop='description'], .nav_desc").first().text().trim();
    let cover = $(".cover img, .book-img img, [itemprop='image'], .bookimg img").first().attr("src");
    
    if (cover && !cover.startsWith("http")) {
      cover = new URL(cover, targetUrl).href;
    }

    const chapters: { title: string; url: string }[] = [];
    const chapterSelectors = [
      "ul.mu_uul li a", ".chapter-list a", "#list a", ".book-mulu a", 
      ".catalog a", "ul.list-charts a", ".quanshu-list a", ".box_con #list dl dd a"
    ];

    for (const selector of chapterSelectors) {
      $(selector).each((_, el) => {
        const $el = $(el);
        const cTitle = $el.text().trim();
        let cUrl = $el.attr("href");
        if (cUrl && cTitle && cTitle.length > 1) {
          if (!cUrl.startsWith("http")) cUrl = new URL(cUrl, targetUrl).href;
          chapters.push({ title: cTitle, url: cUrl });
        }
      });
      if (chapters.length > 0) break;
    }

    res.json({ title, author, description, cover, chapters: chapters.slice(0, 1000) });
  } catch (error: any) {
    res.status(500).json({ error: `Lỗi lấy thông tin truyện: ${error.message}` });
  }
});

// API to translate content using Gemini
app.post("/api/translate", async (req, res) => {
  const { text, apiKey: userApiKey } = req.body;
  if (!text) return res.status(400).json({ error: "Text is required" });
  
  const apiKey = userApiKey || serverApiKey;
  if (!apiKey) {
    return res.status(401).json({ 
      error: "Thiếu API Key. Vui lòng cấu hình GEMINI_API_KEY trong biến môi trường hoặc nhập key cá nhân trong cài đặt." 
    });
  }

  try {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: text,
      config: {
        systemInstruction: "Bạn là một dịch giả chuyên nghiệp từ tiếng Trung sang tiếng Việt. Hãy dịch nội dung chương truyện sau đây một cách mượt mà, thuần Việt, giữ đúng ngữ cảnh kiếm hiệp/tiên hiệp/ngôn tình. Loại bỏ các đoạn quảng cáo hoặc rác nếu có. Trả về định dạng Markdown."
      }
    });
    res.json({ text: response.text });
  } catch (error: any) {
    res.status(500).json({ error: `Lỗi dịch thuật: ${error.message}` });
  }
});

// API to fetch multiple chapters content
app.post("/api/scrape-chapters", async (req, res) => {
  const { urls } = req.body;
  if (!urls || !Array.isArray(urls)) return res.status(400).json({ error: "URLs array is required" });

  const results = [];
  for (const url of urls.slice(0, 100)) { 
    try {
      const gbkSites = ["69shu", "biquge", "xbiquge", "biqubao", "230book", "69shuba"];
      const isGBK = gbkSites.some(site => url.includes(site));

      const response = await fetchWithRetry(url);
      const html = iconv.decode(Buffer.from(response.data), isGBK ? "gbk" : "utf-8");
      const $ = cheerio.load(html);
      
      let content = "";
      const selectors = [".txtnav", "#content", ".content", ".read-content", "#txt", ".book_content"];
      for (const s of selectors) {
        const found = $(s);
        if (found.length > 0) {
          found.find("script, ins, .ads, .ad, style, a, .info, .title").remove();
          content = found.text().trim()
            .replace(/\s+/g, " ")
            .replace(/&nbsp;/g, " ")
            .replace(/\n\s*\n/g, "\n\n");
          if (content.length > 100) break;
        }
      }
      results.push({ url, content, title: $("h1").first().text().trim() || "Chương không tên" });
    } catch (e) {
      results.push({ url, error: true });
    }
  }
  res.json({ results });
});

// Catch-all for API routes
app.all("/api/*", (req, res) => {
  res.status(404).json({ error: `API endpoint ${req.method} ${req.url} not found` });
});

export default app;
