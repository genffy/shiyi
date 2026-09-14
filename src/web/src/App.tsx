import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import {
  fetchSession,
  fetchSessions,
  fetchStats,
  fmtDate,
  postSync,
  shortProject,
  SOURCE_COLORS,
  SOURCE_LABELS,
  type SessionDetail,
  type SessionSummary,
  type SourceId,
  type Stats,
} from './api.js';

const PAGE_SIZE = 50;

// content arrives from assorted import channels (including scraped share pages); always sanitize with DOMPurify
marked.setOptions({ gfm: true, breaks: true });

function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(marked.parse(text, { async: false }));
}

function SourceBadge({ source }: { source: SourceId }) {
  const color = SOURCE_COLORS[source] ?? '#888';
  return (
    <span className="badge" style={{ color, borderColor: color + '55', background: color + '14' }}>
      {SOURCE_LABELS[source] ?? source}
    </span>
  );
}

function SessionItem({
  s,
  active,
  onClick,
}: {
  s: SessionSummary;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <div className={`session-item ${active ? 'active' : ''}`} onClick={onClick}>
      <div className="session-item-head">
        <SourceBadge source={s.source} />
        <span className="session-item-date">{fmtDate(s.started_at).slice(0, 10)}</span>
      </div>
      <div className="session-item-title">{s.title}</div>
      {s.snippet && <div className="session-item-snippet">{s.snippet}</div>}
      <div className="session-item-meta">
        {s.project && <span className="session-item-project">{shortProject(s.project)}</span>}
        <span>{s.message_count} 条</span>
      </div>
    </div>
  );
}

function ToolCalls({ calls }: { calls: { name: string; brief: string }[] }) {
  const [open, setOpen] = useState(false);
  if (!calls.length) return null;
  return (
    <div className={`toolcalls ${open ? 'open' : ''}`}>
      <button className="toolcalls-toggle" onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} {calls.length} 次工具调用
      </button>
      {open && (
        <ul className="toolcalls-list">
          {calls.map((c, i) => (
            <li key={i}>
              <span className="toolcalls-name">{c.name}</span>
              {c.brief && <span className="toolcalls-brief">{c.brief}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MessageView({ m }: { m: SessionDetail['messages'][number] }) {
  const html = useMemo(() => renderMarkdown(m.content), [m.content]);
  return (
    <div className={`msg msg-${m.role}`}>
      <div className="msg-role">{m.role === 'user' ? '我' : 'AI'}</div>
      <div className="msg-body">
        <Thinking text={m.thinking} />
        <div className="msg-text md" dangerouslySetInnerHTML={{ __html: html }} />
        <ToolCalls calls={m.tool_calls ?? []} />
      </div>
    </div>
  );
}

/** model reasoning: collapsed by default, same interaction as tool calls */
function Thinking({ text }: { text: string | null }) {
  const [open, setOpen] = useState(false);
  const html = useMemo(() => (text ? renderMarkdown(text) : ''), [text]);
  if (!text) return null;
  return (
    <div className={`thinking ${open ? 'open' : ''}`}>
      <button className="thinking-toggle" onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} 思考过程
      </button>
      {open && <div className="thinking-body md" dangerouslySetInnerHTML={{ __html: html }} />}
    </div>
  );
}

function Detail({ detail, loading, error }: { detail: SessionDetail | null; loading: boolean; error: string | null }) {
  if (loading) return <div className="detail detail-empty">加载中…</div>;
  if (error) return <div className="detail detail-empty">{error}</div>;
  if (!detail) return <div className="detail detail-empty">← 从左侧选择一个会话</div>;
  const { session, messages } = detail;
  return (
    <div className="detail">
      <div className="detail-header">
        <h1>{session.title}</h1>
        <div className="detail-meta">
          <SourceBadge source={session.source} />
          {session.project && <span>{session.project}</span>}
          <span>
            {fmtDate(session.started_at)} ~ {fmtDate(session.ended_at)}
          </span>
          <span>{messages.length} 条消息</span>
        </div>
      </div>
      <div className="detail-messages">
        {messages.map((m) => (
          <MessageView key={m.seq} m={m} />
        ))}
      </div>
    </div>
  );
}

export default function App() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [source, setSource] = useState<SourceId | null>(null);
  const [q, setQ] = useState('');
  const [qInput, setQInput] = useState('');
  const [items, setItems] = useState<SessionSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [listLoading, setListLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const reqId = useRef(0);

  const loadList = useCallback(
    async (reset: boolean) => {
      const my = ++reqId.current;
      setListLoading(true);
      try {
        const offset = reset ? 0 : items.length;
        const r = await fetchSessions({ source, q: q || undefined, limit: PAGE_SIZE, offset });
        if (my !== reqId.current) return;
        setItems(reset ? r.items : [...items, ...r.items]);
        setTotal(r.total);
      } catch (e) {
        console.error(e);
      } finally {
        if (my === reqId.current) setListLoading(false);
      }
    },
    [source, q, items]
  );

  useEffect(() => {
    fetchStats().then(setStats).catch(() => {});
  }, []);

  useEffect(() => {
    // reset the list when source / q changes
    let cancelled = false;
    (async () => {
      setListLoading(true);
      try {
        const r = await fetchSessions({ source, q: q || undefined, limit: PAGE_SIZE, offset: 0 });
        if (!cancelled) {
          setItems(r.items);
          setTotal(r.total);
        }
      } finally {
        if (!cancelled) setListLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source, q]);

  // search debounce
  useEffect(() => {
    const t = setTimeout(() => setQ(qInput.trim()), 300);
    return () => clearTimeout(t);
  }, [qInput]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    setDetail(null);
    fetchSession(selected)
      .then((d) => !cancelled && setDetail(d))
      .catch((e) => !cancelled && setDetailError(`加载失败: ${e.message}`))
      .finally(() => !cancelled && setDetailLoading(false));
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const doSync = async () => {
    setSyncing(true);
    try {
      await postSync();
      const s = await fetchStats();
      setStats(s);
      const r = await fetchSessions({ source, q: q || undefined, limit: PAGE_SIZE, offset: 0 });
      setItems(r.items);
      setTotal(r.total);
    } catch (e) {
      alert(`同步失败: ${(e as Error).message}`);
    } finally {
      setSyncing(false);
    }
  };

  const sources = stats?.sources ?? [];

  return (
    <div className="app">
      <header className="topbar">
        <div className="logo">
          shiyi（拾遗） <span className="logo-sub">AI 会话知识库</span>
        </div>
        <input
          className="search"
          placeholder="搜索会话内容…"
          value={qInput}
          onChange={(e) => setQInput(e.target.value)}
        />
        <div className="topbar-right">
          {stats && (
            <span className="stat">
              {stats.total} 个会话{stats.watching ? ' · 自动同步中' : ''}
            </span>
          )}
          <button className="sync-btn" onClick={doSync} disabled={syncing}>
            {syncing ? '同步中…' : '同步'}
          </button>
        </div>
      </header>

      <div className="filters">
        <button className={`chip ${source === null ? 'on' : ''}`} onClick={() => setSource(null)}>
          全部 {stats?.total ?? ''}
        </button>
        {sources.map(({ source: s, count, label }) => (
          <button
            key={s}
            className={`chip ${source === s ? 'on' : ''}`}
            style={source === s ? { borderColor: SOURCE_COLORS[s], color: SOURCE_COLORS[s] } : undefined}
            onClick={() => setSource(source === s ? null : s)}
          >
            {label} {count}
          </button>
        ))}
      </div>

      <div className="main">
        <aside className="list">
          {items.length === 0 && !listLoading && (
            <div className="list-empty">
              {q ? `没有匹配「${q}」的会话` : stats?.total ? '该来源暂无会话' : '还没有数据，点击右上角「同步」或运行 shiyi sync'}
            </div>
          )}
          {items.map((s) => (
            <SessionItem key={s.id} s={s} active={s.id === selected} onClick={() => setSelected(s.id)} />
          ))}
          {listLoading && <div className="list-loading">加载中…</div>}
          {!listLoading && items.length < total && (
            <button className="load-more" onClick={() => loadList(false)}>
              加载更多（{items.length}/{total}）
            </button>
          )}
        </aside>
        <Detail detail={detail} loading={detailLoading} error={detailError} />
      </div>
    </div>
  );
}
