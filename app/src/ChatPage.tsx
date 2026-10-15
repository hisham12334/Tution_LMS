import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { chatEventSource } from './backend';
import { getChatContacts, getChatConversations, getChatMessages, markChatRead, sendChatMessage, startChat } from './data';
import type { ChatContact, ChatConversation, ChatMessage, Profile } from './types';
import './chat.css';

const formatTime = (value: string) => new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(new Date(value));
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Chat could not be updated.';

export function ChatPage({ profile, spaceId, onRead }: { profile: Profile; spaceId: string; onRead: () => Promise<void> }) {
  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [contacts, setContacts] = useState<ChatContact[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const lastId = useRef('');
  const selectedRef = useRef('');
  const messagesEnd = useRef<HTMLDivElement>(null);
  const preserveScroll = useRef(false);
  const readPositions = useRef<Record<string, string>>({});
  selectedRef.current = selectedId;

  const refreshList = useCallback(async () => {
    const all = await getChatConversations();
    const visible = profile.role === 'admin' ? all : all.filter(item => item.spaceId === spaceId);
    setConversations(visible);
    setSelectedId(current => visible.some(item => item.id === current) ? current : visible[0]?.id || '');
  }, [profile.role, spaceId]);

  const markRead = useCallback(async (conversationId: string, messageId: string) => {
    if (!messageId || document.visibilityState !== 'visible' || readPositions.current[conversationId] === messageId) return;
    readPositions.current[conversationId] = messageId;
    try {
      await markChatRead(conversationId, messageId);
      await Promise.all([onRead(), refreshList()]);
    } catch (failure) {
      if (readPositions.current[conversationId] === messageId) delete readPositions.current[conversationId];
      throw failure;
    }
  }, [onRead, refreshList]);

  useEffect(() => {
    setSelectedId(''); setMessages([]); setContacts([]); setError('');
    let active = true;
    void Promise.all([getChatConversations(), profile.role === 'admin' || !spaceId ? Promise.resolve([]) : getChatContacts(spaceId)])
      .then(([all, foundContacts]) => {
        if (!active) return;
        const visible = profile.role === 'admin' ? all : all.filter(item => item.spaceId === spaceId);
        setConversations(visible);
        setContacts(foundContacts);
        setSelectedId(visible[0]?.id || '');
      }).catch(failure => { if (active) setError(errorText(failure)); });
    return () => { active = false; };
  }, [profile.role, spaceId]);

  const syncMessages = useCallback(async (conversationId: string) => {
    if (!conversationId) return;
    let cursor = lastId.current;
    let more = true;
    while (more) {
      const page = await getChatMessages(conversationId, cursor ? { after: cursor } : undefined);
      if (selectedRef.current !== conversationId) return;
      if (!cursor) {
        setMessages(current => {
          if (!current.length) return page.messages;
          const combined = new Map([...current, ...page.messages].map(item => [item.id, item]));
          return [...combined.values()].sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
        });
        setHasMore(page.hasMore);
      } else if (page.messages.length) {
        setMessages(current => {
          const existing = new Set(current.map(item => item.id));
          return [...current, ...page.messages.filter(item => !existing.has(item.id))];
        });
      }
      cursor = page.messages.at(-1)?.id || cursor;
      if (cursor && (!lastId.current || BigInt(cursor) > BigInt(lastId.current))) lastId.current = cursor;
      more = Boolean(page.hasMore && page.messages.length);
    }
    if (selectedRef.current === conversationId) await markRead(conversationId, lastId.current);
  }, [markRead]);

  useEffect(() => {
    const whenVisible = () => {
      if (document.visibilityState === 'visible' && selectedRef.current && lastId.current)
        void markRead(selectedRef.current, lastId.current).catch(failure => setError(errorText(failure)));
    };
    document.addEventListener('visibilitychange', whenVisible);
    return () => document.removeEventListener('visibilitychange', whenVisible);
  }, [markRead]);

  useEffect(() => {
    lastId.current = ''; setMessages([]); setHasMore(false);
    if (!selectedId) return;
    let active = true;
    setLoading(true);
    void syncMessages(selectedId).catch(failure => { if (active) setError(errorText(failure)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [selectedId, syncMessages]);

  useEffect(() => {
    const source = chatEventSource();
    const update = (conversationId?: string) => {
      void refreshList().catch(failure => setError(errorText(failure)));
      if (!conversationId || conversationId === selectedRef.current) {
        void syncMessages(selectedRef.current).catch(failure => setError(errorText(failure)));
      }
    };
    source.onopen = () => update();
    source.onmessage = event => {
      try { update((JSON.parse(event.data) as { conversationId: string }).conversationId); }
      catch { update(); }
    };
    source.addEventListener('sync', () => update());
    return () => source.close();
  }, [refreshList, syncMessages]);

  useEffect(() => {
    if (preserveScroll.current) { preserveScroll.current = false; return; }
    messagesEnd.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  async function chooseContact(peerId: string) {
    if (!peerId || !spaceId) return;
    const existing = conversations.find(item => (profile.role === 'student' ? item.teacherId : item.studentId) === peerId);
    if (existing) { setSelectedId(existing.id); return; }
    setBusy(true); setError('');
    try {
      const created = await startChat(spaceId, peerId);
      await refreshList();
      setSelectedId(created.id);
    } catch (failure) { setError(errorText(failure)); }
    finally { setBusy(false); }
  }

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = draft.trim();
    if (!body || !selectedId || busy) return;
    setBusy(true); setError('');
    try {
      await sendChatMessage(selectedId, body);
      setDraft('');
      await Promise.all([syncMessages(selectedId), refreshList()]);
    } catch (failure) { setError(errorText(failure)); }
    finally { setBusy(false); }
  }

  async function loadEarlier() {
    if (!selectedId || !messages.length) return;
    setBusy(true); setError('');
    try {
      const page = await getChatMessages(selectedId, { before: messages[0].id });
      preserveScroll.current = true;
      setMessages(current => [...page.messages, ...current]);
      setHasMore(page.hasMore);
    } catch (failure) { setError(errorText(failure)); }
    finally { setBusy(false); }
  }

  const selected = conversations.find(item => item.id === selectedId);
  const filtered = conversations.filter(item => `${item.studentName} ${item.teacherName} ${item.cohortName} ${item.courseTitle}`.toLowerCase().includes(search.toLowerCase()));
  return <section className="chat-page">
    <div className="page-title"><p className="eyebrow">{profile.role === 'admin' ? 'ADMIN CONSOLE' : profile.role === 'teacher' ? 'TEACHER WORKSPACE' : 'STUDENT PORTAL'}</p><h1>{profile.role === 'admin' ? 'Conversations.' : profile.role === 'teacher' ? 'Chat with students.' : 'Chat with your teacher.'}</h1><p>{profile.role === 'admin' ? 'Read every student and teacher conversation across the centre as messages arrive.' : 'Messages are shared with your teacher or student and are visible to centre admins.'}</p></div>
    {error && <p className="alert" role="alert">{error}</p>}
    <div className="chat-layout">
      <aside className="chat-list" aria-label="Conversations">
        {profile.role !== 'admin' && <label className="chat-contact-label">Start a conversation
          <select value="" disabled={busy || !spaceId} onChange={event => void chooseContact(event.target.value)}>
            <option value="">Choose a {profile.role === 'student' ? 'teacher' : 'student'}</option>
            {contacts.map(contact => <option key={contact.id} value={contact.id}>{contact.display_name}</option>)}
          </select>
        </label>}
        {profile.role === 'admin' && <label className="chat-search">Search conversations<input value={search} onChange={event => setSearch(event.target.value)} placeholder="Name, class, or course" /></label>}
        <div className="chat-list-heading">{profile.role === 'admin' ? 'All conversations' : 'Your conversations'} <span>{filtered.length}</span></div>
        {filtered.map(item => <button key={item.id} type="button" className={`chat-conversation ${selectedId === item.id ? 'selected' : ''}`} onClick={() => setSelectedId(item.id)}>
          <strong>{profile.role === 'admin' ? `${item.studentName} · ${item.teacherName}` : profile.role === 'student' ? item.teacherName : item.studentName}{item.unreadCount > 0 && <b className="chat-conversation-badge" aria-label={`${item.unreadCount} unread messages`}>{item.unreadCount > 99 ? '99+' : item.unreadCount}</b>}</strong>
          <small>{item.cohortName} · {item.courseTitle}</small>
          <span>{item.lastMessage || 'No messages yet'}</span>
          {item.lastAt && <time>{formatTime(item.lastAt)}</time>}
        </button>)}
        {!filtered.length && <p className="chat-list-empty">{profile.role === 'admin' ? 'No conversations have started yet.' : contacts.length ? 'Choose a contact to start chatting.' : 'No contacts are assigned to this course yet.'}</p>}
      </aside>
      <div className="chat-thread">
        {selected ? <>
          <header className="chat-thread-header"><strong>{profile.role === 'admin' ? `${selected.studentName} and ${selected.teacherName}` : profile.role === 'student' ? selected.teacherName : selected.studentName}</strong><small>{selected.cohortName} · {selected.courseTitle}</small></header>
          <div className="chat-messages" role="log" aria-live="polite" aria-label="Messages">
            {hasMore && <button className="outline chat-earlier" type="button" onClick={() => void loadEarlier()} disabled={busy}>Load earlier messages</button>}
            {loading && <p className="loading">Loading messages…</p>}
            {!loading && !messages.length && <p className="chat-no-messages">No messages yet. Start the conversation below.</p>}
            {messages.map(item => <article key={item.id} className={`chat-bubble ${item.senderId === profile.id ? 'own' : ''}`}><div><strong>{item.senderName}</strong><time>{formatTime(item.createdAt)}</time></div><p>{item.body}</p></article>)}
            <div ref={messagesEnd} />
          </div>
          {profile.role === 'admin' ? <p className="chat-read-only">Admin view · Read only</p> : <form className="chat-compose" onSubmit={event => void send(event)}><label htmlFor="chat-draft">Message</label><textarea id="chat-draft" value={draft} onChange={event => setDraft(event.target.value)} maxLength={2000} rows={2} placeholder="Write a message…" onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} /><button className="primary" disabled={busy || !draft.trim()}>Send</button></form>}
        </> : <div className="chat-placeholder"><strong>Select a conversation</strong><p>{profile.role === 'admin' ? 'Choose a conversation to read its history.' : 'Choose a contact to start a private conversation.'}</p></div>}
      </div>
    </div>
  </section>;
}
