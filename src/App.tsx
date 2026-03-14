import React, { useState, useEffect, useRef } from 'react';
import { GoogleGenAI, GenerateContentResponse } from "@google/genai";
import { 
  Search, 
  BookOpen, 
  Languages, 
  Settings, 
  ChevronLeft, 
  ChevronRight, 
  Loader2, 
  Trash2, 
  History,
  Copy,
  Check,
  Download,
  ArrowUpDown,
  Volume2,
  VolumeX,
  ArrowLeft,
  ArrowRight,
  Play,
  Square,
  Type,
  Sun,
  Moon,
  Palette,
  Minus,
  Plus,
  Zap
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// Utility for tailwind classes
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Initialize Gemini
const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

interface HistoryItem {
  url: string;
  title: string;
  timestamp: number;
}

import JSZip from 'jszip';
import { saveAs } from 'file-saver';

interface Chapter {
  title: string;
  url: string;
}

interface Novel {
  url: string;
  title: string;
  author?: string;
  description?: string;
  cover?: string;
  chapters: Chapter[];
  timestamp: number;
}

export default function App() {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [novelData, setNovelData] = useState<{ title: string; content: string } | null>(null);
  const [translatedContent, setTranslatedContent] = useState('');
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [library, setLibrary] = useState<Novel[]>([]);
  const [selectedNovel, setSelectedNovel] = useState<Novel | null>(null);
  const [activeTab, setActiveTab] = useState<'reader' | 'library' | 'scraper'>('reader');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scrapingProgress, setScrapingProgress] = useState<{ current: number; total: number } | null>(null);
  const [rangeStart, setRangeStart] = useState<number>(1);
  const [rangeEnd, setRangeEnd] = useState<number>(50);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [preTranslated, setPreTranslated] = useState<Record<string, string>>({});
  const [readerTheme, setReaderTheme] = useState<'light' | 'dark' | 'sepia' | 'slate'>('light');
  const [readerFont, setReaderFont] = useState<'serif' | 'sans' | 'mono' | 'reading'>('reading');
  const [readerFontSize, setReaderFontSize] = useState(18);
  const [ttsRate, setTtsRate] = useState(1.0);
  const [showReaderSettings, setShowReaderSettings] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);

  // Load data from localStorage
  useEffect(() => {
    const savedHistory = localStorage.getItem('novel_history');
    if (savedHistory) setHistory(JSON.parse(savedHistory));
    
    const savedLibrary = localStorage.getItem('novel_library');
    if (savedLibrary) setLibrary(JSON.parse(savedLibrary));

    const savedCache = localStorage.getItem('novel_cache');
    if (savedCache) setPreTranslated(JSON.parse(savedCache));

    fetch('/api/health')
      .then(res => res.json())
      .then(data => console.log("Backend health:", data))
      .catch(err => console.error("Backend health check failed:", err));
  }, []);

  const saveToLibrary = (novel: Novel) => {
    const updated = [novel, ...library.filter(n => n.url !== novel.url)].slice(0, 50);
    setLibrary(updated);
    localStorage.setItem('novel_library', JSON.stringify(updated));
  };

  const removeFromLibrary = (url: string) => {
    const updated = library.filter(n => n.url !== url);
    setLibrary(updated);
    localStorage.setItem('novel_library', JSON.stringify(updated));
  };

  const updateCache = (url: string, content: string) => {
    setPreTranslated(prev => {
      const updated = { ...prev, [url]: content };
      // Keep only last 50 entries to save space in localStorage
      const keys = Object.keys(updated);
      if (keys.length > 50) {
        delete updated[keys[0]];
      }
      localStorage.setItem('novel_cache', JSON.stringify(updated));
      return updated;
    });
  };

  const fetchNovelInfo = async (targetUrl: string) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/novel-info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: targetUrl }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Lỗi lấy thông tin truyện');
      
      const novel: Novel = { ...data, url: targetUrl, timestamp: Date.now() };
      setSelectedNovel(novel);
      setRangeStart(1);
      setRangeEnd(Math.min(data.chapters.length, 50));
      saveToLibrary(novel);
      setActiveTab('scraper');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const reverseChapters = () => {
    if (!selectedNovel) return;
    const reversed = [...selectedNovel.chapters].reverse();
    const updatedNovel = { ...selectedNovel, chapters: reversed };
    setSelectedNovel(updatedNovel);
    // Update in library too if it exists
    const updatedLibrary = library.map(n => n.url === selectedNovel.url ? updatedNovel : n);
    setLibrary(updatedLibrary);
    localStorage.setItem('novel_library', JSON.stringify(updatedLibrary));
  };

  const bulkScrape = async (novel: Novel, startIdx: number, endIdx: number) => {
    if (startIdx < 0) startIdx = 0;
    if (endIdx >= novel.chapters.length) endIdx = novel.chapters.length - 1;
    if (startIdx > endIdx) {
      setError("Khoảng chương không hợp lệ");
      return;
    }

    const chaptersToScrape = novel.chapters.slice(startIdx, endIdx + 1);
    const zip = new JSZip();
    setScrapingProgress({ current: 0, total: chaptersToScrape.length });

    try {
      // Process in batches of 20
      for (let i = 0; i < chaptersToScrape.length; i += 20) {
        const batch = chaptersToScrape.slice(i, i + 20);
        const response = await fetch('/api/scrape-chapters', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ urls: batch.map(c => c.url) }),
        });
        
        if (!response.ok) throw new Error("Lỗi kết nối máy chủ");
        
        const data = await response.json();
        
        data.results.forEach((res: any, idx: number) => {
          if (!res.error) {
            // Use original chapter index for filename
            const originalIdx = startIdx + i + idx + 1;
            const fileName = `Chuong_${originalIdx.toString().padStart(4, '0')}_${res.title || 'Chapter'}.txt`;
            zip.file(fileName, res.content);
          }
        });
        
        setScrapingProgress({ current: Math.min(i + 20, chaptersToScrape.length), total: chaptersToScrape.length });
      }

      const content = await zip.generateAsync({ type: "blob" });
      saveAs(content, `${novel.title}_Chuong_${startIdx + 1}-${endIdx + 1}.zip`);
    } catch (err: any) {
      setError("Lỗi cào dữ liệu: " + err.message);
    } finally {
      setScrapingProgress(null);
    }
  };

  const fetchNovel = async (targetUrl: string) => {
    if (synth) synth.cancel();
    setIsSpeaking(false);
    
    setLoading(true);
    setError(null);
    setNovelData(null);
    
    // Check cache first
    if (preTranslated[targetUrl]) {
      setTranslatedContent(preTranslated[targetUrl]);
    } else {
      setTranslatedContent('');
    }
    
    setActiveTab('reader');
    
    try {
      const response = await fetch('/api/fetch-novel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: targetUrl }),
      });

      const contentType = response.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
        const text = await response.text();
        throw new Error(`Máy chủ phản hồi không đúng định dạng. Nội dung: ${text.slice(0, 50)}...`);
      }

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Lỗi tải truyện');
      
      setNovelData(data);
      saveToHistory(data.title || 'Truyện không tên', targetUrl);

      // Auto translate if not in cache
      if (!preTranslated[targetUrl]) {
        const translated = await translateContent(data.content);
        if (translated) {
          setTranslatedContent(translated);
          updateCache(targetUrl, translated);
          // Pre-translate next chapter
          preTranslateNext(targetUrl);
        }
      } else {
        setTranslatedContent(preTranslated[targetUrl]);
        // Even if cached, we might want to pre-translate the NEXT one
        preTranslateNext(targetUrl);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const saveToHistory = (title: string, url: string) => {
    const newItem = { title, url, timestamp: Date.now() };
    const updated = [newItem, ...history.filter(h => h.url !== url)].slice(0, 10);
    setHistory(updated);
    localStorage.setItem('novel_history', JSON.stringify(updated));
  };

  const preTranslateNext = async (currentUrl: string) => {
    // Find current novel in library or selectedNovel
    const novel = selectedNovel || library.find(n => n.chapters.some(c => c.url === currentUrl));
    if (!novel) return;

    const currentIndex = novel.chapters.findIndex(c => c.url === currentUrl);
    if (currentIndex !== -1 && currentIndex < novel.chapters.length - 1) {
      const nextChapter = novel.chapters[currentIndex + 1];
      if (!preTranslated[nextChapter.url]) {
        console.log("Pre-translating next chapter:", nextChapter.title);
        try {
          const response = await fetch('/api/fetch-novel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: nextChapter.url }),
          });
          const data = await response.json();
          if (data.content) {
            const translated = await translateContent(data.content, true);
            if (translated) {
              updateCache(nextChapter.url, translated);
            }
          }
        } catch (e) {
          console.error("Pre-translation failed", e);
        }
      }
    }
  };

  const translateContent = async (content?: string, isSilent = false) => {
    const textToTranslate = content || novelData?.content;
    if (!textToTranslate) return null;
    
    if (!isSilent) setTranslating(true);
    
    try {
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = textToTranslate;
      const cleanText = tempDiv.innerText;

      const response = await genAI.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: cleanText,
        config: {
          systemInstruction: "Bạn là một dịch giả chuyên nghiệp từ tiếng Trung sang tiếng Việt. Hãy dịch nội dung chương truyện sau đây một cách mượt mà, thuần Việt, giữ đúng ngữ cảnh kiếm hiệp/tiên hiệp/ngôn tình. Loại bỏ các đoạn quảng cáo hoặc rác nếu có. Trả về định dạng Markdown."
        }
      });

      const result = response.text || '';
      if (!isSilent) setTranslatedContent(result);
      return result;
    } catch (err: any) {
      if (!isSilent) setError("Lỗi dịch thuật: " + err.message);
      return null;
    } finally {
      if (!isSilent) setTranslating(false);
    }
  };

  const toggleSpeak = () => {
    if (!synth) return;

    if (isSpeaking) {
      synth.cancel();
      setIsSpeaking(false);
      return;
    }

    if (!translatedContent) return;

    // Clean markdown for better speech
    const cleanText = translatedContent
      .replace(/[#*`]/g, '')
      .replace(/\[.*?\]\(.*?\)/g, '');

    const utterance = new SpeechSynthesisUtterance(cleanText);
    utterance.lang = 'vi-VN';
    utterance.rate = ttsRate;
    utterance.onend = () => setIsSpeaking(false);
    utterance.onerror = () => setIsSpeaking(false);
    
    utteranceRef.current = utterance;
    setIsSpeaking(true);
    synth.speak(utterance);
  };

  const getNavigation = () => {
    if (!novelData) return { prev: null, next: null };
    
    // Try to find current chapter in selectedNovel or library
    const currentUrl = history[0]?.url; // This is a bit risky but usually works
    const novel = selectedNovel || library.find(n => n.chapters.some(c => c.url === currentUrl));
    
    if (!novel) return { prev: null, next: null };
    
    const index = novel.chapters.findIndex(c => c.url === currentUrl);
    return {
      prev: index > 0 ? novel.chapters[index - 1] : null,
      next: index < novel.chapters.length - 1 ? novel.chapters[index + 1] : null
    };
  };

  const copyToClipboard = () => {
    navigator.clipboard.writeText(translatedContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="min-h-screen bg-[#FDFCFB] text-[#1A1A1A] font-sans selection:bg-orange-100">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-white/80 backdrop-blur-md border-b border-black/5 px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between gap-4">
          <div className="flex items-center gap-2 flex-shrink-0">
            <div className="w-10 h-10 bg-orange-600 rounded-xl flex items-center justify-center text-white shadow-lg shadow-orange-200">
              <Languages size={24} />
            </div>
            <div className="hidden sm:block">
              <h1 className="font-bold text-lg tracking-tight">TrungVăn Dịch</h1>
              <p className="text-[10px] uppercase tracking-widest text-black/40 font-semibold">AI Powered Translator</p>
            </div>
          </div>
          
          <div className="flex-1 max-w-xl">
            <div className="relative group">
              <input 
                type="text" 
                placeholder="Dán link chương hoặc link truyện..." 
                className="w-full bg-black/5 border-transparent focus:bg-white focus:border-orange-500/30 focus:ring-4 focus:ring-orange-500/5 rounded-2xl py-3 pl-12 pr-24 transition-all outline-none text-sm"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && (url.includes('txt') || url.includes('chapter') ? fetchNovel(url) : fetchNovelInfo(url))}
              />
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-black/30 group-focus-within:text-orange-500 transition-colors" size={18} />
              <div className="absolute right-2 top-1/2 -translate-y-1/2 flex gap-1">
                <button 
                  onClick={() => fetchNovel(url)}
                  disabled={loading || !url}
                  className="bg-orange-600 hover:bg-orange-700 disabled:bg-black/10 text-white px-3 py-1.5 rounded-xl text-xs font-bold transition-all"
                >
                  Đọc
                </button>
                <button 
                  onClick={() => fetchNovelInfo(url)}
                  disabled={loading || !url}
                  className="bg-black hover:bg-black/80 disabled:bg-black/10 text-white px-3 py-1.5 rounded-xl text-xs font-bold transition-all"
                >
                  Quét
                </button>
              </div>
            </div>
          </div>

          <nav className="flex items-center gap-1 bg-black/5 p-1 rounded-2xl">
            <button 
              onClick={() => setActiveTab('reader')}
              className={cn("px-4 py-2 rounded-xl text-xs font-bold transition-all", activeTab === 'reader' ? "bg-white text-orange-600 shadow-sm" : "text-black/40 hover:text-black")}
            >
              Đọc
            </button>
            <button 
              onClick={() => setActiveTab('library')}
              className={cn("px-4 py-2 rounded-xl text-xs font-bold transition-all", activeTab === 'library' ? "bg-white text-orange-600 shadow-sm" : "text-black/40 hover:text-black")}
            >
              Tủ sách
            </button>
          </nav>
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-6">
        {error && (
          <div className="mb-6 bg-red-50 border border-red-100 text-red-600 p-4 rounded-2xl text-sm flex items-center gap-3">
            <div className="w-8 h-8 bg-red-100 rounded-full flex items-center justify-center flex-shrink-0">!</div>
            {error}
          </div>
        )}

        {activeTab === 'reader' && (
          <div className="space-y-6">
            <div className="flex justify-end">
              <button 
                onClick={() => setShowHistory(!showHistory)}
                className={cn(
                  "flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all border",
                  showHistory 
                    ? "bg-black text-white border-black" 
                    : "bg-white text-black border-black/10 hover:border-black/20"
                )}
              >
                <History size={14} />
                {showHistory ? "Ẩn lịch sử" : "Hiện lịch sử"}
              </button>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
              {/* Sidebar */}
              {showHistory && (
                <aside className="lg:col-span-3 space-y-6 animate-in fade-in slide-in-from-left-4 duration-300">
                  <section className="bg-white rounded-3xl p-6 border border-black/5 shadow-sm">
                    <div className="flex items-center justify-between mb-4">
                      <h2 className="text-xs font-bold uppercase tracking-widest text-black/40 flex items-center gap-2">
                        <History size={14} /> Lịch sử
                      </h2>
                      <button 
                        onClick={() => { setHistory([]); localStorage.removeItem('novel_history'); }}
                        className="text-black/30 hover:text-red-500 transition-colors"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                    <div className="space-y-2 max-h-[600px] overflow-y-auto pr-2 scrollbar-thin">
                      {history.length > 0 ? history.map((item, i) => (
                        <button 
                          key={i}
                          onClick={() => fetchNovel(item.url)}
                          className="w-full text-left p-3 rounded-2xl hover:bg-orange-50 group transition-all"
                        >
                          <p className="text-sm font-medium line-clamp-1 group-hover:text-orange-700">{item.title}</p>
                          <p className="text-[10px] text-black/30 truncate">{new URL(item.url).hostname}</p>
                        </button>
                      )) : (
                        <p className="text-xs text-black/20 italic py-4 text-center">Chưa có lịch sử</p>
                      )}
                    </div>
                  </section>
                </aside>
              )}

              {/* Reader Content */}
              <div className={cn(
                "transition-all duration-300",
                showHistory ? "lg:col-span-9" : "lg:col-span-12"
              )}>
              {novelData ? (
                <div className={cn(
                  "rounded-[2rem] p-8 border shadow-sm transition-all relative overflow-hidden",
                  readerTheme === 'light' ? "bg-white border-black/5" : 
                  readerTheme === 'dark' ? "bg-[#121212] border-white/10 text-white" :
                  readerTheme === 'sepia' ? "bg-[#f4ecd8] border-[#5b4636]/10 text-[#5b4636]" :
                  "bg-[#1e293b] border-white/10 text-white"
                )}>
                  {/* Settings Overlay */}
                  {showReaderSettings && (
                    <div className="absolute top-20 right-8 z-20 w-72 bg-white dark:bg-slate-800 rounded-3xl shadow-2xl border border-black/5 p-6 animate-in slide-in-from-top-4 duration-200">
                      <div className="space-y-6">
                        {/* Font Size */}
                        <div>
                          <label className="text-[10px] uppercase font-bold text-black/40 mb-3 block">Kích thước chữ</label>
                          <div className="flex items-center justify-between bg-black/5 rounded-xl p-1">
                            <button onClick={() => setReaderFontSize(Math.max(12, readerFontSize - 2))} className="p-2 hover:bg-white rounded-lg transition-all"><Minus size={14} /></button>
                            <span className="text-sm font-bold">{readerFontSize}px</span>
                            <button onClick={() => setReaderFontSize(Math.min(32, readerFontSize + 2))} className="p-2 hover:bg-white rounded-lg transition-all"><Plus size={14} /></button>
                          </div>
                        </div>

                        {/* Themes */}
                        <div>
                          <label className="text-[10px] uppercase font-bold text-black/40 mb-3 block">Giao diện</label>
                          <div className="grid grid-cols-4 gap-2">
                            {[
                              { id: 'light', color: 'bg-white', icon: <Sun size={14} /> },
                              { id: 'dark', color: 'bg-[#121212]', icon: <Moon size={14} /> },
                              { id: 'sepia', color: 'bg-[#f4ecd8]', icon: <Palette size={14} /> },
                              { id: 'slate', color: 'bg-[#1e293b]', icon: <Zap size={14} /> },
                            ].map(t => (
                              <button 
                                key={t.id}
                                onClick={() => setReaderTheme(t.id as any)}
                                className={cn(
                                  "h-10 rounded-xl border flex items-center justify-center transition-all",
                                  t.color,
                                  readerTheme === t.id ? "ring-2 ring-orange-500 border-transparent" : "border-black/5"
                                )}
                              >
                                <span className={cn(t.id === 'light' ? 'text-black' : 'text-white')}>{t.icon}</span>
                              </button>
                            ))}
                          </div>
                        </div>

                        {/* Fonts */}
                        <div>
                          <label className="text-[10px] uppercase font-bold text-black/40 mb-3 block">Phông chữ</label>
                          <div className="grid grid-cols-2 gap-2">
                            {[
                              { id: 'reading', label: 'Literata' },
                              { id: 'serif', label: 'Baskerville' },
                              { id: 'sans', label: 'Inter' },
                              { id: 'mono', label: 'JetBrains' },
                            ].map(f => (
                              <button 
                                key={f.id}
                                onClick={() => setReaderFont(f.id as any)}
                                className={cn(
                                  "py-2 rounded-xl border text-xs font-medium transition-all",
                                  readerFont === f.id ? "bg-orange-600 text-white border-transparent" : "bg-black/5 border-transparent hover:bg-black/10 text-black"
                                )}
                              >
                                {f.label}
                              </button>
                            ))}
                          </div>
                        </div>

                        {/* TTS Speed */}
                        <div>
                          <label className="text-[10px] uppercase font-bold text-black/40 mb-3 block">Tốc độ đọc: {ttsRate}x</label>
                          <input 
                            type="range" 
                            min="0.5" 
                            max="2.0" 
                            step="0.1" 
                            value={ttsRate} 
                            onChange={(e) => setTtsRate(parseFloat(e.target.value))}
                            className="w-full h-1 bg-black/10 rounded-lg appearance-none cursor-pointer accent-orange-600"
                          />
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="flex items-center justify-between mb-8">
                    <div className="flex flex-col gap-1">
                      <h2 className="text-2xl font-serif font-bold italic">{novelData.title}</h2>
                      {getNavigation().next && (
                        <span className="text-[10px] text-orange-600 font-bold animate-pulse">
                          Đã chuẩn bị sẵn chương tiếp theo
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3">
                      <button 
                        onClick={() => setShowReaderSettings(!showReaderSettings)}
                        className={cn(
                          "p-2.5 rounded-2xl transition-all flex items-center gap-2",
                          showReaderSettings ? "bg-black text-white" : "bg-black/5 text-black hover:bg-black/10"
                        )}
                      >
                        <Settings size={16} />
                      </button>
                      <button 
                        onClick={toggleSpeak}
                        disabled={!translatedContent}
                        className={cn(
                          "p-2.5 rounded-2xl transition-all flex items-center gap-2 text-sm font-bold",
                          isSpeaking 
                            ? "bg-red-500 text-white hover:bg-red-600" 
                            : "bg-orange-100 text-orange-700 hover:bg-orange-200"
                        )}
                        title={isSpeaking ? "Dừng đọc" : "Đọc bằng giọng nói"}
                      >
                        {isSpeaking ? <Square size={16} /> : <Play size={16} />}
                        {isSpeaking ? "Dừng" : "Nghe"}
                      </button>
                      <button 
                        onClick={() => translateContent()}
                        disabled={translating}
                        className="bg-black text-white px-6 py-2.5 rounded-2xl text-sm font-bold flex items-center gap-2 hover:bg-black/80 transition-all disabled:bg-black/40"
                      >
                        {translating ? <Loader2 className="animate-spin" size={16} /> : <Languages size={16} />}
                        {translating ? 'Đang dịch...' : 'Dịch lại'}
                      </button>
                    </div>
                  </div>
                  
                  <div className="max-w-3xl mx-auto">
                    <div className="space-y-6">
                      <div className={cn(
                        "prose prose-lg max-w-none leading-relaxed transition-all rounded-2xl min-h-[600px]",
                        translating ? "animate-pulse opacity-50" : "",
                        readerFont === 'reading' ? 'font-reading' : 
                        readerFont === 'serif' ? 'font-serif' : 
                        readerFont === 'mono' ? 'font-mono' : 'font-sans'
                      )}
                      style={{ fontSize: `${readerFontSize}px` }}
                      >
                        {translatedContent ? (
                          <div className="markdown-body">
                            <ReactMarkdown>{translatedContent}</ReactMarkdown>
                          </div>
                        ) : (
                          <div className="flex flex-col items-center justify-center h-[400px] text-black/10 italic">
                            <Loader2 className="animate-spin mb-4" size={32} />
                            <p>Đang chuẩn bị bản dịch...</p>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Navigation Footer */}
                  <div className={cn(
                    "flex items-center justify-between pt-8 border-t mt-12",
                    readerTheme === 'light' ? "border-black/5" : "border-white/10"
                  )}>
                    <button 
                      onClick={() => getNavigation().prev && fetchNovel(getNavigation().prev!.url)}
                      disabled={!getNavigation().prev || loading}
                      className={cn(
                        "flex items-center gap-2 px-6 py-3 rounded-2xl text-sm font-bold transition-all disabled:opacity-30",
                        readerTheme === 'light' ? "bg-black/5 hover:bg-black/10" : "bg-white/5 hover:bg-white/10"
                      )}
                    >
                      <ArrowLeft size={18} />
                      Chương trước
                    </button>
                    <button 
                      onClick={() => getNavigation().next && fetchNovel(getNavigation().next!.url)}
                      disabled={!getNavigation().next || loading}
                      className="flex items-center gap-2 px-8 py-3 rounded-2xl bg-orange-600 hover:bg-orange-700 text-white text-sm font-bold transition-all disabled:opacity-30 shadow-lg shadow-orange-500/20"
                    >
                      Chương sau
                      <ArrowRight size={18} />
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-24 text-center text-black/20">
                  <BookOpen size={64} />
                  <p className="mt-4 font-bold">Dán link chương truyện để bắt đầu đọc</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {activeTab === 'library' && (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-bold">Tủ sách của bạn</h2>
              <button 
                onClick={() => { setLibrary([]); localStorage.removeItem('novel_library'); }}
                className="text-xs font-bold text-red-500 hover:text-red-600 flex items-center gap-1"
              >
                <Trash2 size={14} /> Xóa tất cả
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
            {library.map((novel, i) => (
              <div key={i} className="bg-white rounded-[2rem] overflow-hidden border border-black/5 shadow-sm group hover:shadow-xl hover:shadow-orange-500/5 transition-all">
                <div className="aspect-[3/4] bg-black/5 relative">
                  {novel.cover ? (
                    <img src={novel.cover} alt={novel.title} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-black/10"><BookOpen size={48} /></div>
                  )}
                  <button 
                    onClick={() => removeFromLibrary(novel.url)}
                    className="absolute top-4 right-4 p-2 bg-white/80 backdrop-blur-md rounded-full text-red-500 opacity-0 group-hover:opacity-100 transition-all"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
                <div className="p-6 space-y-2">
                  <h3 className="font-bold line-clamp-1">{novel.title}</h3>
                  <p className="text-xs text-black/40 font-medium">{novel.author || 'Ẩn danh'}</p>
                  <div className="flex gap-2 pt-4">
                    <button 
                      onClick={() => { setSelectedNovel(novel); setActiveTab('scraper'); }}
                      className="flex-1 bg-black text-white py-2 rounded-xl text-xs font-bold hover:bg-black/80 transition-all"
                    >
                      Chi tiết
                    </button>
                    <button 
                      onClick={() => { setUrl(novel.url); fetchNovel(novel.url); }}
                      className="flex-1 bg-orange-600 text-white py-2 rounded-xl text-xs font-bold hover:bg-orange-700 transition-all"
                    >
                      Đọc tiếp
                    </button>
                  </div>
                </div>
              </div>
            ))}
            {library.length === 0 && (
              <div className="col-span-full py-24 text-center text-black/20">
                <BookOpen size={64} className="mx-auto mb-4" />
                <p className="font-bold">Tủ sách đang trống</p>
                <p className="text-sm">Quét link truyện để lưu vào tủ sách</p>
              </div>
            )}
            </div>
          </div>
        )}

        {activeTab === 'scraper' && selectedNovel && (
          <div className="bg-white rounded-[2rem] p-8 border border-black/5 shadow-sm space-y-8">
            <div className="flex flex-col md:flex-row gap-8">
              <div className="w-48 h-64 bg-black/5 rounded-2xl overflow-hidden flex-shrink-0 shadow-lg">
                <img src={selectedNovel.cover} alt={selectedNovel.title} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
              </div>
              <div className="space-y-4 flex-1">
                <h2 className="text-3xl font-bold">{selectedNovel.title}</h2>
                <p className="text-orange-600 font-bold">{selectedNovel.author}</p>
                <p className="text-sm text-black/60 leading-relaxed line-clamp-4">{selectedNovel.description}</p>
                <div className="flex gap-4">
                  <div className="bg-black/5 px-4 py-2 rounded-xl">
                    <p className="text-[10px] uppercase font-bold text-black/30">Tổng chương</p>
                    <p className="font-bold">{selectedNovel.chapters.length}</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="border-t border-black/5 pt-8">
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6">
                <div className="flex items-center gap-4">
                  <h3 className="font-bold flex items-center gap-2"><BookOpen size={18} /> Danh sách chương</h3>
                  <button 
                    onClick={reverseChapters}
                    className="flex items-center gap-1 px-3 py-1.5 bg-orange-100 hover:bg-orange-200 text-orange-700 rounded-lg text-[10px] font-bold transition-all"
                    title="Đảo ngược thứ tự danh sách (Dùng khi web hiển thị chương mới lên đầu)"
                  >
                    <ArrowUpDown size={14} />
                    ĐẢO THỨ TỰ GỐC
                  </button>
                </div>
                
                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex items-center gap-2 bg-black/5 p-1 rounded-xl">
                    <input 
                      type="number" 
                      min={1} 
                      max={selectedNovel.chapters.length}
                      value={rangeStart}
                      onChange={(e) => setRangeStart(Number(e.target.value))}
                      className="w-16 bg-white border-none rounded-lg px-2 py-1 text-xs font-bold focus:ring-2 focus:ring-orange-500 outline-none"
                    />
                    <span className="text-[10px] font-bold text-black/30">ĐẾN</span>
                    <input 
                      type="number" 
                      min={rangeStart} 
                      max={selectedNovel.chapters.length}
                      value={rangeEnd}
                      onChange={(e) => setRangeEnd(Number(e.target.value))}
                      className="w-16 bg-white border-none rounded-lg px-2 py-1 text-xs font-bold focus:ring-2 focus:ring-orange-500 outline-none"
                    />
                  </div>

                  <button 
                    onClick={() => bulkScrape(selectedNovel, rangeStart - 1, rangeEnd - 1)}
                    disabled={!!scrapingProgress}
                    className="bg-orange-600 text-white px-4 py-2 rounded-xl text-xs font-bold hover:bg-orange-700 transition-all disabled:bg-black/10 flex items-center gap-2"
                  >
                    <Download size={14} />
                    {scrapingProgress ? `Đang tải...` : 'Tải đoạn chọn'}
                  </button>

                  <button 
                    onClick={() => bulkScrape(selectedNovel, 0, selectedNovel.chapters.length - 1)}
                    disabled={!!scrapingProgress}
                    className="bg-black text-white px-4 py-2 rounded-xl text-xs font-bold hover:bg-black/80 transition-all disabled:bg-black/10 flex items-center gap-2"
                  >
                    <Download size={14} />
                    Tải tất cả
                  </button>
                </div>
              </div>

              {scrapingProgress && (
                <div className="mb-6 bg-orange-50 rounded-2xl p-4 border border-orange-100">
                  <div className="flex justify-between text-[10px] font-bold uppercase tracking-widest text-orange-600 mb-2">
                    <span>Tiến độ tải chương</span>
                    <span>{Math.round((scrapingProgress.current / scrapingProgress.total) * 100)}%</span>
                  </div>
                  <div className="w-full h-2 bg-orange-200 rounded-full overflow-hidden">
                    <div 
                      className="h-full bg-orange-600 transition-all duration-300" 
                      style={{ width: `${(scrapingProgress.current / scrapingProgress.total) * 100}%` }}
                    />
                  </div>
                  <p className="text-[10px] mt-2 text-orange-600/70 font-medium">Đang xử lý: {scrapingProgress.current} / {scrapingProgress.total} chương</p>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2 max-h-[400px] overflow-y-auto pr-4">
                {selectedNovel.chapters.map((chapter, i) => (
                  <button 
                    key={i}
                    onClick={() => fetchNovel(chapter.url)}
                    className="text-left p-3 rounded-xl hover:bg-orange-50 text-xs font-medium transition-all truncate border border-transparent hover:border-orange-200 flex items-center gap-2"
                  >
                    <span className="text-[10px] text-black/30 font-mono flex-shrink-0 w-8">{(i + 1).toString().padStart(3, '0')}</span>
                    <span className="truncate">{chapter.title}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="max-w-6xl mx-auto p-12 text-center border-t border-black/5 mt-12">
        <p className="text-xs text-black/30 font-medium">
          &copy; 2026 TrungVăn Dịch. Sử dụng công nghệ Google Gemini AI.
        </p>
      </footer>
    </div>
  );
}
