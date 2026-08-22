import { useEffect, useRef, useState } from "react";
import { getSettings, type Settings } from "../../../configs/settings.js";
import { abortCliAgent, queryCliAgent, streamCliAgent } from "../lib/api";
import {
  ChatIcon,
  CrossIcon,
  PinIcon,
  SearchIcon,
  SendIcon,
  SparklesIcon,
  StopIcon,
  TrashIcon,
  WrenchIcon,
} from "./Icons";

interface AttachedContext {
  url: string;
  title: string;
  selectionText?: string;
  compactSummary?: string;
}

interface ToolCallStatus {
  name: string;
  isError?: boolean;
  done: boolean;
}

interface LocalChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  url?: string;
  title?: string;
  selectionText?: string;
  commandUsed?: string;
  durationMs?: number;
  toolCalls?: ToolCallStatus[];
  createdAt: number;
}

const STORAGE_CHAT_KEY = "browsercontrol_local_chat";
const STORAGE_SESSION_KEY = "browsercontrol_local_chat_session";

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit" });
}

async function captureActiveTabContext(): Promise<AttachedContext | null> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url) return null;

    const url = tab.url;
    const title = tab.title || "Active Page";

    let selectionText = "";
    let compactSummary = "";

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const sel = window.getSelection()?.toString()?.trim() || "";
          const h1 = document.querySelector("h1")?.textContent?.trim() || "";
          const metaDesc = document.querySelector('meta[name="description"]')?.getAttribute("content") || "";

          let bodySnippet = "";
          if (document.body) {
            const clone = document.body.cloneNode(true) as HTMLElement;
            const noise = clone.querySelectorAll("script, style, noscript, svg, iframe, nav, footer");
            noise.forEach((n) => n.remove());
            bodySnippet = (clone.innerText || clone.textContent || "").replace(/\s+/g, " ").trim().slice(0, 3000);
          }

          return {
            selection: sel,
            h1,
            metaDesc,
            bodySnippet,
          };
        },
      });

      const res = results?.[0]?.result;
      if (res) {
        selectionText = res.selection;
        const parts: string[] = [];
        if (res.h1) parts.push(`Heading: ${res.h1}`);
        if (res.metaDesc) parts.push(`Description: ${res.metaDesc}`);
        if (res.bodySnippet) parts.push(`Page Content:\n${res.bodySnippet}`);
        compactSummary = parts.join("\n\n");
      }
    } catch {}

    return {
      url,
      title,
      selectionText: selectionText || undefined,
      compactSummary: compactSummary || undefined,
    };
  } catch (e) {
    console.error("[ChatTab] Failed to capture active tab context:", e);
    return null;
  }
}

export function ChatTab() {
  const [messages, setMessages] = useState<LocalChatMessage[]>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_CHAT_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });

  const [settings, setSettings] = useState<Settings | null>(null);
  const [inputText, setInputText] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [attachedContext, setAttachedContext] = useState<AttachedContext | null>(null);
  const [pinging, setPinging] = useState(false);
  const [sessionId, setSessionId] = useState<string | undefined>(() => {
    try {
      return localStorage.getItem(STORAGE_SESSION_KEY) || undefined;
    } catch {
      return undefined;
    }
  });

  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void getSettings().then(setSettings);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_CHAT_KEY, JSON.stringify(messages));
    } catch {}
  }, [messages]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  async function handleManualPing() {
    setPinging(true);
    const ctx = await captureActiveTabContext();
    if (ctx) setAttachedContext(ctx);
    setPinging(false);
  }

  async function handleSendMessage(customPrompt?: string) {
    const textToSend = customPrompt ?? inputText;
    if (!textToSend.trim() && !attachedContext) return;

    setIsProcessing(true);

    // Auto-capture active tab context if not manually attached
    let ctx = attachedContext;
    if (!ctx) {
      ctx = await captureActiveTabContext();
    }

    const finalPrompt = textToSend.trim() || `Tóm tắt nội dung chính của trang này: ${ctx?.title}`;

    const userMsg: LocalChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: finalPrompt,
      url: ctx?.url,
      title: ctx?.title,
      selectionText: ctx?.selectionText,
      createdAt: Date.now(),
    };

    const assistantMsgId = `ai-${Date.now()}`;
    const assistantMsg: LocalChatMessage = {
      id: assistantMsgId,
      role: "assistant",
      content: "",
      createdAt: Date.now(),
    };

    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setInputText("");
    setAttachedContext(null);

    const rememberSession = (id: string) => {
      setSessionId(id);
      try {
        localStorage.setItem(STORAGE_SESSION_KEY, id);
      } catch {}
    };

    try {
      await streamCliAgent(
        {
          prompt: finalPrompt,
          url: ctx?.url,
          title: ctx?.title,
          selectionText: ctx?.selectionText,
          compactContext: ctx?.compactSummary,
          customCommand: settings?.cliAgentCommand,
          sessionId,
        },
        {
          onStart: (commandUsed) => {
            setMessages((prev) => prev.map((m) => (m.id === assistantMsgId ? { ...m, commandUsed } : m)));
          },
          onChunk: (chunk) => {
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantMsgId ? { ...m, content: m.content + chunk } : m)),
            );
          },
          onToolUse: (name) => {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantMsgId ? { ...m, toolCalls: [...(m.toolCalls ?? []), { name, done: false }] } : m,
              ),
            );
          },
          onToolResult: (name, isError) => {
            setMessages((prev) =>
              prev.map((m) => {
                if (m.id !== assistantMsgId) return m;
                const calls = [...(m.toolCalls ?? [])];
                const idx = calls.findLastIndex((c) => c.name === name && !c.done);
                if (idx >= 0) calls[idx] = { ...calls[idx], done: true, isError };
                return { ...m, toolCalls: calls };
              }),
            );
          },
          onSession: rememberSession,
          onDone: (durationMs) => {
            setMessages((prev) => prev.map((m) => (m.id === assistantMsgId ? { ...m, durationMs } : m)));
            setIsProcessing(false);
          },
          onError: (err) => {
            setMessages((prev) => prev.map((m) => (m.id === assistantMsgId ? { ...m, content: `Error: ${err}` } : m)));
            setIsProcessing(false);
          },
        },
      );
    } catch (e) {
      console.warn("[ChatTab] Streaming failed, attempting standard query fallback:", e);
      try {
        const res = await queryCliAgent({
          prompt: finalPrompt,
          url: ctx?.url,
          title: ctx?.title,
          selectionText: ctx?.selectionText,
          compactContext: ctx?.compactSummary,
          customCommand: settings?.cliAgentCommand,
          sessionId,
        });
        if (res.sessionId) rememberSession(res.sessionId);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsgId
              ? {
                  ...m,
                  content: res.content,
                  commandUsed: res.commandUsed,
                  durationMs: res.durationMs,
                }
              : m,
          ),
        );
      } catch (fallbackErr) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsgId
              ? { ...m, content: `Error: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}` }
              : m,
          ),
        );
      } finally {
        setIsProcessing(false);
      }
    }
  }

  async function handleAbort() {
    try {
      await abortCliAgent();
      setIsProcessing(false);
    } catch {}
  }

  function handleClearHistory() {
    if (window.confirm("Xóa toàn bộ lịch sử đoạn chat?")) {
      setMessages([]);
      setSessionId(undefined);
      try {
        localStorage.removeItem(STORAGE_CHAT_KEY);
        localStorage.removeItem(STORAGE_SESSION_KEY);
      } catch {}
    }
  }

  return (
    <div className="flex flex-1 flex-col h-full overflow-hidden bg-[#0c0d11] text-zinc-200 font-sans">
      <div className="flex items-center justify-between border-b border-zinc-800/80 px-3 py-2 bg-[#121318]/90 z-10">
        <div className="flex items-center gap-2">
          <ChatIcon className="w-4 h-4 text-indigo-400" />
          <span className="font-semibold text-xs text-zinc-100">CLI Agent Chat</span>
          <span
            className="rounded bg-zinc-900 border border-zinc-800 px-1.5 py-0.2 text-[9.5px] font-mono text-zinc-400 truncate max-w-[140px]"
            title={settings?.cliAgentCommand}
          >
            {settings?.cliAgentCommand?.split(" ")[0] || "claude"}
          </span>
        </div>

        <button
          type="button"
          onClick={handleClearHistory}
          title="Clear Chat History"
          className="p-1 rounded text-zinc-500 hover:text-rose-400 hover:bg-zinc-800 transition"
        >
          <TrashIcon className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {messages.length === 0 && !isProcessing ? (
          <div className="flex h-full flex-col items-center justify-center text-center p-4">
            <div className="h-10 w-10 rounded-2xl bg-indigo-950/40 border border-indigo-900/40 flex items-center justify-center text-indigo-400 mb-2.5 shadow-sm">
              <SparklesIcon className="w-5 h-5" />
            </div>
            <div className="font-semibold text-zinc-200 text-xs">Chat Trực Tiếp Với CLI Agent</div>
            <p className="mt-1 text-[11px] text-zinc-500 max-w-[240px] leading-relaxed">
              Tự động nhận diện ngữ cảnh tab đang mở & streaming câu trả lời tức thì bằng subscription của bạn.
            </p>

            {/* Quick Starter Chips */}
            <div className="mt-4 flex flex-col gap-1.5 w-full max-w-[260px]">
              <button
                type="button"
                onClick={() =>
                  void handleSendMessage("Tóm tắt các ý chính và nội dung quan trọng của trang này giúp tôi.")
                }
                className="rounded-lg border border-zinc-800/80 bg-zinc-900/60 px-2.5 py-1.5 text-[11px] text-left text-zinc-300 hover:border-indigo-500/50 hover:bg-zinc-800/80 transition flex items-center gap-1.5"
              >
                <SparklesIcon className="w-3.5 h-3.5 text-indigo-400 flex-none" />
                <span className="truncate">Tóm tắt trang đang mở</span>
              </button>
              <button
                type="button"
                onClick={() =>
                  void handleSendMessage("Trang này là trang gì? Có những tính năng hoặc thông tin chính nào?")
                }
                className="rounded-lg border border-zinc-800/80 bg-zinc-900/60 px-2.5 py-1.5 text-[11px] text-left text-zinc-300 hover:border-indigo-500/50 hover:bg-zinc-800/80 transition flex items-center gap-1.5"
              >
                <SearchIcon className="w-3.5 h-3.5 text-sky-400 flex-none" />
                <span className="truncate">Trang này là trang gì?</span>
              </button>
            </div>
          </div>
        ) : (
          <>
            {messages.map((msg) => {
              const isUser = msg.role === "user";
              const hasContent = Boolean(msg.content);
              return (
                <div key={msg.id} className={`flex flex-col ${isUser ? "items-end" : "items-start"} animate-fade-in`}>
                  <div className="flex items-center gap-1.5 mb-1 px-1 text-[9px] font-mono text-zinc-500">
                    <span>{isUser ? "You" : "CLI Agent"}</span>
                    <span>·</span>
                    <span>{formatTime(msg.createdAt)}</span>
                    {!isUser && msg.durationMs && <span className="text-emerald-400">({msg.durationMs}ms)</span>}
                  </div>

                  <div
                    className={`max-w-[90%] rounded-2xl px-3 py-2 text-[11.5px] leading-relaxed shadow-sm ${
                      isUser
                        ? "bg-indigo-600 text-white rounded-tr-xs"
                        : "bg-[#181920] border border-zinc-800/90 text-zinc-200 rounded-tl-xs"
                    }`}
                  >
                    {msg.url && (
                      <div
                        className={`mb-1.5 rounded-lg p-1.5 text-[10px] font-mono border ${
                          isUser
                            ? "bg-indigo-700/60 border-indigo-500/40 text-indigo-100"
                            : "bg-zinc-900/90 border-zinc-800 text-zinc-400"
                        }`}
                      >
                        <div className="flex items-center gap-1 font-semibold truncate">
                          <PinIcon className="w-3 h-3 flex-none text-amber-300" />
                          <span className="truncate">{msg.title || msg.url}</span>
                        </div>
                        {msg.selectionText && (
                          <div className="mt-1 text-[9.5px] line-clamp-2 italic opacity-90 border-l-2 border-amber-400/60 pl-1.5">
                            "{msg.selectionText}"
                          </div>
                        )}
                      </div>
                    )}

                    {!isUser && msg.toolCalls && msg.toolCalls.length > 0 && (
                      <div className="mb-1.5 flex flex-wrap gap-1">
                        {msg.toolCalls.map((tc, i) => (
                          <span
                            key={i}
                            className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9.5px] font-mono ${
                              !tc.done
                                ? "border-indigo-800/60 bg-indigo-950/60 text-indigo-300"
                                : tc.isError
                                  ? "border-rose-900/60 bg-rose-950/40 text-rose-300"
                                  : "border-emerald-900/60 bg-emerald-950/40 text-emerald-300"
                            }`}
                          >
                            {!tc.done && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-indigo-400" />}
                            <WrenchIcon className="w-2.5 h-2.5 flex-none" />
                            {tc.name.replace(/^mcp__browsercontrol__/, "")}
                          </span>
                        ))}
                      </div>
                    )}

                    {!isUser && !hasContent ? (
                      <div className="flex items-center gap-2 py-0.5 text-zinc-400">
                        <div className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-indigo-400 border-t-transparent flex-none" />
                        <span className="text-[10.5px]">Đang phản hồi...</span>
                      </div>
                    ) : (
                      <div className="whitespace-pre-wrap select-text">{msg.content}</div>
                    )}
                  </div>
                </div>
              );
            })}

            {isProcessing && (
              <div className="flex items-center justify-end px-1">
                <button
                  type="button"
                  onClick={() => void handleAbort()}
                  className="flex items-center gap-1 rounded bg-rose-950/60 border border-rose-800/50 px-2 py-0.5 text-[9.5px] font-mono text-rose-300 hover:bg-rose-900/60 transition"
                >
                  <StopIcon className="w-2.5 h-2.5" /> Dừng (Stop)
                </button>
              </div>
            )}
          </>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="border-t border-zinc-800/80 bg-[#101116] p-2.5 space-y-2">
        {attachedContext && (
          <div className="flex items-center justify-between rounded-lg bg-zinc-900 border border-indigo-500/40 px-2 py-1 text-[10px] font-mono text-indigo-300 animate-fade-in">
            <div className="flex items-center gap-1.5 min-w-0">
              <PinIcon className="w-3.5 h-3.5 text-indigo-400 flex-none" />
              <span className="truncate max-w-[200px] text-zinc-200">
                {attachedContext.title || attachedContext.url}
              </span>
              {attachedContext.selectionText && (
                <span className="text-[9px] text-zinc-500 truncate max-w-[80px]">(Selected)</span>
              )}
            </div>
            <button
              type="button"
              onClick={() => setAttachedContext(null)}
              className="p-0.5 rounded text-zinc-500 hover:text-zinc-200"
            >
              <CrossIcon className="w-3 h-3" />
            </button>
          </div>
        )}

        <div className="flex items-end gap-1.5">
          <button
            type="button"
            onClick={() => void handleManualPing()}
            title="Ghim ngữ cảnh trang đang xem"
            className={`flex h-8 w-8 flex-none items-center justify-center rounded-lg border transition active:scale-95 ${
              attachedContext
                ? "bg-indigo-950/80 border-indigo-500/50 text-indigo-300"
                : "bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700"
            }`}
          >
            <PinIcon className={`w-3.5 h-3.5 ${pinging ? "animate-bounce" : ""}`} />
          </button>

          <textarea
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void handleSendMessage();
              }
            }}
            placeholder="Hỏi CLI Agent về trang đang mở..."
            rows={1}
            disabled={isProcessing}
            className="flex-1 rounded-lg bg-zinc-900/90 border border-zinc-800/90 px-2.5 py-1.5 text-[11.5px] text-zinc-100 placeholder-zinc-500 outline-none focus:border-indigo-500/60 focus:ring-1 focus:ring-indigo-500/30 transition resize-none max-h-24 min-h-[32px] disabled:opacity-50"
          />

          <button
            type="button"
            onClick={() => void handleSendMessage()}
            disabled={isProcessing || !inputText.trim()}
            title="Gửi câu hỏi (Enter)"
            className="flex h-8 w-8 flex-none items-center justify-center rounded-lg bg-indigo-600 text-white shadow-sm hover:bg-indigo-500 disabled:opacity-40 disabled:hover:bg-indigo-600 transition active:scale-95"
          >
            <SendIcon className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
