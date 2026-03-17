import { GoogleGenAI, Type } from "@google/genai";
import { db } from "../firebase";
import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

export interface SiteConfig {
  domain: string;
  selectors: {
    title: string;
    author: string;
    cover: string;
    description: string;
    chapterList: string;
    chapterTitle: string;
    chapterContent: string;
  };
  charset?: string;
}

export const getSiteConfig = async (domain: string): Promise<SiteConfig | null> => {
  const docRef = doc(db, "site_configs", domain);
  const docSnap = await getDoc(docRef);
  if (docSnap.exists()) {
    return docSnap.data() as SiteConfig;
  }
  return null;
};

export const saveSiteConfig = async (config: SiteConfig) => {
  const docRef = doc(db, "site_configs", config.domain);
  await setDoc(docRef, {
    ...config,
    updatedAt: serverTimestamp()
  });
};

export const generateSelectorsWithAI = async (url: string, htmlSnippet: string, apiKey?: string): Promise<SiteConfig['selectors']> => {
  if (!htmlSnippet) {
    throw new Error("Không thể lấy nội dung trang web để phân tích. Vui lòng kiểm tra lại URL hoặc thử lại sau.");
  }
  
  const finalApiKey = apiKey || localStorage.getItem('gemini_api_key') || process.env.GEMINI_API_KEY || "";
  if (!finalApiKey) {
    throw new Error("Thiếu Gemini API Key. Vui lòng cấu hình trong phần Cài đặt.");
  }

  const ai = new GoogleGenAI({ apiKey: finalApiKey });
  
  const prompt = `Analyze this HTML snippet from ${url} and extract CSS selectors for a novel website.
  Return ONLY a JSON object with these keys: title, author, cover, description, chapterList, chapterTitle, chapterContent.
  
  Guidelines:
  - title: The novel title.
  - author: The author name.
  - cover: The book cover image URL selector.
  - description: The novel introduction text.
  - chapterList: Selector for all chapter links (<a> tags) in the table of contents.
  - chapterTitle: The title of a single chapter page.
  - chapterContent: The main text content of a chapter (exclude ads, nav, etc).
  
  HTML Snippet:
  ${htmlSnippet.slice(0, 10000)}
  `;

  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          author: { type: Type.STRING },
          cover: { type: Type.STRING },
          description: { type: Type.STRING },
          chapterList: { type: Type.STRING },
          chapterTitle: { type: Type.STRING },
          chapterContent: { type: Type.STRING }
        },
        required: ["title", "chapterContent"]
      }
    }
  });

  return JSON.parse(response.text);
};

export const seedConfigs = async () => {
  const configs: SiteConfig[] = [
    {
      domain: "69shuba.com",
      selectors: {
        title: "h1.book-title",
        author: ".author a",
        cover: ".book-cover img",
        description: "#intro",
        chapterList: "#chapters a",
        chapterTitle: "h1",
        chapterContent: "#content"
      }
    },
    {
      domain: "piaotia.com",
      selectors: {
        title: "h1",
        author: "td:contains('作者')",
        cover: "img.cover",
        description: ".intro",
        chapterList: ".centent a",
        chapterTitle: "h1",
        chapterContent: "#content"
      }
    },
    {
      domain: "ptwxz.com",
      selectors: {
        title: "h1",
        author: "td:contains('作者')",
        cover: "img.cover",
        description: ".intro",
        chapterList: ".centent a",
        chapterTitle: "h1",
        chapterContent: "#content"
      }
    }
  ];

  for (const config of configs) {
    await saveSiteConfig(config);
  }
  console.log("Seeding complete!");
};

export const universalCrawl = async (url: string, type: 'info' | 'chapter', apiKey?: string) => {
  let targetUrl = url;
  
  const isChapterUrl = (u: string) => {
    try {
      const urlObj = new URL(u);
      const path = urlObj.pathname;
      const segments = path.split('/').filter(Boolean);
      
      // Common patterns
      if (u.includes('/chuong-') || u.includes('/chapter-') || u.match(/\/chuong\d+/) || u.match(/\/chapter\d+/)) return true;
      if (u.match(/\/\d+\.html$/)) return true;
      
      // Pattern like /truyen/name/novelId/chapterId/
      if (segments.length >= 4 && segments[segments.length - 1].match(/^\d+$/)) return true;
      
      return false;
    } catch (e) {
      return false;
    }
  };

  // If user pastes a chapter URL into "Quét" (info), try to find the novel main page
  if (type === 'info' && isChapterUrl(url)) {
    console.log(`Detected potential chapter URL for info request: ${url}`);
    
    // 1. Try simple stripping first
    const parts = url.split('/');
    let strippedUrl = url;
    if (parts[parts.length - 1] === '' || parts[parts.length - 1].match(/^\d+$/) || parts[parts.length - 1].match(/chuong|chapter/)) {
      strippedUrl = parts.slice(0, -2).join('/') + '/';
    } else if (parts[parts.length - 1].match(/chuong|chapter/)) {
      strippedUrl = parts.slice(0, -1).join('/') + '/';
    }
    
    // 2. Fetch the page to see if we can find a "Mục lục" link
    try {
      const htmlRes = await fetch('/api/get-html-snippet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });
      
      if (htmlRes.ok) {
        const { html } = await htmlRes.json();
        if (html) {
          // Look for "Mục lục" or similar links in the HTML
          const tocMatch = html.match(/href="([^"]+)"[^>]*>(?:Mục lục|Danh sách chương|Tất cả chương|Index|Table of Contents|返回目录|目录)/i);
          if (tocMatch) {
            const tocUrl = new URL(tocMatch[1], url).href;
            console.log(`Found TOC link on page: ${tocUrl}`);
            targetUrl = tocUrl;
          } else {
            // Fallback to stripped URL if no TOC link found
            targetUrl = strippedUrl;
          }
        }
      }
    } catch (e) {
      targetUrl = strippedUrl;
    }
    
    console.log(`Final target URL for info: ${targetUrl}`);
  }

  const domain = new URL(targetUrl).hostname.replace('www.', '');
  let config = await getSiteConfig(domain);

  if (!config) {
    console.log(`Config not found for ${domain}, generating with AI...`);
    // 1. Get HTML snippet from backend
    const htmlRes = await fetch('/api/get-html-snippet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: targetUrl })
    });
    
    if (!htmlRes.ok) {
      const errorData = await htmlRes.json();
      throw new Error(`Lỗi khi lấy dữ liệu trang web: ${errorData.error || htmlRes.statusText}`);
    }
    
    const { html } = await htmlRes.json();
    
    if (!html) {
      throw new Error("Không thể lấy nội dung HTML từ trang web này.");
    }
    
    // 2. Generate selectors with AI
    const selectors = await generateSelectorsWithAI(targetUrl, html, apiKey);
    config = { domain, selectors };
    
    // 3. Save to DB (optional: only if you want to cache it immediately)
    // await saveSiteConfig(config); 
  }

  // 4. Call universal crawl API
  const res = await fetch('/api/crawl', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: targetUrl, selectors: config.selectors, type })
  });
  
  if (!res.ok) {
    const errorData = await res.json();
    throw new Error(`Crawl failed: ${errorData.error || res.statusText}`);
  }
  return res.json();
};
