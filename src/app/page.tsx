"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { ArrowLeft, LoaderCircle, LogOut, MessageCircle, Send, Users } from "lucide-react";
import { createClient, SupabaseClient, User } from "@supabase/supabase-js";

type OnlineUser = { id: string; nickname: string; online_at: string };
type ChatMessage = {
  id: string;
  room_id: string;
  sender_id: string;
  sender_name: string;
  content: string;
  created_at: string;
};

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

function getSupabase(): SupabaseClient | null {
  if (!supabaseUrl || !supabaseKey) return null;
  return createClient(supabaseUrl, supabaseKey);
}

function roomIdFor(first: string, second: string) {
  return [first, second].sort().join(":");
}

export default function Home() {
  const [supabase] = useState(() => getSupabase());
  const [nickname, setNickname] = useState("");
  const [draftName, setDraftName] = useState("");
  const [user, setUser] = useState<User | null>(null);
  const [onlineUsers, setOnlineUsers] = useState<OnlineUser[]>([]);
  const [selectedUser, setSelectedUser] = useState<OnlineUser | null>(null);
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const selectedUserIdRef = useRef<string | null>(null);

  const roomId = user && selectedUser ? roomIdFor(user.id, selectedUser.id) : null;

  useEffect(() => {
    if (!supabase || !user || !nickname) return;

    const channel = supabase.channel("chaty-lobby", {
      config: { presence: { key: user.id } },
    });

    channel
      .on("presence", { event: "sync" }, () => {
        const state = channel.presenceState<OnlineUser>();
        const people = Object.values(state)
          .flat()
          .filter((person) => person.id !== user.id);
        setOnlineUsers(people);
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          await channel.track({
            id: user.id,
            nickname,
            online_at: new Date().toISOString(),
          });
        }
      });

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [nickname, supabase, user]);

  useEffect(() => {
    if (!supabase || !roomId) return;
    let active = true;

    void supabase
      .from("messages")
      .select("*")
      .eq("room_id", roomId)
      .order("created_at", { ascending: true })
      .limit(100)
      .then(({ data, error: queryError }) => {
        if (!active) return;
        if (queryError) setError(queryError.message);
        else setMessages(data ?? []);
      });

    const channel = supabase
      .channel(`room:${roomId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages", filter: `room_id=eq.${roomId}` },
        (payload) => {
          const incoming = payload.new as ChatMessage;
          setMessages((current) =>
            current.some((item) => item.id === incoming.id) ? current : [...current, incoming],
          );
        },
      )
      .subscribe();

    return () => {
      active = false;
      setMessages([]);
      void supabase.removeChannel(channel);
    };
  }, [roomId, supabase]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (!supabase || !user) return;
    let active = true;

    void supabase
      .from("messages")
      .select("sender_id, created_at")
      .neq("sender_id", user.id)
      .then(({ data }) => {
        if (!active || !data) return;
        const counts: Record<string, number> = {};
        for (const item of data) {
          const lastRead = window.localStorage.getItem(`chaty-read:${user.id}:${item.sender_id}`);
          if (!lastRead || item.created_at > lastRead) {
            counts[item.sender_id] = (counts[item.sender_id] ?? 0) + 1;
          }
        }
        setUnreadCounts(counts);
      });

    const channel = supabase
      .channel(`notifications:${user.id}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages" },
        (payload) => {
          const incoming = payload.new as ChatMessage;
          if (incoming.sender_id === user.id) return;
          if (selectedUserIdRef.current === incoming.sender_id) {
            window.localStorage.setItem(`chaty-read:${user.id}:${incoming.sender_id}`, incoming.created_at);
            return;
          }
          setUnreadCounts((current) => ({
            ...current,
            [incoming.sender_id]: (current[incoming.sender_id] ?? 0) + 1,
          }));
        },
      )
      .subscribe();

    return () => {
      active = false;
      void supabase.removeChannel(channel);
    };
  }, [supabase, user]);

  async function enterChat(event: FormEvent) {
    event.preventDefault();
    const cleanName = draftName.trim().slice(0, 24);
    if (!cleanName) return;
    if (!supabase) {
      setError("Faltan las variables de Supabase. Revisa el archivo .env.local.");
      return;
    }

    setLoading(true);
    setError("");
    const { data: sessionData } = await supabase.auth.getSession();
    let currentUser = sessionData.session?.user ?? null;

    if (!currentUser) {
      const { data, error: authError } = await supabase.auth.signInAnonymously();
      if (authError) {
        setError(authError.message);
        setLoading(false);
        return;
      }
      currentUser = data.user;
    }

    setUser(currentUser);
    setNickname(cleanName);
    setLoading(false);
  }

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    const cleanMessage = message.trim().slice(0, 1000);
    if (!supabase || !user || !roomId || !cleanMessage) return;

    setMessage("");
    const { error: insertError } = await supabase.from("messages").insert({
      room_id: roomId,
      sender_id: user.id,
      sender_name: nickname,
      content: cleanMessage,
    });
    if (insertError) {
      setMessage(cleanMessage);
      setError(insertError.message);
    }
  }

  function openConversation(person: OnlineUser) {
    selectedUserIdRef.current = person.id;
    setSelectedUser(person);
    setUnreadCounts((current) => ({ ...current, [person.id]: 0 }));
    if (user) {
      window.localStorage.setItem(`chaty-read:${user.id}:${person.id}`, new Date().toISOString());
    }
  }

  function closeConversation() {
    selectedUserIdRef.current = null;
    setSelectedUser(null);
  }

  async function leaveChat() {
    if (supabase) await supabase.auth.signOut();
    setSelectedUser(null);
    setOnlineUsers([]);
    setMessages([]);
    setUnreadCounts({});
    selectedUserIdRef.current = null;
    setUser(null);
    setNickname("");
    setError("");
  }

  if (!nickname || !user) {
    return (
      <main className="grid min-h-dvh place-items-center px-5 py-10">
        <section className="w-full max-w-sm rounded-[2rem] border border-white/10 bg-[#12141b]/90 p-7 shadow-2xl shadow-black/30 backdrop-blur-xl sm:p-9">
          <div className="mb-8 grid size-14 place-items-center rounded-2xl bg-violet-500 text-white shadow-lg shadow-violet-500/25">
            <MessageCircle size={28} strokeWidth={2.4} />
          </div>
          <p className="mb-2 text-sm font-semibold tracking-wide text-violet-400">CHATY</p>
          <h1 className="text-3xl font-semibold tracking-tight text-white">Entra.</h1>
          <p className="mt-3 leading-6 text-slate-400">Elige un nombre. Sin contraseñas, sin perfiles, directo al chat.</p>

          <form className="mt-8" onSubmit={enterChat}>
            <label className="text-sm font-medium text-slate-300" htmlFor="nickname">Tu nickname</label>
            <input
              autoComplete="nickname"
              autoFocus
              className="mt-2 h-13 w-full rounded-xl border border-white/10 bg-white/5 px-4 text-base text-white outline-none transition placeholder:text-slate-600 focus:border-violet-500 focus:ring-3 focus:ring-violet-500/15"
              id="nickname"
              maxLength={24}
              onChange={(event) => setDraftName(event.target.value)}
              placeholder="Ej. Ferra"
              value={draftName}
            />
            {error && <p className="mt-3 text-sm text-rose-400">{error}</p>}
            <button className="mt-5 flex h-13 w-full items-center justify-center gap-2 rounded-xl bg-violet-500 font-semibold text-white transition hover:bg-violet-400 disabled:opacity-50" disabled={loading || !draftName.trim()}>
              {loading ? <LoaderCircle className="animate-spin" size={19} /> : "Entrar al chat"}
            </button>
          </form>
        </section>
      </main>
    );
  }

  return (
    <main className="mx-auto flex h-dvh w-full max-w-6xl overflow-hidden bg-[#0c0e13] sm:h-[min(860px,calc(100dvh-32px))] sm:rounded-[2rem] sm:border sm:border-white/10 sm:shadow-2xl sm:shadow-black/40">
      <aside className={`${selectedUser ? "hidden md:flex" : "flex"} w-full flex-col border-white/10 md:w-80 md:border-r`}>
        <header className="flex h-20 shrink-0 items-center justify-between border-b border-white/10 px-5">
          <div>
            <p className="text-lg font-semibold text-white">Conversaciones</p>
            <p className="text-xs text-slate-500">Conectado como {nickname}</p>
          </div>
          <button
            aria-label="Salir del chat"
            className="grid size-10 place-items-center rounded-full text-slate-400 transition hover:bg-white/5 hover:text-white"
            onClick={leaveChat}
            title="Salir"
          >
            <LogOut size={19} />
          </button>
        </header>
        <div className="flex items-center gap-2 px-5 pb-3 pt-5 text-sm font-medium text-slate-400">
          <Users size={16} /> En línea <span className="rounded-full bg-emerald-400/10 px-2 py-0.5 text-xs text-emerald-400">{onlineUsers.length}</span>
        </div>
        <div className="flex-1 overflow-y-auto px-3 pb-4">
          {onlineUsers.length === 0 ? (
            <div className="mx-2 mt-10 text-center">
              <div className="mx-auto grid size-12 place-items-center rounded-full bg-white/5 text-slate-500"><Users size={21} /></div>
              <p className="mt-4 font-medium text-slate-300">Todavía no hay nadie</p>
              <p className="mt-1 text-sm leading-5 text-slate-500">Abre la app en otro dispositivo para comenzar.</p>
            </div>
          ) : onlineUsers.map((person) => (
            <button key={person.id} className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition hover:bg-white/5" onClick={() => openConversation(person)}>
              <span className="relative grid size-11 shrink-0 place-items-center rounded-full bg-slate-700 font-semibold text-white">
                {person.nickname.charAt(0).toUpperCase()}
                <i className="absolute bottom-0 right-0 size-3 rounded-full border-2 border-[#0c0e13] bg-emerald-400" />
              </span>
              <span className="min-w-0 flex-1"><strong className="block truncate text-sm font-medium text-white">{person.nickname}</strong><span className="text-xs text-emerald-400">Disponible</span></span>
              {(unreadCounts[person.id] ?? 0) > 0 && (
                <span className="grid min-w-6 place-items-center rounded-full bg-violet-500 px-1.5 py-0.5 text-xs font-bold text-white">
                  {unreadCounts[person.id] > 99 ? "99+" : unreadCounts[person.id]}
                </span>
              )}
            </button>
          ))}
        </div>
      </aside>

      <section className={`${selectedUser ? "flex" : "hidden md:flex"} min-w-0 flex-1 flex-col`}>
        {selectedUser ? (
          <>
            <header className="flex h-20 shrink-0 items-center gap-3 border-b border-white/10 px-4 sm:px-6">
              <button aria-label="Volver" className="grid size-10 place-items-center rounded-full text-slate-300 hover:bg-white/5 md:hidden" onClick={closeConversation}><ArrowLeft size={21} /></button>
              <span className="grid size-10 shrink-0 place-items-center rounded-full bg-slate-700 font-semibold text-white">{selectedUser.nickname.charAt(0).toUpperCase()}</span>
              <div><h2 className="font-semibold text-white">{selectedUser.nickname}</h2><p className="flex items-center gap-1.5 text-xs text-emerald-400"><i className="size-1.5 rounded-full bg-emerald-400" /> En línea</p></div>
            </header>
            <div className="flex-1 overflow-y-auto px-4 py-5 sm:px-8">
              {messages.length === 0 && <p className="mt-8 text-center text-sm text-slate-500">Este es el comienzo de la conversación con {selectedUser.nickname}.</p>}
              <div className="mx-auto flex max-w-3xl flex-col gap-3">
                {messages.map((item) => {
                  const mine = item.sender_id === user.id;
                  return <div key={item.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}><div className={`max-w-[82%] rounded-2xl px-4 py-2.5 text-[15px] leading-6 ${mine ? "rounded-br-md bg-violet-500 text-white" : "rounded-bl-md bg-white/7 text-slate-200"}`}><p className="break-words">{item.content}</p><p className={`mt-0.5 text-right text-[10px] ${mine ? "text-violet-200" : "text-slate-500"}`}>{new Date(item.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</p></div></div>;
                })}
                <div ref={bottomRef} />
              </div>
            </div>
            <form className="shrink-0 border-t border-white/10 p-3 sm:p-5" onSubmit={sendMessage}>
              <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-2xl border border-white/10 bg-white/5 p-2 focus-within:border-violet-500/60">
                <textarea aria-label="Mensaje" className="max-h-32 min-h-10 flex-1 resize-none bg-transparent px-2 py-2 text-[16px] text-white outline-none placeholder:text-slate-600" onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder="Escribe un mensaje..." rows={1} value={message} />
                <button aria-label="Enviar mensaje" className="grid size-10 shrink-0 place-items-center rounded-xl bg-violet-500 text-white transition hover:bg-violet-400 disabled:opacity-30" disabled={!message.trim()}><Send size={18} /></button>
              </div>
              {error && <p className="mx-auto mt-2 max-w-3xl text-xs text-rose-400">{error}</p>}
            </form>
          </>
        ) : <div className="m-auto text-center text-slate-500"><MessageCircle className="mx-auto mb-4" size={42} /><p>Selecciona a alguien para conversar</p></div>}
      </section>
    </main>
  );
}
