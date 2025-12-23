"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

type Role = "user" | "assistant" | "system";

type ChatMessage = {
  id: string;
  role: Role;
  content: string;
  createdAt: number;
};

function uid() {
  // lightweight id
  return `${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function clsx(...xs: Array<string | false | undefined | null>) {
  return xs.filter(Boolean).join(" ");
}

export default function Page() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: uid(),
      role: "assistant",
      content:
        "Сайн байна уу. Би МУИС-ийн дотоод дүрэм журамд хариулах туслагч бот байна. Та МУИС-ийн дотоод дүрэм журмын талаар асууна уу.😊",
      createdAt: Date.now(),
    },
  ]);

  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const canSend = useMemo(() => input.trim().length > 0 && !isSending, [input, isSending]);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, isSending]);

  async function sendMessage() {
    const text = input.trim();
    if (!text || isSending) return;

    setError(null);
    setIsSending(true);
    setInput("");

    const userMsg: ChatMessage = {
      id: uid(),
      role: "user",
      content: text,
      createdAt: Date.now(),
    };

    const placeholderId = uid();
    const placeholder: ChatMessage = {
      id: placeholderId,
      role: "assistant",
      content: "…",
      createdAt: Date.now(),
    };

    setMessages((prev) => [...prev, userMsg, placeholder]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          history: messages
            .filter((m) => m.role !== "system")
            .map((m) => ({ role: m.role, content: m.content })),
        }),
      });

      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(t || `Request failed: ${res.status}`);
      }

      const data = (await res.json()) as { reply?: string };
      const reply = (data.reply ?? "").trim() || "Серверээс хариуг татаж чадсангүй.";

      setMessages((prev) =>
        prev.map((m) => (m.id === placeholderId ? { ...m, content: reply } : m))
      );
    } catch (e: any) {
      setMessages((prev) => prev.filter((m) => m.id !== placeholderId));
      setError(e?.message || "Алдаа гарлаа");
    } finally {
      setIsSending(false);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (canSend) sendMessage();
    }
  }

  function clearChat() {
    setError(null);
    setMessages([
      {
        id: uid(),
        role: "assistant",
        content:
          "Чатыг цэвэрлэлээ.😊",
        createdAt: Date.now(),
      },
    ]);
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  return (
    <div className="min-h-screen bg-[radial-gradient(1200px_circle_at_10%_10%,rgba(99,102,241,0.18),transparent_40%),radial-gradient(900px_circle_at_90%_20%,rgba(16,185,129,0.18),transparent_45%),radial-gradient(800px_circle_at_50%_90%,rgba(236,72,153,0.12),transparent_50%)]">
      <div className="mx-auto flex min-h-screen max-w-4xl flex-col px-4 py-6">
        {/* Header */}
        <header className="mb-5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-11 w-11 rounded-2xl bg-white/70 shadow-sm ring-1 ring-black/5 backdrop-blur flex items-center justify-center">
              <span className="text-xl">💬</span>
            </div>
            <div>
              <h1 className="text-xl font-semibold tracking-tight text-zinc-900">
                NUM-PolicyBot
              </h1>
              <p className="text-sm text-zinc-600">
                МУИС-ийн дотоод дүрэм журмын мэдээлэл олгогч чатбот
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={clearChat}
              className="rounded-2xl bg-white/70 px-4 py-2 text-sm font-medium text-zinc-800 shadow-sm ring-1 ring-black/5 backdrop-blur hover:bg-white/90 active:scale-[0.99] transition"
            >
              Арилгах
            </button>

            <div className="rounded-2xl bg-white/70 px-4 py-2 text-sm text-zinc-700 shadow-sm ring-1 ring-black/5 backdrop-blur">
              {isSending ? "Thinking…" : "Online"}
            </div>
          </div>
        </header>

        {/* Chat panel */}
        <main className="flex-1">
          <div className="rounded-[28px] bg-white/65 shadow-sm ring-1 ring-black/5 backdrop-blur p-3 sm:p-4">
            <div className="h-[68vh] overflow-y-auto px-1 sm:px-2">
              <div className="space-y-3 py-2">
                {messages.map((m) => (
                  <MessageBubble key={m.id} role={m.role} content={m.content} />
                ))}

                {error && (
                  <div className="rounded-3xl bg-rose-50 px-4 py-3 text-sm text-rose-700 ring-1 ring-rose-200">
                    <div className="font-medium">Error</div>
                    <div className="opacity-90">{error}</div>
                  </div>
                )}

                <div ref={scrollRef} />
              </div>
            </div>

            {/* Composer */}
            <div className="mt-3 rounded-[26px] bg-white/75 ring-1 ring-black/5 p-3 sm:p-4">
              <div className="flex gap-3">
                <div className="flex-1">
                  <textarea
                    ref={inputRef}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={onKeyDown}
                    placeholder="Type your message… (Enter to send, Shift+Enter for new line)"
                    className="w-full resize-none rounded-3xl bg-zinc-50 px-4 py-3 text-[15px] leading-6 text-zinc-900 ring-1 ring-black/5 focus:outline-none focus:ring-2 focus:ring-indigo-300"
                    rows={2}
                  />
                  <div className="mt-2 flex items-center justify-between px-1">
                    <span className="text-xs text-zinc-500">
                      {input.trim().length}/2000
                    </span>
                    <span className="text-xs text-zinc-500">
                      API: <span className="font-medium">OpenAI/gpt-4o</span>
                    </span>
                  </div>
                </div>

                <button
                  onClick={sendMessage}
                  disabled={!canSend}
                  className={clsx(
                    "h-[52px] shrink-0 rounded-3xl px-5 text-sm font-semibold shadow-sm transition active:scale-[0.99]",
                    canSend
                      ? "bg-zinc-900 text-white hover:bg-zinc-800"
                      : "bg-zinc-200 text-zinc-500 cursor-not-allowed"
                  )}
                  aria-label="Send message"
                >
                  Илгээх
                </button>
              </div>
            </div>
          </div>
        </main>

        {/* Footer */}
        <footer className="mt-5 text-center text-xs text-zinc-600">
        
        </footer>
      </div>
    </div>
  );
}

function MessageBubble({ role, content }: { role: Role; content: string }) {
  const isUser = role === "user";
  const isAssistant = role === "assistant";

  return (
    <div className={clsx("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={clsx(
          "max-w-[85%] rounded-[26px] px-4 py-3 text-[15px] leading-6 shadow-sm ring-1 ring-black/5",
          isUser
            ? "bg-zinc-900 text-white"
            : isAssistant
            ? "bg-white text-zinc-900"
            : "bg-zinc-100 text-zinc-700"
        )}
      >
        <div className="whitespace-pre-wrap break-words">{content}</div>
      </div>
    </div>
  );
}
