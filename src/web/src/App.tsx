import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import {
  fetchAnalytics,
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
  type SourceAnalytics,
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

function PrivateNumber({ value, privacy, metric = false }: { value: number; privacy: boolean; metric?: boolean }) {
  return privacy ? <span className={`redacted ${metric ? 'redacted-metric' : 'redacted-number'}`} aria-label="数值已隐藏" /> : value;
}

function SessionItem({
  s,
  active,
  privacy,
  onClick,
}: {
  s: SessionSummary;
  active: boolean;
  privacy: boolean;
  onClick: () => void;
}) {
  return (
    <div className={`session-item ${active ? 'active' : ''}`} onClick={onClick}>
      <div className="session-item-head">
        <SourceBadge source={s.source} />
        <span className="session-item-date">{privacy ? <span className="redacted redacted-date" aria-label="日期已隐藏" /> : fmtDate(s.started_at).slice(0, 10)}</span>
      </div>
      <div className="session-item-title">
        {privacy ? <span className="redacted redacted-title" aria-label="标题已隐藏" /> : s.title}
      </div>
      {s.snippet && <div className="session-item-snippet">
        {privacy ? <span className="redacted redacted-snippet" aria-label="摘要已隐藏" /> : s.snippet}
      </div>}
      <div className="session-item-meta">
        {s.project && <span className="session-item-project">
          {privacy ? <span className="redacted redacted-project" aria-label="项目已隐藏" /> : shortProject(s.project)}
        </span>}
        <span><PrivateNumber value={s.message_count} privacy={privacy} /> 条</span>
      </div>
    </div>
  );
}

function ToolCalls({ calls, privacy }: { calls: { name: string; brief: string }[]; privacy: boolean }) {
  const [open, setOpen] = useState(false);
  if (!calls.length) return null;
  return (
    <div className={`toolcalls ${open ? 'open' : ''}`}>
      <button className="toolcalls-toggle" onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} <PrivateNumber value={calls.length} privacy={privacy} /> 次工具调用
      </button>
      {open && (
        <ul className="toolcalls-list">
          {calls.map((c, i) => (
            <li key={i}>
              {privacy ? <span className="redacted redacted-tool" aria-label="工具详情已隐藏" /> : <>
                <span className="toolcalls-name">{c.name}</span>
                {c.brief && <span className="toolcalls-brief">{c.brief}</span>}
              </>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MessageView({ m, privacy }: { m: SessionDetail['messages'][number]; privacy: boolean }) {
  const html = useMemo(() => privacy ? '' : renderMarkdown(m.content), [m.content, privacy]);
  return (
    <div className={`msg msg-${m.role}`}>
      <div className="msg-role">{m.role === 'user' ? '我' : 'AI'}</div>
      <div className="msg-body">
        <Thinking text={m.thinking} privacy={privacy} />
        {privacy ? <div className="msg-text redacted-message" aria-label="消息内容已隐藏">
          <span /><span />
        </div> : <div className="msg-text md" dangerouslySetInnerHTML={{ __html: html }} />}
        <ToolCalls calls={m.tool_calls ?? []} privacy={privacy} />
      </div>
    </div>
  );
}

/** model reasoning: collapsed by default, same interaction as tool calls */
function Thinking({ text, privacy }: { text: string | null; privacy: boolean }) {
  const [open, setOpen] = useState(false);
  const html = useMemo(() => (text && !privacy ? renderMarkdown(text) : ''), [text, privacy]);
  if (!text) return null;
  return (
    <div className={`thinking ${open ? 'open' : ''}`}>
      <button className="thinking-toggle" onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} 思考过程
      </button>
      {open && (privacy ? <div className="thinking-body redacted-message" aria-label="思考内容已隐藏"><span /><span /></div>
        : <div className="thinking-body md" dangerouslySetInnerHTML={{ __html: html }} />)}
    </div>
  );
}

function Detail({ detail, loading, error, privacy }: { detail: SessionDetail | null; loading: boolean; error: string | null; privacy: boolean }) {
  if (loading) return <div className="detail detail-empty">加载中…</div>;
  if (error) return <div className="detail detail-empty">{error}</div>;
  if (!detail) return <div className="detail detail-empty">← 从左侧选择一个会话</div>;
  const { session, messages } = detail;
  return (
    <div className="detail">
      <div className="detail-header">
        <h1>{privacy ? <span className="redacted redacted-heading" aria-label="标题已隐藏" /> : session.title}</h1>
        <div className="detail-meta">
          <SourceBadge source={session.source} />
          {session.project && <span>{privacy ? <span className="redacted redacted-detail-project" aria-label="项目已隐藏" /> : session.project}</span>}
          <span>
            {privacy ? <span className="redacted redacted-detail-date" aria-label="日期已隐藏" /> : `${fmtDate(session.started_at)} ~ ${fmtDate(session.ended_at)}`}
          </span>
          <span><PrivateNumber value={messages.length} privacy={privacy} /> 条消息</span>
        </div>
      </div>
      <div className="detail-messages">
        {messages.map((m) => (
          <MessageView key={m.seq} m={m} privacy={privacy} />
        ))}
      </div>
    </div>
  );
}

function ZcodeAnalysis({ data, privacy }: { data: SourceAnalytics; privacy: boolean }) {
  const daily = new Map(data.activity.map((item) => [item.day, item.count]));
  const demoActivity = [0, 1, 0, 2, 0, 0, 1, 3, 0, 0, 2, 1, 0, 1];
  const days = Array.from({ length: 14 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - 13 + i);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return { day, count: privacy ? demoActivity[i]! : daily.get(day) ?? 0 };
  });
  const max = Math.max(1, ...days.map((d) => d.count));
  return (
    <section className="analysis" aria-label="ZCode 会话分析">
      <div className="analysis-metrics">
        <div><strong><PrivateNumber value={data.sessions} privacy={privacy} metric /></strong><span>会话</span></div>
        <div><strong><PrivateNumber value={data.messages} privacy={privacy} metric /></strong><span>消息</span></div>
        <div><strong><PrivateNumber value={data.userMessages} privacy={privacy} metric /></strong><span>提问</span></div>
        <div><strong><PrivateNumber value={data.toolCalls} privacy={privacy} metric /></strong><span>工具调用</span></div>
        <div><strong><PrivateNumber value={data.activeDays} privacy={privacy} metric /></strong><span>活跃天数</span></div>
      </div>
      <div className="analysis-lower">
        <div className="analysis-activity">
          <div className="analysis-label">近 14 天会话</div>
          <div className="analysis-bars">
            {days.map(({ day, count }) => (
              <div key={day} className="analysis-bar-cell" title={privacy ? '活动详情已隐藏' : `${day}: ${count} 个会话`}>
                <div className="analysis-bar" style={{ height: count ? `${Math.max(12, (count / max) * 100)}%` : '0' }} />
              </div>
            ))}
          </div>
          <div className="analysis-axis"><span>{privacy ? <span className="redacted redacted-axis" /> : days[0]?.day.slice(5)}</span><span>{privacy ? <span className="redacted redacted-axis" /> : days[13]?.day.slice(5)}</span></div>
        </div>
        <div className="analysis-projects">
          <div className="analysis-label">常用项目</div>
          {privacy ? Array.from({ length: 5 }, (_, i) => (
            <div className="analysis-project" key={i}>
              <span className="redacted redacted-project" aria-label="项目已隐藏" />
              <span className="redacted redacted-number" aria-label="数值已隐藏" />
            </div>
          )) : data.projects.length ? data.projects.map(({ project, count }) => (
            <div className="analysis-project" key={project} title={project}>
              <span>{shortProject(project)}</span><strong>{count}</strong>
            </div>
          )) : <div className="analysis-none">暂无项目</div>}
        </div>
      </div>
    </section>
  );
}

export default function App() {
  const [privacy, setPrivacy] = useState(() => new URLSearchParams(window.location.search).get('privacy') === '1');
  const [stats, setStats] = useState<Stats | null>(null);
  const [zcodeAnalysis, setZcodeAnalysis] = useState<SourceAnalytics | null>(null);
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
    const url = new URL(window.location.href);
    if (privacy) url.searchParams.set('privacy', '1');
    else url.searchParams.delete('privacy');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }, [privacy]);

  useEffect(() => {
    if (source !== 'zcode') return;
    let cancelled = false;
    fetchAnalytics('zcode').then((data) => { if (!cancelled) setZcodeAnalysis(data); }).catch(() => {});
    return () => { cancelled = true; };
  }, [source]);

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
      if (source === 'zcode') setZcodeAnalysis(await fetchAnalytics('zcode'));
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
          placeholder={privacy ? '搜索已隐藏' : '搜索会话内容…'}
          value={privacy ? '' : qInput}
          readOnly={privacy}
          onChange={(e) => setQInput(e.target.value)}
        />
        <div className="topbar-right">
          {stats && (
            <span className="stat">
              <PrivateNumber value={stats.total} privacy={privacy} /> 个会话{stats.watching ? ' · 自动同步中' : ''}
            </span>
          )}
          <label className="privacy-control">
            <input type="checkbox" checked={privacy} onChange={(e) => setPrivacy(e.target.checked)} />
            <span className="privacy-track" aria-hidden="true" />
            <span>隐私预览</span>
          </label>
          <button className="sync-btn" onClick={doSync} disabled={syncing}>
            {syncing ? '同步中…' : '同步'}
          </button>
        </div>
      </header>

      <div className="filters">
        <button className={`chip ${source === null ? 'on' : ''}`} onClick={() => setSource(null)}>
          全部 {stats && <PrivateNumber value={stats.total} privacy={privacy} />}
        </button>
        {sources.map(({ source: s, count, label }) => (
          <button
            key={s}
            className={`chip ${source === s ? 'on' : ''}`}
            style={source === s ? { borderColor: SOURCE_COLORS[s], color: SOURCE_COLORS[s] } : undefined}
            onClick={() => setSource(source === s ? null : s)}
          >
            {label} <PrivateNumber value={count} privacy={privacy} />
          </button>
        ))}
      </div>

      {source === 'zcode' && zcodeAnalysis && <ZcodeAnalysis data={zcodeAnalysis} privacy={privacy} />}

      <div className="main">
        <aside className="list">
          {items.length === 0 && !listLoading && (
            <div className="list-empty">
              {q ? `没有匹配「${q}」的会话` : stats?.total ? '该来源暂无会话' : '还没有数据，点击右上角「同步」或运行 shiyi sync'}
            </div>
          )}
          {items.map((s) => (
            <SessionItem key={s.id} s={s} active={s.id === selected} privacy={privacy} onClick={() => setSelected(s.id)} />
          ))}
          {listLoading && <div className="list-loading">加载中…</div>}
          {!listLoading && items.length < total && (
            <button className="load-more" onClick={() => loadList(false)}>
              加载更多（{privacy ? <span className="redacted redacted-load-count" aria-label="数值已隐藏" /> : `${items.length}/${total}`}）
            </button>
          )}
        </aside>
        <Detail detail={detail} loading={detailLoading} error={detailError} privacy={privacy} />
      </div>
    </div>
  );
}
