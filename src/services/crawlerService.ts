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

export const generateSelectorsWithAI = async (url: string, htmlSnippet: string): Promise<SiteConfig['selectors']> => {
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

export const universalCrawl = async (url: string, type: 'info' | 'chapter') => {
  const domain = new URL(url).hostname.replace('www.', '');
  let config = await getSiteConfig(domain);

  if (!config) {
    console.log(`Config not found for ${domain}, generating with AI...`);
    // 1. Get HTML snippet from backend
    const htmlRes = await fetch('/api/get-html-snippet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    const { html } = await htmlRes.json();
    
    // 2. Generate selectors with AI
    const selectors = await generateSelectorsWithAI(url, html);
    config = { domain, selectors };
    
    // 3. Save to DB (optional: only if you want to cache it immediately)
    // await saveSiteConfig(config); 
  }

  // 4. Call universal crawl API
  const res = await fetch('/api/crawl', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, selectors: config.selectors, type })
  });
  
  if (!res.ok) throw new Error("Crawl failed");
  return res.json();
};
