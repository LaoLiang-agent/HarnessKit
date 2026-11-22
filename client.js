// Harness Kit — Client panel v2（M4b 作战室）。
// 顶栏（工作区切换/同步健康/⚙🕘＋⟳）→「需要你」注意力条 → 泳道三列（规划中/实施中/待归档）
// → 底部折叠历史板；独立视图：配置（⚙）与团队动态（🕘）；立项走居中模态。
// 数据：Host webServer 端点（state 3s 轮询；config/activity 进视图时拉取；sync 立即同步）。
window.__ModuleLoader__.load({
  id: 'dsh-harness-kit',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback, useRef } = React;

    // 注入圆点动画 + 表单可读性样式（每次装载都重写，保证 HMR 后样式同步）
    {
      let style = document.getElementById('hk-style');
      if (!style) {
        style = document.createElement('style');
        style.id = 'hk-style';
        document.head.appendChild(style);
      }
      style.textContent =
        '@keyframes hk-breathe{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.45;transform:scale(.82)}}' +
        '@keyframes hk-pulse{0%,100%{opacity:1}50%{opacity:.35}}' +
        '.hk-dot-current{animation:hk-breathe 1.6s ease-in-out infinite}' +
        '.hk-sync-checking{animation:hk-pulse 1.2s ease-in-out infinite}' +
        // 占位符：UA 默认灰不随主题，暗色下几乎不可读 → 显式跟随主题次级文字色
        '.hk-root input::placeholder,.hk-root textarea::placeholder{color:var(--dsw-alias-label-secondary);opacity:.65}' +
        '.hk-root input:focus,.hk-root select:focus,.hk-root textarea:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}' +
        '.hk-browse-row:hover{background:color-mix(in srgb, var(--dsw-alias-label-primary) 9%, transparent)}';
    }

    const V = {
      bg: 'var(--dsw-alias-bg-layer-1)',
      bg2: 'var(--dsw-alias-bg-layer-2)',
      overlay: 'var(--dsw-alias-bg-overlay)',
      border: 'var(--dsw-alias-border-l1)',
      border2: 'var(--dsw-alias-border-l2)',
      brand: 'var(--dsw-alias-brand-primary)',
      // 品牌色按钮上的文字色：亮主题白字深底、暗主题深字白底（主题按系统反转）
      brandInvert: 'var(--dsw-alias-label-primary-inverted, #fff)',
      text: 'var(--dsw-alias-label-primary)',
      sub: 'var(--dsw-alias-label-secondary)',
      err: 'var(--dsw-alias-state-error-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
    };
    // 主题自适应浅面：bg-layer-2 在浅色主题下与底色同为纯白、在暗色下区分度也低，
    // 改用「主文字色低透明度」混合，明暗两态都保证结构可见。
    const tint = (pct) => `color-mix(in srgb, var(--dsw-alias-label-primary) ${pct}%, transparent)`;
    V.surface = tint(4);    // 泳道/区块底
    V.fieldBg = tint(3);    // 输入框底
    V.modalShadow = '0 10px 36px rgba(0, 0, 0, 0.35)';

    const S = {
      wrap: { display: 'flex', flexDirection: 'column', height: '100%', fontSize: 13, lineHeight: 1.5, color: V.text, overflow: 'hidden' },
      body: { flex: 1, overflowY: 'auto', padding: '0 16px 24px' },
      header: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: `1px solid ${V.border}`, flexWrap: 'wrap' },
      hTitle: { fontWeight: 600, fontSize: 14 },
      // 模型下拉建议（provider 切换/取消映射时过滤）——宿主端用，保持同源
      modelSuggest: (models, provider) => (models ?? []).filter((mo) => !provider || mo.provider === provider).flatMap((mo) => mo.models ?? []).map((m) => m.id),
      select: { padding: '3px 8px', borderRadius: 8, border: `1px solid ${V.border2}`, background: V.bg, color: V.text, fontSize: 12, maxWidth: 220 },
      iconBtn: { width: 28, height: 28, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8, border: `1px solid ${V.border}`, background: 'transparent', color: V.text, cursor: 'pointer', fontSize: 14 },
      btn: (disabled, primary) => ({
        padding: '4px 12px', borderRadius: 8, fontSize: 12, cursor: disabled ? 'not-allowed' : 'pointer',
        border: primary ? 'none' : `1px solid ${V.border2}`,
        background: primary ? V.brand : 'transparent',
        color: primary ? V.brandInvert : V.text, opacity: disabled ? 0.45 : 1,
      }),
      attn: (level) => ({
        display: 'flex', alignItems: 'center', gap: 10, padding: '6px 12px', marginBottom: 6, borderRadius: 8, fontSize: 12,
        background: `color-mix(in srgb, ${level === 'block' ? V.err : V.warn} 12%, transparent)`,
        borderLeft: `3px solid ${level === 'block' ? V.err : V.warn}`,
      }),
      lanes: { display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 },
      lane: { flex: '1 1 220px', minWidth: 220, background: V.surface, borderRadius: 8, padding: 8, display: 'flex', flexDirection: 'column', gap: 8 },
      laneHead: { display: 'flex', justifyContent: 'space-between', fontSize: 12, color: V.sub, padding: '2px 4px', fontWeight: 600 },
      card: { background: V.bg, border: `1px solid ${V.border2}`, borderRadius: 8, padding: '10px 12px', cursor: 'pointer' },
      cardTitle: { fontWeight: 600, fontSize: 14, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
      capsule: { fontSize: 10, padding: '1px 6px', borderRadius: 8, border: `1px solid ${V.border2}`, color: V.sub },
      avatar: { width: 16, height: 16, borderRadius: '50%', background: V.brand, color: V.brandInvert, fontSize: 10, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
      statusLine: { fontSize: 12, color: V.sub, marginTop: 3 },
      dots: { display: 'flex', gap: 5, alignItems: 'center', marginTop: 8 },
      actions: { display: 'flex', gap: 6, marginTop: 10, alignItems: 'center' },
      detail: { marginTop: 8, paddingTop: 8, borderTop: `1px solid ${V.border}`, fontSize: 12, color: V.sub },
      history: { marginTop: 16, border: `1px solid ${V.border2}`, borderRadius: 8 },
      histHead: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', cursor: 'pointer', fontSize: 12, color: V.sub, fontWeight: 600 },
      table: { borderCollapse: 'collapse', width: '100%', fontSize: 12 },
      th: { textAlign: 'left', padding: '4px 10px', borderBottom: `1px solid ${V.border2}`, color: V.sub, whiteSpace: 'nowrap' },
      td: { padding: '4px 10px', borderBottom: `1px solid ${V.border}`, verticalAlign: 'top' },
      input: { padding: '4px 10px', borderRadius: 8, border: `1px solid ${V.border2}`, background: V.fieldBg, color: V.text, fontSize: 12, width: '100%', boxSizing: 'border-box' },
      overlayBox: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 },
      modal: { background: V.bg, borderRadius: 10, border: `1px solid ${V.border2}`, boxShadow: V.modalShadow, padding: 20, width: 380, maxWidth: '90vw' },
      field: { marginBottom: 12 },
      label: { fontSize: 12, color: V.sub, marginBottom: 4, display: 'block' },
      toast: (okv) => ({ padding: '8px 12px', borderRadius: 8, fontSize: 12, background: V.bg, border: `1px solid ${okv ? V.ok : V.err}`, boxShadow: V.modalShadow, color: V.text, marginBottom: 6, maxWidth: 420, whiteSpace: 'pre-wrap', cursor: okv ? 'default' : 'pointer' }),
      toastWrap: { position: 'fixed', bottom: 16, right: 16, zIndex: 200 },
      empty: { textAlign: 'center', padding: '40px 0', color: V.sub },
      section: { background: V.surface, borderRadius: 8, padding: 14, marginBottom: 12 },
      secTitle: { fontWeight: 600, fontSize: 13, marginBottom: 8 },
      kv: { display: 'flex', gap: 8, fontSize: 12, marginBottom: 4 },
      day: { fontSize: 11, color: V.sub, fontWeight: 600, margin: '12px 0 6px', borderBottom: `1px solid ${V.border}`, paddingBottom: 4 },
      actRow: { display: 'flex', gap: 8, alignItems: 'flex-start', padding: '5px 0', fontSize: 12 },
      syncDot: (color, checking) => ({ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }),
      obCard: { flex: '1 1 240px', minWidth: 240, background: V.surface, border: `1px solid ${V.border2}`, borderRadius: 10, padding: 16, cursor: 'pointer' },
      pre: { background: V.bg, border: `1px solid ${V.border}`, borderRadius: 8, padding: 10, fontSize: 11, whiteSpace: 'pre-wrap', maxHeight: 260, overflowY: 'auto', fontFamily: 'monospace', marginTop: 8 },
    };

    const LANES = [
      { id: 'plan', name: '规划中' },
      { id: 'build', name: '实施中' },
      { id: 'archive', name: '待归档' },
    ];

    const SYNC_META = {
      clean: { color: 'var(--dsw-alias-state-success-primary)', label: '已同步' },
      ahead: { color: 'var(--dsw-alias-state-success-primary)', label: '本地领先' },
      behind: { color: 'var(--dsw-alias-state-warn-primary)', label: '落后远端' },
      diverged: { color: 'var(--dsw-alias-state-warn-primary)', label: '已分叉' },
      blocked: { color: 'var(--dsw-alias-state-error-primary)', label: '同步冲突' },
      offline: { color: 'var(--dsw-alias-state-error-primary)', label: '远端不可达' },
      unknown: { color: 'var(--dsw-alias-state-error-primary)', label: '状态未知' },
      checking: { color: 'var(--dsw-alias-state-idle-primary)', label: '检查中' },
      local: { color: 'var(--dsw-alias-state-idle-primary)', label: '本地模式' },
      'no-remote': { color: 'var(--dsw-alias-state-idle-primary)', label: '未配远端' },
      embedded: { color: 'var(--dsw-alias-state-success-primary)', label: '随工作区仓' },
    };

    // .harness 无独立 git、被工作区根仓库跟踪时（layout==='embedded'），同步状态随根仓库
    // 计算，标签统一加后缀说明归属，避免与「独立资产仓库」语义混淆。
    const withLayout = (meta, sync) =>
      sync?.layout === 'embedded' && sync?.state !== 'embedded' ? { ...meta, label: `${meta.label}·随工作区仓` } : meta;

    function relDay(dateStr) {
      if (!dateStr || dateStr === '—') return '';
      const d = new Date(dateStr);
      if (Number.isNaN(d.getTime())) return dateStr;
      const days = Math.floor((Date.now() - d.getTime()) / 86400000);
      if (days <= 0) return '今天';
      if (days === 1) return '昨天';
      return `${days} 天前`;
    }

    function Icon(props) {
      const size = (props && props.size) || 20;
      // 侧栏常驻提醒：任一工作区有「需要你」项时，在图标角上点一个红点，
      // 用户即使不打开插件也能注意到；会话内的详细提示见 AttentionDock。
      const [alert, setAlert] = useState(false);
      useEffect(() => {
        let cancelled = false;
        const load = () => {
          fetch('/harness-kit/state').then((r) => r.json()).then((json) => {
            if (cancelled || !json?.ok) return;
            setAlert((json.workspaces ?? []).some((w) => (w.attention ?? []).length > 0));
          }).catch(() => { /* 网络抖动忽略 */ });
        };
        void load();
        const timer = setInterval(load, 15000);
        return () => { cancelled = true; clearInterval(timer); };
      }, []);
      return h('span', { style: { position: 'relative', display: 'inline-block', width: size, height: size, lineHeight: 0 } },
        h('svg', { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true, style: { display: 'block' } },
          h('path', { d: 'M4 5h16M4 12h16M4 19h10', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', fill: 'none' }),
          h('circle', { cx: 19, cy: 19, r: 2.4, fill: 'currentColor' })),
        alert && h('span', {
          'aria-hidden': true,
          className: 'hk-alert-dot',
          style: {
            position: 'absolute', top: -1, right: -1, width: 7, height: 7, borderRadius: '50%',
            background: V.err, boxShadow: `0 0 0 1px ${V.bg}`,
          },
        }));
    }

    // 看板链词表 → 中文显示名（证据推导路径的阶段名本身即中文，原样通过）
    const STAGE_LABEL = {
      propose: '需求方案', Dev: '开发', CR: '代码审查', TE: '测试', 验证: '验证',
      审批1: '审批 1', 审批2: '审批 2', 质量门: '质量门', 影响面: '影响面分析',
    };
    const stageLabel = (name) => STAGE_LABEL[name] || name;

    // 阶段圆点（审批为菱形；跳过为空心；阻塞为红色）
    function Dots({ stages }) {
      return h('div', { style: S.dots },
        stages.map((s, i) => {
          const isApproval = s.kind === 'approval';
          const base = {
            width: 8, height: 8, display: 'inline-block', flexShrink: 0,
            borderRadius: isApproval ? 2 : '50%', transform: isApproval ? 'rotate(45deg)' : 'none',
            background: s.done ? V.ok : s.blocked ? V.err : s.skipped ? 'transparent' : 'var(--dsw-alias-border-l2)',
            border: s.skipped ? '1px solid var(--dsw-alias-border-l2)' : 'none',
          };
          const state = s.done ? ' · 已完成' : s.blocked ? ' · 阻塞' : s.skipped ? ' · 已跳过' : s.current ? ' · 当前阶段' : ' · 待进行';
          return h('span', {
            key: i, title: `${stageLabel(s.name)}${state}${isApproval ? ' · 审批点' : ''}`,
            className: s.current ? 'hk-dot-current' : undefined,
            style: s.current ? { ...base, background: V.brand } : base,
          });
        }));
    }

    // 会话内工作区提醒：与面板「需要你」同源的 attention，常驻在输入框上方；
    // 用户不打开插件也能看到阻塞项（工作区裁决/同步落后/待归档/初始化缺件）。
    function AttentionDock({ session, ctx }) {
      const sessionId = session?.sessionId ?? session?.id ?? null;
      const [data, setData] = useState(null);
      const [busy, setBusy] = useState(false);
      const [note, setNote] = useState(null);
      const [expanded, setExpanded] = useState(false);

      useEffect(() => {
        if (!sessionId) { setData(null); return undefined; }
        let cancelled = false;
        const load = async () => {
          try {
            const res = await fetch('/harness-kit/state');
            const json = await res.json();
            if (cancelled || !json?.ok) return;
            const ws = (json.workspaces ?? []).find((w) => (w.sessions ?? []).some((s) => s.id === sessionId));
            const items = ws?.attention ?? [];
            setData(items.length > 0 ? { ws, items } : null);
          } catch { /* 网络抖动：保留上一条提醒 */ }
        };
        void load();
        const timer = setInterval(() => { void load(); }, 15000);
        return () => { cancelled = true; clearInterval(timer); };
      }, [sessionId]);

      if (!data) return null;
      const { ws, items } = data;
      const level = items.some((a) => a.level === 'block') ? 'block' : 'warn';
      const color = level === 'block' ? V.err : V.warn;
      const shown = expanded ? items : items.slice(0, 1);

      const post = async (url, body) => {
        setBusy(true);
        setNote(null);
        try {
          const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
          const json = await res.json();
          setNote(json?.ok ? '已提交，等待执行结果…' : (json?.error || '操作失败'));
        } catch (e) {
          setNote(String(e?.message ?? e));
        } finally {
          setBusy(false);
        }
      };
      const run = (line) => post('/harness-kit/command', { workspace: ws.id, line, sessionId });
      const syncNow = () => post('/harness-kit/sync', { workspace: ws.id });
      const openPanel = () => { try { ctx.get('layout')?.selectPanel?.('harness-kit'); } catch { /* ignore */ } };
      const jump = (task) => {
        const t = (ws.tasks ?? []).find((x) => x.task === task);
        if (t?.sessionId) { try { ctx.get('uiWorkspace')?.openSession?.(t.sessionId); } catch { /* ignore */ } }
      };

      const btn = (label, onClick, primary) => h('button', {
        style: S.btn(busy, primary), disabled: busy, title: label, onClick,
      }, label);

      return h('div', {
        className: 'hk-attention-dock',
        style: {
          width: '100%', boxSizing: 'border-box', padding: '8px 12px', marginBottom: 8,
          borderRadius: 8, fontSize: 12, lineHeight: 1.5,
          background: `color-mix(in srgb, ${color} 10%, transparent)`,
          border: `1px solid color-mix(in srgb, ${color} 35%, transparent)`,
          borderLeft: `3px solid ${color}`,
          color: V.text,
        },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('span', { style: { color, fontWeight: 600 } }, level === 'block' ? '⛔ 工作区提醒' : '⚠️ 工作区提醒'),
          h('span', { style: { color: V.sub, fontSize: 11 } }, `${items.length} 项`),
          h('span', { style: { flex: 1 } }),
          items.length > 1 && btn(expanded ? '收起' : '展开全部', () => setExpanded((v) => !v), false),
          btn('打开面板', openPanel, false)),
        shown.map((a, i) => h('div', { key: i, style: { marginTop: 4 } },
          h('div', {
            style: expanded
              ? { whiteSpace: 'pre-wrap', color: V.text }
              : { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', color: V.text },
          }, a.text),
          h('div', { style: { display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' } },
            (a.options ?? []).map((o) => btn(o.label, () => run(o.line), o.primary)),
            a.line && !(a.options ?? []).length && btn('处理', () => run(a.line), true),
            a.sync && btn('立即同步', syncNow, true),
            a.init && btn('运行初始化', () => run('/hk-init'), true),
            a.jump && a.task && btn('转到会话', () => jump(a.task), false)))),
        note && h('div', { style: { marginTop: 4, fontSize: 11, color: V.sub } }, note));
    }

    function Panel({ uiWorkspace }) {
      const [data, setData] = useState(null);
      // 工作区选择记忆：打开插件时恢复上次选择的工作区（而非列表第一个）
      const [lastWsId, setLastWsId] = useState(() => {
        try { return localStorage.getItem('harness-kit.lastWorkspaceId'); } catch { return null; }
      });
      const [wsId, setWsId] = useState(null);
      const [view, setView] = useState('main'); // main|config|activity
      const [config, setConfig] = useState(null);
      const [activity, setActivity] = useState(null);
      const [toasts, setToasts] = useState([]);
      const [expanded, setExpanded] = useState(() => new Set());
      const [insight, setInsight] = useState({}); // task -> { loading, data, error }
      const [histOpen, setHistOpen] = useState(false);
      const [histQuery, setHistQuery] = useState('');
      const [modal, setModal] = useState(null); // {name, desc, file}
      const [browse, setBrowse] = useState(null); // 需求文件浏览：{dir, parent, entries, loading, error}
      const [busy, setBusy] = useState(false);
      // 工作区开通引导：null 不显示；'choice'|'new'|'open'。无工作区时自动进入 choice。
      const [obMode, setObMode] = useState(null);
      const [obPath, setObPath] = useState(''); // 「打开」被拒后转「新建」时预填的目录
      const tick = useRef(0);

      const toast = useCallback((text, okv = true) => {
        const id = ++tick.current;
        setToasts((ts) => [...ts, { id, text: String(text).slice(0, 500), ok: okv }]);
        // 成功 3s、失败 6s 自动消失；点击立即关闭
        setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), okv ? 3000 : 6000);
      }, []);

      const fetchState = useCallback(() => {
        fetch('/harness-kit/state', { cache: 'no-store' })
          .then((r) => r.json())
          .then((j) => { if (j.ok) setData(j); })
          .catch(() => {});
      }, []);
      useEffect(() => {
        fetchState();
        const t = setInterval(fetchState, 3000);
        return () => clearInterval(t);
      }, [fetchState]);

      const workspaces = data?.workspaces ?? [];
      // 解析顺序：显式选择 > 记忆的上次工作区 > 列表第一个（记忆值已从列表移除时自然回落）
      const ws = workspaces.find((w) => w.id === wsId)
        ?? workspaces.find((w) => w.id === lastWsId)
        ?? workspaces[0] ?? null;
      const selectWs = useCallback((id) => {
        setWsId(id);
        setLastWsId(id);
        try { localStorage.setItem('harness-kit.lastWorkspaceId', id); } catch { /* 无痕模式等场景静默 */ }
      }, []);

      // 无活动会话时的兜底：优先唤醒最近会话，无会话则开空白会话（保留草稿）
      const openFallbackSession = useCallback(async () => {
        if (!uiWorkspace || !ws) return false;
        const sessions = ws.sessions ?? [];
        const last = sessions[sessions.length - 1];
        try {
          if (last) { uiWorkspace.openSession(last.id); return true; }
          if (uiWorkspace.openWorkspace) { await uiWorkspace.openWorkspace(ws.id); return true; }
        } catch { /* 忽略，走提示 */ }
        return false;
      }, [ws, uiWorkspace]);

      const run = useCallback((line, retried = false) => {
        if (!ws) return;
        setBusy(true);
        fetch('/harness-kit/command', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workspace: ws.id, line }),
        }).then((r) => r.json()).then(async (j) => {
          if (!j.ok && !retried && /没有活动会话/.test(j.error || '')) {
            toast('该工作区暂无活动会话，正在打开并重试…');
            setBusy(false);
            if (await openFallbackSession()) {
              setTimeout(() => run(line, true), 2500);
            } else {
              toast('请先在该工作区打开一个会话再操作', false);
            }
            return;
          }
          if (j.ok && j.sessionId && uiWorkspace?.openSession) {
            // 命令在某个会话里注入执行：直接切过去，让用户看到执行现场。
            // 走 unarchiveThenOpen：目标会话若被归档，直接 openSession 会被导航效应
            // 立刻清回空白「新会话」视图（归档会话在侧栏隐藏）。
            try {
              await unarchiveThenOpen(j.sessionId);
              dbgClient({ step: 'legacy-jump', ok: true, target: j.sessionId });
            } catch (e) {
              dbgClient({ step: 'legacy-jump', ok: false, target: j.sessionId, err: String(e?.message || e) });
            }
          }
          toast(j.ok ? `已发送到会话执行：${line}` : j.error || '失败', j.ok);
          setTimeout(fetchState, 600);
        }).catch((e) => toast(e.message, false)).finally(() => setBusy(false));
      }, [ws, toast, fetchState, openFallbackSession]);

      // 立项/fix 直通：为任务开专属新会话（openWorkspace 在当前窗口直达新会话，
      // beforeOpen 同步拿到 sessionId），再把命令定向注入该会话——host 端轮询等
      // agent 就绪（≤15s），用户全程看到执行现场，侧栏也有新会话记录。
      // 打开失败/被取代则回落旧路径（注入最近活动会话）。
      const runFresh = useCallback(async (line) => {
        if (!ws) return;
        if (!uiWorkspace?.openWorkspace) { run(line); return; }
        setBusy(true);
        let sid = null;
        try { await uiWorkspace.openWorkspace(ws.id, (id) => { sid = id; }); } catch { /* 回落旧路径 */ }
        if (!sid) { run(line); return; }
        try {
          const j = await fetch('/harness-kit/command', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ workspace: ws.id, line, sessionId: sid }),
          }).then((r) => r.json());
          toast(j.ok ? `已发送到会话执行：${line}` : j.error || '失败', j.ok);
        } catch (e) { toast(e.message, false); }
        setBusy(false);
        setTimeout(fetchState, 600);
      }, [ws, uiWorkspace, run, toast, fetchState]);

      const loadInsight = useCallback((t) => {
        if (!ws) return;
        setInsight((prev) => ({ ...prev, [t.task]: { loading: true } }));
        fetch(`/harness-kit/task-insight?workspace=${encodeURIComponent(ws.id)}&task=${encodeURIComponent(t.task)}`, { cache: 'no-store' })
          .then((r) => r.json())
          .then((j) => setInsight((prev) => ({ ...prev, [t.task]: { loading: false, data: j.ok ? j.metrics : null, error: j.ok ? null : j.error || '读取失败' } })))
          .catch((e) => setInsight((prev) => ({ ...prev, [t.task]: { loading: false, data: null, error: e.message } })));
      }, [ws]);

      const syncNow = useCallback(() => {
        if (!ws) return;
        // embedded 兜底：不 POST（host 会回"不适用"），直接指路
        if (ws.sync?.layout === 'embedded') {
          toast('资产随工作区根仓库管理：在根仓库 git pull/push 即共享，面板同步不适用', false);
          return;
        }
        setBusy(true);
        toast('同步中…（git fetch/rebase/push）');
        fetch('/harness-kit/sync', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workspace: ws.id }),
        }).then((r) => r.json()).then((j) => {
          toast(j.text || (j.ok ? '同步完成' : '同步失败'), j.ok);
          setTimeout(fetchState, 800);
        }).catch((e) => toast(e.message, false)).finally(() => setBusy(false));
      }, [ws, toast, fetchState]);

      // 需求文件浏览：打开/进入目录（宿主无文件选择器，走 /harness-kit/browse 列举）
      const browseInto = useCallback(async (dir) => {
        if (!ws) return;
        setBrowse((b) => ({ ...(b ?? {}), dir, loading: true, error: null }));
        try {
          const r = await fetch(`/harness-kit/browse?workspace=${encodeURIComponent(ws.id)}&dir=${encodeURIComponent(dir)}`, { cache: 'no-store' });
          const j = await r.json();
          if (!j.ok) setBrowse((b) => ({ ...(b ?? {}), dir, loading: false, error: j.error || '列举失败' }));
          else setBrowse({ dir: j.dir, parent: j.parent, entries: j.entries, loading: false, error: null });
        } catch (e) {
          setBrowse((b) => ({ ...(b ?? {}), dir, loading: false, error: e.message }));
        }
      }, [ws]);

      // 目录选择：Desktop 快速路径优先，退回 uiWorkspace 服务，均不可用时由用户手填
      const pickDirectory = useCallback(async () => {
        try {
          const picker = globalThis.__DSH_DIRECTORY_PICKER__;
          if (picker?.pick) return await picker.pick();
          if (uiWorkspace?.pickDirectory) return await uiWorkspace.pickDirectory();
        } catch { /* 用户取消或宿主不支持 */ }
        return null;
      }, [uiWorkspace]);

      // 面板化初始化入口（配置视图：重跑初始化 / 添加子工程）
      const runInitPanel = useCallback((payload, okMsg) => {
        if (!ws) return;
        setBusy(true);
        fetch('/harness-kit/workspace/init', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workspace: ws.id, ...payload }),
        }).then((r) => r.json()).then((j) => {
          toast(j.ok ? (okMsg ?? '初始化完成') : j.error || '操作失败', j.ok);
          if (j.ok) {
            fetch(`/harness-kit/config?workspace=${encodeURIComponent(ws.id)}`, { cache: 'no-store' })
              .then((r) => r.json()).then((c) => setConfig(c.ok ? c : null)).catch(() => {});
            setTimeout(fetchState, 800);
          }
        }).catch((e) => toast(e.message, false)).finally(() => setBusy(false));
      }, [ws, toast, fetchState]);

      // 任务级跳转（2026-11-12 人裁决第三版）：仅当任务有 session 绑定记录、
      // 且该会话仍在本机工作区列表中，才允许「继续会话」——点击 openSession 直达窗口。
      // 其余情况（无记录 / 会话不在本机）一律不提供入口：不支持接管别人的任务。
      const hasLiveSession = (t) => !!t?.sessionId && (ws?.sessions ?? []).some((s) => s.id === t.sessionId);
      // 临时排障（2026-11-13）：把跳转链路关键步骤回报到 host，落盘 /tmp/hk-command-debug.log
      const dbgClient = (obj) => {
        try {
          fetch('/harness-kit/debug-log', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify(obj),
          }).catch(() => { });
        } catch { /* 排障回报失败不阻断 */ }
      };
      // 跳转到绑定会话前的统一准备：归档会话被选中会被导航效应立刻清回空白「新会话」视图
      // 且从侧栏隐藏（2026-11-13 定位的「跳转后只见空白新对话窗」根因），故先幂等取消归档，
      // 稍等列表快照刷新再跳转。对未归档会话是无害空操作。
      const unarchiveThenOpen = async (sessionId) => {
        if (!uiWorkspace?.openSession || !sessionId) return;
        await uiWorkspace.unarchiveSession?.(sessionId)?.catch?.(() => { });
        await new Promise((r) => setTimeout(r, 200));
        uiWorkspace.openSession(sessionId);
      };

      const jumpTask = useCallback((t) => {
        if (!uiWorkspace) return toast('界面未提供工作区操作能力', false);
        if (!hasLiveSession(t)) return toast('该任务在本机没有可继续的会话', false);
        unarchiveThenOpen(t.sessionId)
          .then(() => toast(`已打开「${t.task}」的会话`))
          .catch((e) => toast(`打开会话失败：${e?.message || e}`, false));
      }, [ws, uiWorkspace, toast]);

      // 任务动作（继续推进/归档）定向执行：有本机存活绑定会话时，命令定向注入绑定会话、
      // 跳转也直达绑定会话——命令目标=跳转目标=绑定会话，避免旧路径「最近活动会话」启发式
      // 把命令打进别的会话、再跳到用户意料之外的窗口。无存活绑定时回落旧 run()。
      const runTask = useCallback((t) => {
        const line = t?.action?.line;
        if (!ws || !line) return;
        const directed = hasLiveSession(t);
        dbgClient({ step: 'runTask', task: t?.task, directed, bound: t?.sessionId ?? null,
          wsSessions: (ws.sessions ?? []).map((s) => s.id) });
        if (!directed) { run(line); return; }
        setBusy(true);
        fetch('/harness-kit/command', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workspace: ws.id, line, sessionId: t.sessionId }),
        }).then((r) => r.json()).then(async (j) => {
          dbgClient({ step: 'resp', ok: !!j.ok, sid: j.sessionId ?? null, err: j.error ?? null });
          if (j.ok && uiWorkspace?.openSession) {
            try {
              await unarchiveThenOpen(t.sessionId);
              dbgClient({ step: 'jump', ok: true, target: t.sessionId });
            } catch (e) {
              dbgClient({ step: 'jump', ok: false, target: t.sessionId, err: String(e?.message || e) });
            }
          }
          toast(j.ok ? `已发送到会话执行：${line}` : j.error || '失败', j.ok);
          setTimeout(fetchState, 600);
        }).catch((e) => toast(e.message, false)).finally(() => setBusy(false));
      }, [ws, uiWorkspace, run, toast, fetchState]);

      // 进入配置/动态视图时拉数据
      useEffect(() => {
        if (!ws) return;
        if (view === 'config') {
          fetch(`/harness-kit/config?workspace=${encodeURIComponent(ws.id)}`, { cache: 'no-store' })
            .then((r) => r.json()).then((j) => setConfig(j.ok ? j : null)).catch(() => setConfig(null));
        } else if (view === 'activity') {
          fetch(`/harness-kit/activity?workspace=${encodeURIComponent(ws.id)}`, { cache: 'no-store' })
            .then((r) => r.json()).then((j) => setActivity(j.ok ? j.entries : [])).catch(() => setActivity([]));
        }
      }, [view, ws?.id]);

      const liveSession = (ws?.sessions ?? []).some((s) => s.live);

      // ---------- 顶栏 ----------
      const syncMeta = withLayout(SYNC_META[ws?.sync?.state] ?? SYNC_META.checking, ws?.sync);
      const header = h('div', { style: S.header },
        h('span', { style: S.hTitle }, 'Harness'),
        workspaces.length > 1 && h('select', {
          style: S.select, value: ws?.id ?? '', onChange: (e) => selectWs(e.target.value),
        }, workspaces.map((w) => h('option', { key: w.id, value: w.id }, w.title || w.id))),
        ws && h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: V.sub }, title: ws.sync?.checkedAt ? `检查于 ${new Date(ws.sync.checkedAt).toLocaleTimeString()}` : '' },
          h('span', { style: S.syncDot(syncMeta.color), className: ws.sync?.state === 'checking' ? 'hk-sync-checking' : undefined }),
          syncMeta.label,
          ws.sync?.state === 'behind' && ` ${ws.sync.behind}↓`,
          ws.sync?.state === 'diverged' && ` ${ws.sync.behind}↓${ws.sync.ahead}↑`),
        // embedded（.harness 随工作区根仓库管理）：同步对象是根仓库，面板不能替用户动代码仓库，
        // 不提供「立即同步」（旧版点了只会得到"/hk-sync 不适用"报错）；提示由注意力项给出。
        ws && ws.sync?.layout !== 'embedded' && h('button', { style: S.btn(busy), disabled: busy, onClick: syncNow }, '立即同步'),
        h('span', { style: { flex: 1 } }),
        h('button', { style: { ...S.btn(false), fontSize: 12 }, title: '新建 / 打开工作区', onClick: () => setObMode('choice') }, '＋ 工作区'),
        ws && h('button', { style: S.iconBtn, title: '新建任务', onClick: () => setModal({ name: '', desc: '', file: '' }) }, '＋'),
        ws && h('button', { style: S.iconBtn, title: '团队动态', onClick: () => setView(view === 'activity' ? 'main' : 'activity') }, '🕘'),
        ws && h('button', { style: S.iconBtn, title: '配置', onClick: () => setView(view === 'config' ? 'main' : 'config') }, '⚙'),
        h('button', { style: S.iconBtn, title: '刷新', onClick: fetchState }, '⟳'),
      );

      if (!data) return h('div', { style: S.wrap, className: 'hk-root' }, header, h('div', { style: S.body }, h('div', { style: S.empty }, '加载中…')));

      // ---------- 工作区开通引导（无工作区自动进入；顶栏「＋ 工作区」随时可开） ----------
      const obActive = obMode ?? (workspaces.length === 0 ? 'choice' : null);
      if (obActive) {
        return h('div', { style: S.wrap, className: 'hk-root' }, header, h('div', { style: S.body },
          h(OnboardView, {
            mode: obActive,
            setMode: setObMode,
            canClose: workspaces.length > 0,
            onClose: () => setObMode(null),
            uiWorkspace, toast, busy, setBusy, pickDirectory,
            initialPath: obPath,
            onDone: (id) => { if (id) selectWs(id); fetchState(); },
            onSwitchToNew: (p) => { setObPath(p); setObMode('new'); },
          })),
          h('div', { style: S.toastWrap },
            toasts.map((tst) => h('div', {
              key: tst.id, style: S.toast(tst.ok),
              onClick: () => !tst.ok && setToasts((ts) => ts.filter((x) => x.id !== tst.id)),
            }, tst.text))));
      }

      // ---------- 配置视图 ----------
      const saveConfig = (patch, okMsg) => {
        setBusy(true);
        fetch('/harness-kit/config', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workspace: ws.id, patch }),
        }).then((r) => r.json()).then((j) => {
          toast(j.ok ? okMsg : j.error || '保存失败', j.ok);
          if (j.ok) {
            fetch(`/harness-kit/config?workspace=${encodeURIComponent(ws.id)}`, { cache: 'no-store' })
              .then((r) => r.json()).then((c) => setConfig(c.ok ? c : null)).catch(() => {});
          }
        }).catch((e) => toast(e.message, false)).finally(() => setBusy(false));
      };

      if (view === 'config') {
        return h('div', { style: S.wrap, className: 'hk-root' }, header, h('div', { style: S.body },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, margin: '12px 0' } },
            h('button', { style: S.iconBtn, onClick: () => setView('main') }, '←'),
            h('span', { style: S.hTitle }, `配置 · ${ws.title || ws.id}`)),
          !config ? h('div', { style: S.empty }, '加载中…') : h(ConfigView, { config, syncMeta, ws, busy, saveConfig, runInit: runInitPanel, onOrchestrate: () => run('/hk-init'), catalog: config.catalog ?? [], toast }),
        ), h('div', { style: S.toastWrap }, toasts.map((tst) => h('div', { key: tst.id, style: S.toast(tst.ok), onClick: () => !tst.ok && setToasts((ts) => ts.filter((x) => x.id !== tst.id)) }, tst.text))));
      }

      // ---------- 团队动态视图 ----------
      if (view === 'activity') {
        const groups = {};
        for (const e of activity ?? []) {
          const day = (e.at || '').split(' ')[0] || '未知日期';
          (groups[day] = groups[day] ?? []).push(e);
        }
        let content;
        if (activity === null) content = h('div', { style: S.empty }, '加载中…');
        else if (activity.length === 0) content = h('div', { style: S.empty }, '资产仓库暂无提交记录（本地模式或无 git）');
        else {
          content = Object.keys(groups).sort().reverse().map((day) => {
            const rows = groups[day].map((e, i) => h('div', { key: i, style: S.actRow },
              h('span', { style: S.avatar }, (e.author || '?').slice(0, 1).toUpperCase()),
              h('div', null,
                h('div', null, h('b', null, e.author), ' · ', e.subject),
                h('div', { style: { fontSize: 11, color: V.sub } }, (e.at || '').split(' ')[1] ?? '', ' · ', e.hash))));
            return h('div', { key: day }, h('div', { style: S.day }, day), rows);
          });
        }
        return h('div', { style: S.wrap, className: 'hk-root' }, header, h('div', { style: S.body },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, margin: '12px 0' } },
            h('button', { style: S.iconBtn, onClick: () => setView('main') }, '←'),
            h('span', { style: S.hTitle }, `团队动态 · ${ws.title || ws.id}`)),
          content));
      }

      // ---------- 主视图 ----------
      const active = ws.tasks.filter((t) => t.lane !== 'done');
      // 历史任务板：按「上次活动」时间倒序（最新完成在前）
      const done = ws.tasks.filter((t) => t.lane === 'done')
        .sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')));
      const histRows = done.filter((t) => !histQuery || t.task.toLowerCase().includes(histQuery.toLowerCase()));

      const primaryOf = (t) => {
        const a = t.action;
        // 用户裁决（2026-11-12 第三版）：「继续会话」仅对本机存在绑定会话的任务出现；
        // 无会话的任务不显示跳转按钮（不支持接管他人任务），归档/继续推进不受影响。
        const sessionBtn = { label: '继续会话', onClick: () => jumpTask(t), primary: true };
        if (a.kind === 'wait') return hasLiveSession(t) ? sessionBtn : null;
        if (a.kind === 'archive') return { label: '归档', onClick: () => runTask(t), primary: true };
        if (a.kind === 'apply') return hasLiveSession(t) ? sessionBtn : null;
        // 用户裁决（2026-11-12）：历史任务不需要重开按钮
        if (a.kind === 'reopen') return null;
        return { label: '继续推进', onClick: () => runTask(t), primary: true };
      };

      const card = (t) => {
        const cur = t.progress.current >= 0 ? t.progress.stages[t.progress.current] : null;
        const open = expanded.has(t.task);
        const primary = primaryOf(t);
        return h('div', { key: t.task, style: S.card, onClick: () => setExpanded((s) => { const n = new Set(s); n.has(t.task) ? n.delete(t.task) : n.add(t.task); return n; }) },
          h('div', { style: S.cardTitle },
            t.task,
            t.profile && t.profile !== '—' && h('span', { style: S.capsule }, t.profile),
            t.claimer && h('span', { style: S.avatar, title: `认领人：${t.claimer}` }, t.claimer.slice(0, 1).toUpperCase())),
          h('div', { style: S.statusLine },
            t.status === 'AWAITING_ARCHIVE' ? '已完成' : cur ? `${cur.kind === 'approval' ? '⛔ ' : ''}${stageLabel(cur.name)}` : '—',
            ' · ', relDay(t.updated),
            t.claimer ? ` · ${t.claimer}` : '',
            // M2：slot 开发的任务打槽位标记（主树任务不打，保持默认形态干净）
            (() => {
              const w = t.workspace && Object.values(t.workspace).find((x) => x.placement !== 'main');
              return w ? ` · 🗂 ${w.placement}` : '';
            })(),
            // TE 环境持有者标记（串行租约）
            t.teHolder ? ' · 🧪TE环境' : ''),
          h(Dots, { stages: t.progress.stages.map((s, i) => ({ ...s, current: i === t.progress.current })) }),
          // 圆点与看板 Apply 链同源：链原文贴出便于对照（绿✅ 蓝▶当前 灰…待做 红⛔阻塞 空心—跳过）
          t.apply && t.apply !== '—' && t.apply !== '已归档'
            && h('div', { style: { fontSize: 11, color: V.sub, marginTop: 3 } }, t.apply),
          h('div', { style: { ...S.actions, position: 'relative' }, onClick: (e) => e.stopPropagation() },
            primary && h('button', { style: S.btn(primary.disabled || busy, primary.primary), disabled: primary.disabled || busy, onClick: primary.onClick }, primary.label),
          ),
          open && h('div', { style: S.detail, onClick: (e) => e.stopPropagation() },
            h('div', null, h('b', null, '状态：'), t.status, '　', h('b', null, '分支：'), t.branch),
            // M2 工作区分配（本机）：主工作树 or 池化 slot
            t.workspace && h('div', null, h('b', null, '工作区：'),
              Object.entries(t.workspace).map(([repo, w], i) => h('span', { key: repo, title: w.branch ? `${w.branch} ← ${w.base}` : '' },
                i > 0 && '；',
                `${repo} → ${w.placement === 'main' ? '主工作树' : w.placement}`,
                w.branch ? `（${w.branch}）` : ''))),
            t.apply && t.apply !== '—' && h('div', null, h('b', null, 'Apply：'), t.apply),
            t.progress.deliverables.length > 0 && h('div', null, h('b', null, '产物：'), t.progress.deliverables.join('、')),
            t.hint && t.hint !== '—' && h('div', null, h('b', null, '续接：'), t.hint),
            h('div', { style: { marginTop: 8 } },
              h('button', { style: S.btn(false), onClick: () => loadInsight(t) }, insight[t.task]?.loading ? '读取中…' : (insight[t.task]?.data ? '刷新运行记录' : '查看运行记录')),
              (() => {
                const ins = insight[t.task];
                if (!ins) return null;
                if (ins.loading) return h('div', { style: { fontSize: 11, color: V.sub, marginTop: 4 } }, '读取会话统计…');
                if (ins.error) return h('div', { style: { fontSize: 11, color: V.err, marginTop: 4 } }, ins.error);
                const d = ins.data;
                const n = (x) => (typeof x === 'number' ? x.toLocaleString() : '—');
                return h('div', { style: { marginTop: 6 } },
                  h('div', { style: { fontSize: 11, color: d.coverage === 'complete' ? V.ok : V.warn, marginBottom: 4 } },
                    `覆盖率 ${d.coverage} · ${d.totals.agents} 个 Agent · ${n(d.totals.totalTokens)} tokens · ${Math.round((d.totals.activeDurationMs || 0) / 1000)}s · 失败 ${d.totals.toolFailures}`),
                  h('table', { style: S.table },
                    h('thead', null, h('tr', null, ['Agent', '模型', '轮次', 'tokens', '耗时', '失败'].map((x) => h('th', { key: x, style: S.th }, x)))),
                    h('tbody', null, (d.agents ?? []).map((a) => h('tr', { key: a.label },
                      h('td', { style: S.td }, a.label),
                      h('td', { style: S.td }, `${a.provider || '—'}/${a.model || '—'}${a.reasoningEffort ? ` · ${a.reasoningEffort}` : ''}`),
                      h('td', { style: S.td }, n(a.turns)),
                      h('td', { style: S.td }, n(a.totalTokens)),
                      h('td', { style: S.td }, `${Math.round((a.activeDurationMs || 0) / 1000)}s`),
                      h('td', { style: S.td }, n(a.toolFailures)))))),
                  (d.notes ?? []).length > 0 && h('div', { style: { fontSize: 11, color: V.sub, marginTop: 4 } }, d.notes.join('；')));
              })()),
            t.progress.pendingApproval && h('div', { style: { color: V.warn } }, `⛔ ${t.progress.pendingApproval} 等待人工审批（在会话中答复，并写入通过标记）`)),
        );
      };

      return h('div', { style: S.wrap, className: 'hk-root' }, header,
        h('div', { style: S.body },
          // 初始化进行中横幅（2026-11-17）：页面中途关掉/重开后依旧可见，防止无感知重复初始化
          ws?.init && !ws.init.done && h('div', { style: { ...S.attn('warn'), marginTop: 12 } },
            h('span', null, '🔧'),
            h('span', { style: { flex: 1 } },
              `工作区初始化进行中：${ws.init.stage}${ws.init.detail ? ` — ${ws.init.detail}` : ''}` +
              `（已耗时 ${Math.max(0, Math.round((Date.now() - (ws.init.startedAt || Date.now())) / 1000))}s；刷新页面不影响，完成后自动消失）`)),
          // 「需要你」注意力条
          ws.attention.length > 0 && h('div', { style: { marginTop: 12 } },
            ws.attention.map((a, i) => h('div', { key: i, style: S.attn(a.level) },
              h('span', null, a.level === 'block' ? '🔴' : '🟠'),
              h('span', { style: { flex: 1 } }, a.text),
              a.jump && (() => { const t = a.task && active.concat(done).find((x) => x.task === a.task); return t && hasLiveSession(t)
                ? h('button', { style: S.btn(busy, true), disabled: busy, onClick: () => jumpTask(t) }, '继续会话')
                : null; })(),
              // 结构化决策点选项（外来分支占用等）：可点按钮直接重跑对应命令
              (a.options ?? []).map((o) => h('button', {
                key: o.label, style: S.btn(busy, !o.primary), disabled: busy,
                title: o.line, onClick: () => run(o.line),
              }, o.label)),
              a.line && h('button', { style: S.btn(busy, true), disabled: busy, onClick: () => run(a.line) }, '处理'),
              a.init && h('button', { style: S.btn(busy, true), disabled: busy, onClick: () => run('/hk-init') }, '运行初始化编排'),
              a.sync && h('button', { style: S.btn(busy, true), disabled: busy, onClick: syncNow }, a.kind === 'sync-blocked' ? '查看' : '立即同步'),
            ))),
          // 泳道
          active.length === 0
            ? h('div', { style: S.empty },
                h('div', { style: { fontSize: 28, marginBottom: 8 } }, '🛠'),
                h('div', null, '还没有进行中的任务'),
                h('button', { style: { ...S.btn(false, true), marginTop: 10 }, onClick: () => setModal({ name: '', desc: '', file: '' }) }, '立一个新项'))
            : h('div', { style: S.lanes },
                LANES.map((lane) => {
                  const ts = active.filter((t) => t.lane === lane.id);
                  return h('div', { key: lane.id, style: S.lane },
                    h('div', { style: S.laneHead }, h('span', null, lane.name), h('span', null, ts.length)),
                    ts.length === 0 ? h('div', { style: { fontSize: 11, color: V.idle, textAlign: 'center', padding: '12px 0' } }, '—')
                      : ts.map(card));
                })),
          // 历史任务板（折叠）
          done.length > 0 && h('div', { style: S.history },
            h('div', { style: S.histHead, onClick: () => setHistOpen(!histOpen) },
              h('span', null, histOpen ? '▾' : '▸'), `历史任务板（${done.length}）`),
            histOpen && h('div', { style: { padding: '0 12px 12px' } },
              h('input', { style: { ...S.input, width: 220, marginBottom: 8 }, placeholder: '搜索任务名…', value: histQuery, onChange: (e) => setHistQuery(e.target.value) }),
              h('table', { style: S.table },
                h('thead', null, h('tr', null, ['任务', 'Profile', '完成时间'].map((x) => h('th', { key: x, style: S.th }, x)))),
                h('tbody', null, histRows.map((t) => h('tr', { key: t.task },
                  h('td', { style: S.td }, t.task),
                  h('td', { style: S.td }, t.profile),
                  h('td', { style: S.td }, relDay(t.updated)))))))),
        ),
        // 立项模态（需求 / fix 直通 两种模式；任务名可选，留空由 AI 按描述生成）
        modal && h('div', { style: S.overlayBox, onClick: () => { setModal(null); setBrowse(null); } },
          h('div', { style: S.modal, onClick: (e) => e.stopPropagation() },
            h('div', { style: { ...S.hTitle, marginBottom: 10 } }, '新建任务'),
            h('div', { style: { display: 'flex', gap: 6, marginBottom: 14 } },
              [['new', '需求'], ['fix', 'fix 直通']].map(([m, label]) =>
                h('button', {
                  key: m,
                  style: { ...S.btn(false), padding: '4px 12px', fontSize: 12, borderRadius: 14,
                    background: (modal.mode ?? 'new') === m ? V.brand : 'transparent',
                    color: (modal.mode ?? 'new') === m ? V.brandInvert : V.text },
                  onClick: () => setModal({ ...modal, mode: m }),
                }, label))),
            h('div', { style: { fontSize: 11, color: V.sub, margin: '-8px 0 12px' } },
              (modal.mode ?? 'new') === 'fix'
                ? '简单 bug 修复：跳过文档审批，PM 评估质量门后交你裁决（轻量=只开发+验证）'
                : '完整流程：提案澄清 → Profile 判定 → 人工审批 → 开发实施'),
            h('div', { style: S.field }, h('label', { style: S.label }, '任务名（可选，留空自动按描述生成英文短名）'),
              h('input', { style: S.input, value: modal.name, autoFocus: true, placeholder: '留空自动起名；仅限英文/数字/-_', onChange: (e) => setModal({ ...modal, name: e.target.value }) })),
            h('div', { style: S.field }, h('label', { style: S.label }, '一句话需求描述'),
              h('input', { style: S.input, value: modal.desc, onChange: (e) => setModal({ ...modal, desc: e.target.value }) })),
            (modal.mode ?? 'new') === 'new' && h('div', { style: S.field }, h('label', { style: S.label }, '需求文件路径（可选）'),
              h('div', { style: { display: 'flex', gap: 6 } },
                h('input', { style: { ...S.input, flex: 1 }, value: modal.file, placeholder: 'docs/xxx.md', onChange: (e) => setModal({ ...modal, file: e.target.value }) }),
                h('button', {
                  style: S.btn(false),
                  onClick: () => {
                    if (browse) { setBrowse(null); return; }
                    const cur = modal.file.trim();
                    browseInto(cur.includes('/') ? cur.slice(0, cur.lastIndexOf('/')) : '');
                  },
                }, browse ? '收起' : '浏览…')),
              // 工作区内文件浏览（默认落在工作区根目录；📁 进入，📄 选中回填）
              browse && h('div', { style: { marginTop: 6, border: `1px solid ${V.border2}`, borderRadius: 6, padding: '6px 8px', fontSize: 12, maxHeight: 180, overflowY: 'auto', background: V.fieldBg } },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, color: V.sub } },
                  h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                    browse.dir ? `工作区根目录/${browse.dir}` : '工作区根目录'),
                  browse.dir ? h('button', {
                    style: { ...S.btn(false), padding: '1px 8px', fontSize: 11 },
                    onClick: () => browseInto(browse.parent ?? ''),
                  }, '‹ 上级') : null),
                browse.loading && h('div', { style: { color: V.sub, padding: '4px 2px' } }, '加载中…'),
                browse.error && h('div', { style: { color: V.err, padding: '4px 2px' } }, browse.error),
                !browse.loading && !browse.error && (browse.entries?.length
                  ? browse.entries.map((e) => h('div', {
                      key: e.kind + '/' + e.name,
                      className: 'hk-browse-row',
                      style: { padding: '3px 6px', borderRadius: 4, cursor: 'pointer', color: e.kind === 'dir' ? V.brand : V.text },
                      onClick: () => {
                        const p = browse.dir ? `${browse.dir}/${e.name}` : e.name;
                        if (e.kind === 'dir') browseInto(p);
                        else { setModal({ ...modal, file: p }); setBrowse(null); }
                      },
                    }, `${e.kind === 'dir' ? '📁' : '📄'} ${e.name}`))
                  : h('div', { style: { color: V.sub, padding: '4px 2px' } }, '（空目录）')))),
            // 开发基线（可选）：各仓分支选择 → /hk-new --base；既是开发分支基点，也是分析基点与归档合入目标
            Object.keys(ws?.gitBranches ?? {}).length > 0 && h('div', { style: S.field },
              h('label', { style: S.label }, '开发基线（可选，留空 = 仓库默认基线）'),
              Object.entries(ws.gitBranches).map(([repo, branches]) => h('div', { key: repo, style: { display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 } },
                h('span', { style: { minWidth: 90, fontSize: 12, color: V.sub } }, repo),
                h(Combobox, {
                  style: { flex: 1 },
                  value: (modal.base ?? {})[repo] ?? '',
                  placeholder: '默认（仓库基线）',
                  options: branches ?? [],
                  onChange: (v) => setModal({ ...modal, base: { ...(modal.base ?? {}), [repo]: v } }),
                }))),
              h('div', { style: { fontSize: 11, color: V.sub, marginTop: 2 } },
                '内核会从所选基线新建 feat/harness-<任务> 开发分支；归档默认合回该基线，同时作为 BA/SA/RR 的分析基点。')),
            h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
              h('button', { style: S.btn(false), onClick: () => { setModal(null); setBrowse(null); } }, '取消'),
              h('button', {
                style: S.btn(!modal.desc.trim() || (modal.name.trim() && !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(modal.name.trim())) || busy, true),
                disabled: !modal.desc.trim() || (modal.name.trim() && !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(modal.name.trim())) || busy,
                onClick: () => {
                  const mode = modal.mode ?? 'new';
                  const name = modal.name.trim() || '--auto';
                  const file = mode === 'new' && modal.file.trim() ? ` --file ${modal.file.trim()}` : '';
                  const basePairs = Object.entries(modal.base ?? {}).filter(([, b]) => (b ?? '').trim()).map(([r, b]) => `${r}:${b.trim()}`);
                  const base = basePairs.length > 0 ? ` --base ${basePairs.join(',')}` : '';
                  runFresh(mode === 'fix' ? `/hk-fix ${name} ${modal.desc.trim()}${base}` : `/hk-new ${name} ${modal.desc.trim()}${file}${base}`);
                  setModal(null);
                  setBrowse(null);
                },
              }, '立项')))),
        // Toast
        h('div', { style: S.toastWrap },
          toasts.map((tst) => h('div', {
            key: tst.id, style: S.toast(tst.ok),
            onClick: () => !tst.ok && setToasts((ts) => ts.filter((x) => x.id !== tst.id)),
          }, tst.text))),
      );
    }

    // ---------- 配置视图组件 ----------
    function ConfigView({ config, syncMeta, ws, busy, saveConfig, runInit, onOrchestrate, catalog, toast }) {
      const k = config.kit;
      const initGap = (ws?.attention ?? []).find((a) => a.kind === 'init-incomplete') ?? null;
      const modelEntry = (provider, model) => (catalog ?? [])
        .find((c) => c.provider === (provider || ''))?.models?.find((mo) => mo.id === model);
      const reasoningEfforts = (provider, model) => modelEntry(provider, model)?.reasoning?.efforts ?? [];
      // 默认 low：模型声明支持 low 时用它；不支持时回退该模型自己的默认（不硬塞一个
      // 它不认识的等级，DSH 会在派发前拒绝 unsupported explicit effort）。
      const defaultEffort = (provider, model) => {
        const efforts = reasoningEfforts(provider, model);
        if (efforts.some((e) => e.id === 'low')) return 'low';
        return modelEntry(provider, model)?.reasoning?.defaultEffort ?? '';
      };
      const providerMissing = (m) => !!m.provider && (catalog ?? []).length > 0 && !(catalog ?? []).some((c) => c.provider === m.provider);
      const toModelRow = (name, m) => ({
        name,
        provider: m.provider ?? '',
        model: m.model ?? '',
        reasoning_effort: m.reasoning_effort ?? defaultEffort(m.provider ?? '', m.model ?? ''),
      });
      const [branches, setBranches] = useState(() => Object.fromEntries((k.sources ?? []).map((s) => [s.name, s.branch ?? ''])));
      const [autoSync, setAutoSync] = useState(k.assets?.autoSync === true);
      const [autoClose, setAutoClose] = useState(k.worktree?.autoClose === true);
      const [targetSync, setTargetSync] = useState(k.worktree?.targetSync ?? 'safe');
      const [local, setLocal] = useState(null);
      const [localBusy, setLocalBusy] = useState(false);
      const [models, setModels] = useState(() => Object.entries(k.models ?? {}).map(([name, m]) => toModelRow(name, m)));
      const [applyMode, setApplyMode] = useState(k.applyMode ?? 'auto');
      useEffect(() => {
        setBranches(Object.fromEntries((k.sources ?? []).map((s) => [s.name, s.branch ?? ''])));
        setAutoSync(k.assets?.autoSync === true);
        setAutoClose(k.worktree?.autoClose === true);
        setTargetSync(k.worktree?.targetSync ?? 'safe');
        setModels(Object.entries(k.models ?? {}).map(([name, m]) => toModelRow(name, m)));
        setApplyMode(k.applyMode ?? 'auto');
      }, [ws.id]);
      const loadLocal = useCallback(() => {
        fetch(`/harness-kit/local?workspace=${encodeURIComponent(ws.id)}`, { cache: 'no-store' })
          .then((r) => r.json())
          .then((j) => setLocal(j.ok ? j : { sources: [] }))
          .catch(() => setLocal({ sources: [] }));
      }, [ws.id]);
      useEffect(() => { loadLocal(); }, [loadLocal]);
      const localAction = (repo, action, paths) => {
        setLocalBusy(true);
        fetch('/harness-kit/local', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workspace: ws.id, repo, action, paths }),
        }).then((r) => r.json()).then((j) => {
          toast(j.ok ? (j.notes?.length ? j.notes.join('；') : (action === 'approve' ? '已确认' : '已跳过')) : j.error || '操作失败', j.ok);
          if (j.ok) loadLocal();
        }).catch((e) => toast(e.message, false)).finally(() => setLocalBusy(false));
      };
      const kv = (label, value) => h('div', { style: S.kv }, h('span', { style: { color: V.sub, minWidth: 96 } }, label), h('span', null, value ?? '—'));

      return h('div', null,
        // ① 只读信息
        h('div', { style: S.section },
          h('div', { style: S.secTitle }, '资产仓库'),
          kv('地址', k.assets?.url),
          kv('分支', k.assets?.branch),
          kv('模式', ws?.sync?.layout === 'embedded' ? `${k.assets?.mode ?? 'local'}（随工作区仓管理）` : k.assets?.mode),
          kv('同步健康', syncMeta.label),
          kv('上次检查', config.sync?.checkedAt ? new Date(config.sync.checkedAt).toLocaleString() : '—'),
          kv('内容包', k.pack),
          kv('宿主', (k.hosts ?? []).join('、'))),
        // M2：池化工作区概览（本机台账）
        ws?.slots && Object.keys(ws.slots).length > 0 && h('div', { style: S.section },
          h('div', { style: S.secTitle }, '工作区池（本机）'),
          Object.entries(ws.slots).map(([repo, arr]) => h('div', { key: repo, style: { fontSize: 12, marginBottom: 6 } },
            h('div', { style: { fontWeight: 600, marginBottom: 2 } }, repo),
            arr.length === 0 && h('div', { style: { color: V.sub } }, '无 slot（并发任务出现时自动创建）'),
            arr.map((s) => h('div', { key: s.slot, style: { marginBottom: 3 } },
              h('div', { style: { color: s.state === 'stale-unmerged' ? V.warn : V.sub } },
                `${s.slot}：${s.state === 'stale-unmerged' ? '⚠ 保留未释放' : `任务 ${s.task}`} · ${s.branch}`),
              // 完整路径（点击复制，方便直接 cd/在文件管理器打开）
              h('div', {
                style: { fontFamily: 'monospace', fontSize: 11, color: V.sub, wordBreak: 'break-all', cursor: 'copy' },
                title: '点击复制完整路径',
                onClick: () => { try { navigator.clipboard?.writeText(`${ws.path}/.worktrees/${repo}/${s.slot}`); toast('路径已复制'); } catch { /* 剪贴板不可用时无操作 */ } },
              }, `${ws.path}/.worktrees/${repo}/${s.slot}`)))))),
        // 本机配置（git-ignored）：确认一次，新 slot 自动补齐；只影响本机，不进团队资产
        h('div', { style: S.section },
          h('div', { style: S.secTitle }, '本机配置（git-ignored）'),
          h('div', { style: { fontSize: 12, color: V.sub, marginBottom: 8 } },
            '从主工作树发现本地配置候选；确认后写入本机清单，并为已绑定 slot 补齐。只影响本机，不提交到资产仓库。'),
          local === null && h('div', { style: { fontSize: 12, color: V.sub } }, '扫描中…'),
          local && (local.sources ?? []).length === 0 && h('div', { style: { fontSize: 12, color: V.sub } }, '未登记子工程。'),
          local && (local.sources ?? []).map((s) => {
            const pending = (s.candidates ?? []).filter((c) => c.pending);
            return h('div', { key: s.name, style: { marginBottom: 10, paddingBottom: 8, borderBottom: `1px solid ${V.border}` } },
              h('div', { style: { fontSize: 12, fontWeight: 600, marginBottom: 3 } },
                `${s.name}：已确认 ${s.approved.length} 个，待确认 ${pending.length} 个`,
                h('span', { style: { marginLeft: 8, color: V.sub, fontWeight: 400 } }, `模式 ${s.mode}`)),
              pending.length > 0 && h('div', { style: { marginBottom: 5 } },
                pending.slice(0, 8).map((c) => h('div', { key: c.path, style: { fontFamily: 'monospace', fontSize: 11, color: V.sub } },
                  `${c.reason === 'high' ? '高' : '配置'} · ${c.kind} · ${c.path}`)),
                pending.length > 8 && h('div', { style: { fontSize: 11, color: V.sub } }, `… 另 ${pending.length - 8} 个`)),
              pending.length > 0 && h('div', { style: { display: 'flex', gap: 6 } },
                h('button', { style: S.btn(localBusy, true), disabled: localBusy, onClick: () => localAction(s.name, 'approve', pending.map((c) => c.path)) }, '全部确认'),
                h('button', { style: S.btn(localBusy), disabled: localBusy, onClick: () => localAction(s.name, 'skip', pending.map((c) => c.path)) }, '全部跳过')));
          })),
        // ② 可配项
        (k.sources ?? []).length > 0 && h('div', { style: S.section },
          h('div', { style: S.secTitle }, '子工程基线分支'),
          k.sources.map((s) => h('div', { key: s.name, style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 } },
            h('span', { style: { minWidth: 120, fontSize: 12 } }, `${s.name}（${s.role}）`),
            h('input', { style: { ...S.input, width: 140 }, value: branches[s.name] ?? '', onChange: (e) => setBranches({ ...branches, [s.name]: e.target.value }) }))),
          h('button', {
            style: S.btn(busy, true), disabled: busy,
            onClick: () => saveConfig({ sources: k.sources.map((s) => ({ name: s.name, branch: branches[s.name] ?? s.branch })) }, '基线分支已保存'),
          }, '保存分支')),
        // 流程模式（原 .harness/config.json 的 apply-mode，已并入 kit.json）
        h('div', { style: S.section },
          h('div', { style: S.secTitle }, '流程模式'),
          h('div', { style: { fontSize: 12, color: V.sub, marginBottom: 8 } },
            'applyMode 决定 CR 通过后是否进入人工审查点（review = CR PASS 后暂停等人工审查，auto = 直接进 TE）。'),
          k.legacyConfig && h('div', { style: { ...S.attn('warn'), marginBottom: 8 } },
            h('span', null, '🟠'),
            h('span', { style: { flex: 1 } },
              `检测到旧 .harness/config.json（apply-mode=${k.legacyConfig.applyMode ?? '—'}, mainline-branch=${k.legacyConfig.mainlineBranch ?? '—'}）：保存本区后即覆盖到 kit.json，重跑初始化会自动删除旧文件`)),
          h('div', { style: { display: 'flex', gap: 14, alignItems: 'center', marginBottom: 8, fontSize: 12 } },
            ['auto', 'review'].map((m) => h('label', { key: m, style: { display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' } },
              h('input', { type: 'radio', name: 'hk-apply-mode', checked: applyMode === m, onChange: () => setApplyMode(m) }),
              h('span', null, m === 'auto' ? 'auto（CR PASS 直接进 TE）' : 'review（CR PASS 暂停等人工审查）'))),
          h('button', {
            style: S.btn(busy, true), disabled: busy,
            onClick: () => saveConfig({ applyMode }, '流程配置已保存'),
          }, '保存'))),
        h('div', { style: S.section },
          h('div', { style: S.secTitle }, '任务收尾'),
          h('div', { style: { fontSize: 12, color: V.sub, marginBottom: 8 } },
            '开启后归档会先同步目标基线并本地合入干净任务分支；冲突、目标脏或分叉时停下，不会自动 push。'),
          h('label', { style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, marginBottom: 8, cursor: 'pointer' } },
            h('input', { type: 'checkbox', checked: autoClose, onChange: (e) => setAutoClose(e.target.checked) }),
            '归档时自动收尾（autoClose）'),
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, fontSize: 12 } },
            h('span', { style: { minWidth: 96, color: V.sub } }, '目标同步'),
            h('select', { style: { ...S.select, width: 150 }, value: targetSync, onChange: (e) => setTargetSync(e.target.value) },
              h('option', { value: 'safe' }, 'safe（推荐）'),
              h('option', { value: 'ff-only' }, 'ff-only（严格）'),
              h('option', { value: 'off' }, 'off（不同步）'))),
          h('button', {
            style: S.btn(busy, true), disabled: busy,
            onClick: () => saveConfig({ worktree: { autoClose, targetSync } }, '任务收尾配置已保存'),
          }, '保存')),
        h('div', { style: S.section },
          h('div', { style: S.secTitle }, '自动同步'),
          h('label', { style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, marginBottom: 8, cursor: 'pointer' } },
            h('input', { type: 'checkbox', checked: autoSync, onChange: (e) => setAutoSync(e.target.checked) }),
            '归档后自动执行资产同步（/hk-sync）'),
          h('button', { style: S.btn(busy, true), disabled: busy, onClick: () => saveConfig({ autoSync }, autoSync ? '已开启自动同步' : '已关闭自动同步') }, '保存')),
        h('div', { style: S.section },
          h('div', { style: S.secTitle }, 'Worker 模型映射'),
          h('div', { style: { fontSize: 12, color: V.sub, marginBottom: 8 } },
            '键支持角色名（优先）或逻辑名（fast / coding / reasoning）；未配置的角色走会话默认。'),
          h('div', { style: { fontSize: 12, color: V.sub, marginBottom: 8 } },
            '推理等级随模型能力变化；新增默认 low，模型不支持时用该模型默认。'),
          models.length === 0 && h('div', { style: { fontSize: 12, color: V.sub, marginBottom: 8 } }, '尚未配置，全部角色走默认模型'),
          models.map((m, i) => h('div', { key: i, style: { display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' } },
            // 角色名下拉：流程角色（BA/SA/Dev/CR/TE 等，宿主扫 agents/ 目录）+ 已映射的逻辑模型名 + 自由输入
            h(Combobox, {
              style: { width: 130 },
              value: m.name, placeholder: '角色名',
              options: [...new Set([
                ...(config.roles ?? []).map((r) => r.role),
                ...(config.presetModels ?? []).map((x) => x.name),
              ])],
              onChange: (v) => setModels(models.map((x, j) => j === i ? { ...x, name: v } : x)),
            }),
            // provider 下拉：宿主已注册的全部 LLM provider；切换时清空 model（避免脏组合）；已配置但不可用的值保留显示并标灰
            h('select', {
              style: { ...S.select, width: 110 },
              value: m.provider ?? '',
              onChange: (e) => setModels(models.map((x, j) => j === i ? { ...x, provider: e.target.value, model: '', reasoning_effort: '' } : x)),
            }, [
              h('option', { key: '', value: '' }, '（会话默认）'),
              ...(catalog ?? []).map((c) => h('option', { key: c.provider, value: c.provider }, c.provider)),
            ]),
            providerMissing(m) && h('span', { style: { fontSize: 11, color: V.warn } }, '原 provider 不可用，请重选'),
            // model 下拉：所选 provider 的模型清单 + 自由输入
            h(Combobox, {
              style: { flex: 1 },
              value: m.model, placeholder: 'model',
              options: (catalog ?? []).find((c) => c.provider === (m.provider || ''))?.models?.map((mo) => mo.id) ?? [],
              onChange: (v) => setModels(models.map((x, j) => j === i ? { ...x, model: v, reasoning_effort: defaultEffort(x.provider, v) } : x)),
            }),
            // 推理等级：选项来自当前模型能力；不同厂商不是同一套枚举（DeepSeek off/low/high/max，
            // 其他模型可能 minimal/low/medium/high 或没有），不在这里硬编码“通用等级”。
            h('select', {
              style: { ...S.select, width: 100 },
              title: m.reasoning_effort ? `reasoning_effort=${m.reasoning_effort}` : '该模型未声明推理等级，使用默认',
              value: m.reasoning_effort ?? '',
              onChange: (e) => setModels(models.map((x, j) => j === i ? { ...x, reasoning_effort: e.target.value } : x)),
            }, [
              h('option', { key: '', value: '' }, '默认'),
              ...reasoningEfforts(m.provider, m.model).map((e) => h('option', { key: e.id, value: e.id }, e.name || e.id)),
              ...(m.reasoning_effort && !reasoningEfforts(m.provider, m.model).some((e) => e.id === m.reasoning_effort)
                ? [h('option', { key: '__missing', value: m.reasoning_effort }, `⚠ ${m.reasoning_effort}`)] : []),
            ]),
            h('button', { style: S.iconBtn, title: '删除', onClick: () => setModels(models.filter((_, j) => j !== i)) }, '×'))),
          (catalog ?? []).length === 0 && h('div', { style: { fontSize: 12, color: V.sub, marginBottom: 8 } }, '未发现可用模型清单（宿主未注册 LLM 或接口不可用），仍可手动输入'),
          h('div', { style: { display: 'flex', gap: 8, marginTop: 8 } },
            h('button', { style: S.btn(false), onClick: () => setModels([...models, { name: '', provider: '', model: '', reasoning_effort: '' }]) }, '＋ 添加映射'),
            h('button', {
              style: S.btn(busy || models.some((m) => !m.name.trim() || !m.model.trim() || providerMissing(m)), true),
              disabled: busy || models.some((m) => !m.name.trim() || !m.model.trim() || providerMissing(m)),
              onClick: () => saveConfig({ models: Object.fromEntries(models.map((m) => [m.name.trim(), {
                ...(m.provider.trim() ? { provider: m.provider.trim() } : {}),
                model: m.model.trim(),
                ...(m.reasoning_effort ? { reasoning_effort: m.reasoning_effort } : {}),
              }])) }, '模型映射已保存'),
            }, '保存'))),
        // ③ 初始化与子工程（面板化的 /hk-init、/hk-setup --add）
        h('div', { style: S.section },
          h('div', { style: S.secTitle }, '初始化与子工程'),
          h('div', { style: { fontSize: 12, color: V.sub, marginBottom: 8 } },
            '重跑初始化是幂等的：补齐骨架 / 模板 / 脚本并重新扫描子工程，不覆盖已有内容。资产换绑、解绑、删除子工程仍请在会话中执行 /hk-init、/hk-setup。'),
          initGap && h('div', { style: { ...S.attn('warn'), marginBottom: 8 } },
            h('span', null, '🟠'),
            h('span', { style: { flex: 1 } }, initGap.text),
            h('button', { style: S.btn(busy, true), disabled: busy, onClick: onOrchestrate }, '启动初始化编排')),
          ws?.init && !ws.init.done && h('div', { style: { ...S.attn('warn'), marginBottom: 8 } },
            h('span', null, '🔧'),
            h('span', { style: { flex: 1 } }, `初始化进行中：${ws.init.stage}${ws.init.detail ? ` — ${ws.init.detail}` : ''}（刷新不影响，完成后再重跑以免重复克隆）`)),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            h('button', { style: S.btn(busy || (ws?.init && !ws.init.done), true), disabled: busy || !!(ws?.init && !ws.init.done), title: ws?.init && !ws.init.done ? '初始化进行中，请等待完成' : undefined, onClick: () => runInit({}, '骨架/脚本已幂等补齐（子工程文档由初始化编排生成）') }, '重跑初始化'),
            h(AddSourceForm, { busy, onSubmit: (spec) => runInit({ sources: [spec] }, `子工程 ${spec.name || spec.url} 已登记`) }))),
      );
    }

    // ---------- Combobox：可输入 + 可下拉选择（解决原生 datalist 点击无反应问题） ----------
    function Combobox({ value, onChange, options = [], placeholder = '', style: extraStyle, suggest }) {
      const wrapRef = useRef(null);
      const [open, setOpen] = useState(false);
      const filtered = (suggest ?? options).filter((o) => !value || o.toLowerCase().includes(value.toLowerCase()));
      useEffect(() => {
        if (!open) return undefined;
        const close = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
        document.addEventListener('mousedown', close);
        return () => document.removeEventListener('mousedown', close);
      }, [open]);
      return h('div', { ref: wrapRef, style: { position: 'relative', ...extraStyle } },
        h('input', {
          style: { ...S.input, width: '100%' }, value, placeholder,
          onChange: (e) => { onChange(e.target.value); setOpen(true); },
          onFocus: () => setOpen(true),
        }),
        h('button', {
          type: 'button', title: '选择',
          style: { position: 'absolute', right: 3, top: '50%', transform: 'translateY(-50%)', width: 22, height: 22, border: 'none', background: 'transparent', color: V.sub, cursor: 'pointer', fontSize: 10, padding: 0 },
          onClick: (e) => { e.preventDefault(); setOpen(!open); },
        }, open ? '▴' : '▾'),
        open && h('div', {
          style: { position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 40, maxHeight: 200, overflowY: 'auto', background: V.bg, border: `1px solid ${V.border2}`, borderRadius: 8, boxShadow: V.modalShadow, marginTop: 2 },
        }, filtered.length === 0
          ? h('div', { style: { padding: '6px 8px', fontSize: 12, color: V.sub } }, '无匹配项')
          : filtered.map((o) => h('div', {
              key: o, onClick: () => { onChange(o); setOpen(false); },
              style: { padding: '4px 8px', fontSize: 12, cursor: 'pointer', color: V.text, fontFamily: 'monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
              onMouseEnter: (e) => { e.currentTarget.style.background = V.brand; e.currentTarget.style.color = V.brandInvert; },
              onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = V.text; },
            }, o))));
    }

    // ---------- 工作区开通引导（新建 / 打开已有） ----------
    const ROLE_OPTIONS = ['backend', 'frontend', 'app'];
    const EMPTY_SOURCE = { url: '', name: '', path: '', role: '', branch: '' };
    // path 派生预览（后端 addSource 同款规则）：显式 role 在批次内唯一 → services/<role>；否则 services/<仓名>
    const repoBaseName = (url) => (url.trim().split('/').pop() || '').replace(/\.git$/, '');
    const derivePathHint = (s, siblings = []) => {
      const role = (s.role ?? '').trim();
      if (role && !siblings.some((o) => o !== s && (o.role ?? '').trim() === role)) return `services/${role}`;
      return `services/${repoBaseName(s.url || '') || '<仓名>'}`;
    };

    // 目录预检结果行（新建向导用）
    function InspectLine({ info, registered }) {
      if (!info || !info.path) return null;
      if (!info.exists) return h('div', { style: { fontSize: 12, color: V.err, marginTop: 6 } }, '目录不存在，请先在本地创建');
      if (!info.isDir) return h('div', { style: { fontSize: 12, color: V.err, marginTop: 6 } }, '该路径不是目录');
      const bits = [];
      if (info.hasKit) bits.push(['✓ 已初始化（.harness/kit.json）', V.ok]);
      else if (info.hasHarness) bits.push(['⚠ 已有 .harness 但缺 kit.json（提交时自动补齐）', V.warn]);
      else bits.push(['未初始化', V.sub]);
      if (registered) bits.push([`已注册：${registered.title || registered.id}`, V.brand]);
      return h('div', { style: { fontSize: 12, color: V.sub, marginTop: 6 } },
        bits.map(([t, c], i) => h('span', { key: i, style: { color: c, marginRight: 10 } }, t)));
    }

    function OnboardView({ mode, setMode, canClose, onClose, uiWorkspace, toast, busy, setBusy, pickDirectory, initialPath, onDone, onSwitchToNew }) {
      const head = h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, margin: '12px 0' } },
        (mode !== 'choice' || canClose) && h('button', { style: S.iconBtn, onClick: () => (mode === 'choice' ? onClose() : setMode('choice')) }, '←'),
        h('span', { style: S.hTitle }, mode === 'new' ? '新建 Harness 工作区' : mode === 'open' ? '打开已有工作区' : '开始使用 Harness'));
      if (mode === 'new') {
        return h('div', null, head,
          h(NewWorkspaceForm, { uiWorkspace, toast, busy, setBusy, pickDirectory, initialPath, onDone, onFinish: onClose, onBack: () => setMode('choice') }));
      }
      if (mode === 'open') {
        return h('div', null, head,
          h(OpenWorkspaceForm, { toast, busy, setBusy, pickDirectory, onDone, onFinish: onClose, onBack: () => setMode('choice'), onSwitchToNew }));
      }
      return h('div', null, head,
        h('div', { style: { fontSize: 12, color: V.sub, marginBottom: 12 } },
          '把任意本地目录开通为 Harness 作战室：登记到 DSH、物化 .harness 资产、登记子工程，全程在面板完成。'),
        h('div', { style: { display: 'flex', gap: 12, flexWrap: 'wrap' } },
          h('div', { style: S.obCard, onClick: () => setMode('new') },
            h('div', { style: { fontSize: 22 } }, '🆕'),
            h('div', { style: { ...S.secTitle, margin: '6px 0 4px' } }, '新建工作区'),
            h('div', { style: { fontSize: 12, color: V.sub } },
              '选择一个本地目录（可以是空目录），通过向导表单完成初始化：资产仓库绑定 + 子工程登记（等价 /hk-init 与 /hk-setup）。')),
          h('div', { style: S.obCard, onClick: () => setMode('open') },
            h('div', { style: { fontSize: 22 } }, '📂'),
            h('div', { style: { ...S.secTitle, margin: '6px 0 4px' } }, '打开已有工作区'),
            h('div', { style: { fontSize: 12, color: V.sub } },
              '选择已初始化的 Harness 工作区目录（须包含 .harness/kit.json），直接接入作战室面板。'))));
    }

    // 新建向导：目录 → 资产仓库 → 子工程 → 提交（create + init），成功后出报告与后续动作
    function NewWorkspaceForm({ uiWorkspace, toast, busy, setBusy, pickDirectory, initialPath, onDone, onFinish, onBack }) {
      const [wsPath, setWsPath] = useState(initialPath ?? '');
      const [info, setInfo] = useState(null); // {inspect, registered}
      const [mode, setMode] = useState('local');
      const [assetUrl, setAssetUrl] = useState('');
      const [assetBranch, setAssetBranch] = useState('');
      const [sources, setSources] = useState(() => [{ ...EMPTY_SOURCE }]);
      const [err, setErr] = useState(null);
      const [result, setResult] = useState(null); // {report, wsId, sources, sourceErrors}
      const [progress, setProgress] = useState(null); // 初始化进度 {stage, detail, startedAt, done}
      const pollRef = useRef(null);
      // 环境预检：提交前暴露 git / Python 3 缺失项，并给出对应平台的安装命令。
      const [env, setEnv] = useState(null);
      const [envBusy, setEnvBusy] = useState(false);
      const checkEnv = useCallback(async () => {
        setEnvBusy(true);
        try {
          const j = await fetch('/harness-kit/env').then((r) => r.json());
          setEnv(j.ok ? j : { error: j.error || '检查失败' });
        } catch (e) {
          setEnv({ error: String(e?.message || e) });
        } finally {
          setEnvBusy(false);
        }
      }, []);
      useEffect(() => { void checkEnv(); }, [checkEnv]);

      const doInspect = useCallback((p) => {
        if (!p || !p.trim()) { setInfo(null); return; }
        fetch('/harness-kit/workspace/inspect', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: p.trim() }),
        }).then((r) => r.json()).then((j) => { if (j.ok) setInfo(j); }).catch(() => {});
      }, []);
      useEffect(() => { if (initialPath) doInspect(initialPath); }, []); // 来自「打开」转「新建」的预填目录

      const pick = async () => {
        const p = await pickDirectory();
        if (p) { setWsPath(p); doInspect(p); }
        else if (!globalThis.__DSH_DIRECTORY_PICKER__?.pick && !uiWorkspace?.pickDirectory) {
          toast('当前宿主不支持目录选择器，请手工输入绝对路径', false);
        }
      };

      const setSrc = (i, patch) => setSources((ss) => ss.map((x, j) => (j === i ? { ...x, ...patch } : x)));
      // url 失焦时只补名称（从 url 取仓名）。
      // 路径不预填实值——留空的 path 由后端按「role → services/<role>」派生，placeholder 实时预览；
      // 角色不自动猜——角色必选，由人显式确认（2026-11-17 定：猜测会把 path 实值写死成仓名，选角色后不生效）
      const derive = (i) => setSources((ss) => ss.map((x, j) => {
        if (j !== i) return x;
        const name = x.name.trim() || (x.url.trim() ? x.url.trim().split('/').pop().replace(/\.git$/, '') : '');
        const next = { ...x };
        if (!next.name.trim() && name) next.name = name;
        return next;
      }));

      const submit = async () => {
        setErr(null); setBusy(true); setProgress(null);
        try {
          const post = (url, body) => fetch(url, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
          }).then((r) => r.json());
          // ① 预检：目录必须已存在
          const ij = await post('/harness-kit/workspace/inspect', { path: wsPath.trim() });
          if (!ij.ok || !ij.inspect.isDir) throw new Error(ij.inspect?.exists ? '该路径不是目录' : '目录不存在，请先在本地创建');
          // ② 注册（幂等：已注册直接复用）
          let reg = ij.registered;
          if (!reg) {
            const cj = await post('/harness-kit/workspace/create', { path: wsPath.trim() });
            if (!cj.ok) throw new Error(cj.error || '注册工作区失败');
            reg = cj.workspace;
          }
          // ③ 初始化：宿主异步任务化——POST 立即返回，后台执行 + 进度轮询。
          // 这样大仓克隆（十几分钟）期间刷新/重载页面都不会中断任务（旧实现挂在单请求上，
          // 一刷新就报 "Failed to fetch"，2026-11-17 事故）。
          const j = await post('/harness-kit/workspace/init', {
            workspace: reg.id,
            assets: {
              mode,
              ...(mode === 'url' ? { url: assetUrl.trim() } : {}),
              ...(assetBranch.trim() ? { branch: assetBranch.trim() } : {}),
            },
            sources: sources.filter((s) => s.url.trim()).map((s) => {
              const spec = { url: s.url.trim() };
              for (const k of ['name', 'path', 'role', 'branch']) if (s[k].trim()) spec[k] = s[k].trim();
              return spec;
            }),
          });
          if (!j.ok) throw new Error(j.error || '初始化失败');
          const final = await new Promise((resolve, reject) => {
            let settled = false;
            const timer = setInterval(async () => {
              try {
                const p = await fetch(`/harness-kit/workspace/init-progress?workspace=${encodeURIComponent(reg.id)}`, { cache: 'no-store' }).then((r) => r.json());
                if (!p.ok || !p.progress) return;
                setProgress(p.progress);
                if (p.progress.done && !settled) {
                  settled = true;
                  clearInterval(timer);
                  if (p.progress.error) reject(new Error(p.progress.error));
                  else resolve(p.progress.result ?? null);
                }
              } catch { /* 单次轮询失败继续（任务在宿主侧照常执行） */ }
            }, 800);
            pollRef.current = timer;
          });
          if (!final) throw new Error('初始化状态丢失，请到「配置」页重跑初始化查看结果');
          setResult({ report: final.report, wsId: reg.id, sources: final.sources ?? [], sourceErrors: final.sourceErrors ?? [] });
          onDone(reg.id);
          toast('初始化完成');
        } catch (e) { setErr(String(e?.message || e)); }
        finally {
          if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
          setBusy(false);
        }
      };

      // 初始化编排（steer）需要活会话：打开工作区会话后转发 /hk-init
      const steer = () => {
        const wsId = result.wsId;
        onFinish();
        if (uiWorkspace?.openWorkspace) { try { uiWorkspace.openWorkspace(wsId); } catch { /* 忽略 */ } }
        toast('正在打开会话并提交初始化编排…');
        setTimeout(() => {
          fetch('/harness-kit/command', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ workspace: wsId, line: '/hk-init' }),
          }).then((r) => r.json()).then((j) => {
            if (j.ok && j.sessionId) { try { uiWorkspace?.openSession?.(j.sessionId); } catch { /* 忽略 */ } }
            toast(j.ok ? '初始化编排已提交 PM（探测子工程 → 生成文档 / 索引）' : (j.error || '提交失败'), j.ok);
          }).catch((e) => toast(e.message, false));
        }, 2500);
      };

      if (result) {
        return h('div', null,
          h('div', { style: { fontSize: 16, marginBottom: 4 } }, '✅ 工作区已就绪'),
          h('div', { style: S.pre }, result.report),
          result.sourceErrors.length > 0 && h('div', { style: { fontSize: 12, color: V.warn, marginTop: 6 } },
            `部分子工程登记失败：${result.sourceErrors.join('；')}`),
          h('div', { style: { display: 'flex', gap: 8, marginTop: 12 } },
            result.sources.length > 0 && h('button', { style: S.btn(false, true), onClick: steer },
              '启动初始化编排（文档生成 + 编译启动验证）'),
            h('button', { style: S.btn(false), onClick: onFinish }, '进入作战室')));
      }

      const submitDisabled = busy || !wsPath.trim()
        || (mode === 'url' && !assetUrl.trim())
        || !!(info && info.inspect && info.inspect.path && !info.inspect.isDir)
        // 角色强制确认（2026-11-17 定）：登记的每个仓库必须显式选角色，不再静默自动推断
        || sources.some((s) => s.url.trim() && !s.role.trim());

      // 环境检查卡片：缺失项直接给安装命令，安装后点「重新检查」
      const envCard = h('div', { style: S.section },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 } },
          h('div', { style: { ...S.secTitle, marginBottom: 0 } }, '环境检查'),
          h('span', { style: { flex: 1 } }),
          h('button', { style: S.btn(envBusy), disabled: envBusy, onClick: checkEnv }, envBusy ? '检查中…' : '重新检查')),
        !env && h('div', { style: { fontSize: 12, color: V.sub } }, '正在检查 git / Python 3…'),
        env?.error && h('div', { style: { fontSize: 12, color: V.err, whiteSpace: 'pre-wrap' } }, `检查失败：${env.error}`),
        env?.tools && env.tools.map((t) => h('div', { key: t.id, style: { padding: '4px 0', fontSize: 12 } },
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline' } },
            h('span', { style: { color: t.ok ? V.ok : V.warn, fontWeight: 600 } }, `${t.ok ? '✓' : '✗'} ${t.name}`),
            h('span', { style: { color: V.sub } }, t.ok ? (t.version || '可用') : t.purpose)),
          !t.ok && h('div', { style: { marginTop: 3, paddingLeft: 18, color: V.sub } },
            h('div', null, '安装：',
              h('code', { style: { fontSize: 11, padding: '1px 6px', borderRadius: 4, background: V.fieldBg } }, t.install.command)),
            h('a', { href: t.install.url, target: '_blank', rel: 'noreferrer', style: { color: V.brand, fontSize: 11 } }, '查看安装说明')))),
        env?.tools && !env.allOk && h('div', { style: { fontSize: 11, color: V.warn, marginTop: 4 } },
          '缺失项不会阻止创建，但用到对应功能时会失败；安装后点「重新检查」。'));

      return h('div', null,
        envCard,
        // ① 目录
        h('div', { style: S.section },
          h('div', { style: S.secTitle }, '① 工作区目录'),
          h('div', { style: { display: 'flex', gap: 8 } },
            h('input', {
              style: { ...S.input, flex: 1 }, value: wsPath,
              placeholder: '本地目录绝对路径（须已存在）',
              onChange: (e) => setWsPath(e.target.value),
              onBlur: () => doInspect(wsPath),
            }),
            h('button', { style: S.btn(busy), disabled: busy, onClick: pick }, '浏览…')),
          h(InspectLine, { info: info?.inspect, registered: info?.registered }),
          info?.inspect?.hasKit && h('div', { style: { fontSize: 12, color: V.sub, marginTop: 4 } },
            '该目录已初始化，提交将按幂等重跑补齐（不会覆盖已有内容）。')),
        // ② 资产仓库
        h('div', { style: S.section },
          h('div', { style: S.secTitle }, '② 资产仓库（.harness）'),
          [['local', '本地模式', '不绑 git；需要团队共享时可稍后在会话中绑定'],
           ['init', '新建 git 仓库', '在 .harness 内 git init 并完成首次提交'],
           ['url', '绑定团队资产仓库', '克隆已有仓库；本地已有资产时可自动接管空远端']].map(([m, name, hint]) =>
            h('label', { key: m, style: { display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 6, cursor: 'pointer', fontSize: 12 } },
              h('input', { type: 'radio', name: 'hk-assets', checked: mode === m, onChange: () => setMode(m), style: { marginTop: 2 } }),
              h('span', null, h('b', null, name), h('span', { style: { color: V.sub } }, ` — ${hint}`)))),
          mode === 'url' && h('div', { style: { display: 'flex', gap: 8, marginTop: 4 } },
            h('input', { style: { ...S.input, flex: 2 }, value: assetUrl, placeholder: 'git 仓库地址（https / ssh）', onChange: (e) => setAssetUrl(e.target.value) }),
            h('input', { style: { ...S.input, flex: 1 }, value: assetBranch, placeholder: '分支（默认远端主分支）', onChange: (e) => setAssetBranch(e.target.value) }))),
        // ③ 子工程
        h('div', { style: S.section },
          h('div', { style: S.secTitle }, '③ 代码仓库（子工程，可稍后添加）'),
          sources.length === 0 && h('div', { style: { fontSize: 12, color: V.sub, marginBottom: 8 } },
            '暂不登记：初始化完成后可在「配置」页或会话 /hk-setup 中添加。'),
          sources.length > 0 && h('div', { style: { fontSize: 12, color: V.sub, marginBottom: 8 } },
            '名称默认取 git 仓名（身份键，任务跑起来后不可改，保持唯一可追溯）；角色是流程语义标签（模板选择/展示），每个仓库必选一个。'),
          sources.map((s, i) => h('div', { key: i, style: { borderTop: i ? `1px solid ${V.border}` : 'none', paddingTop: i ? 8 : 0, marginBottom: 8 } },
            h('div', { style: { display: 'flex', gap: 8, marginBottom: 6 } },
              h('input', {
                style: { ...S.input, flex: 1 }, value: s.url, placeholder: 'git 仓库地址',
                onChange: (e) => setSrc(i, { url: e.target.value }), onBlur: () => derive(i),
              }),
              h('button', { style: S.iconBtn, title: '移除', onClick: () => setSources((ss) => ss.filter((_, j) => j !== i)) }, '×')),
            h('div', { style: { display: 'flex', gap: 6 } },
              h('input', { style: { ...S.input, width: 110 }, value: s.name, placeholder: '名称', onChange: (e) => setSrc(i, { name: e.target.value }) }),
              h('input', { style: { ...S.input, flex: 1 }, value: s.path, placeholder: `路径（留空 = ${derivePathHint(s, sources)}）`, onChange: (e) => setSrc(i, { path: e.target.value }) }),
              h('select', { style: { ...S.select, borderColor: s.role.trim() ? undefined : V.warn }, value: s.role, onChange: (e) => setSrc(i, { role: e.target.value }) },
                h('option', { value: '' }, '请选择角色…'),
                ROLE_OPTIONS.map((r) => h('option', { key: r, value: r }, r))),
              h('input', { style: { ...S.input, width: 90 }, value: s.branch, placeholder: '分支', onChange: (e) => setSrc(i, { branch: e.target.value }) })))),
          h('button', { style: S.btn(false), onClick: () => setSources((ss) => [...ss, { ...EMPTY_SOURCE }]) }, '＋ 添加仓库')),
        // 提交区
        err && h('div', { style: { fontSize: 12, color: V.err, marginBottom: 10, whiteSpace: 'pre-wrap' } }, err),
        h('div', { style: { display: 'flex', gap: 8 } },
          h('button', { style: S.btn(false), onClick: onBack }, '返回'),
          h('button', { style: S.btn(submitDisabled, true), disabled: submitDisabled, onClick: submit },
            busy ? '执行中…' : '创建并初始化')),
        busy && h('div', { style: { fontSize: 11, color: V.sub, marginTop: 6 } },
          progress
            ? `正在执行：${progress.stage}${progress.detail ? ` — ${progress.detail}` : ''}` +
              `（已耗时 ${Math.max(0, Math.round((Date.now() - (progress.startedAt || Date.now())) / 1000))}s${progress.stage === '克隆子工程' ? '，大仓库可能数分钟' : ''}；刷新页面不会中断，任务在后台继续）`
            : '正在执行（克隆大型仓库可能需要数分钟，请耐心等待，勿重复提交）…'));
    }

    // 打开已有工作区：必须含 .harness/kit.json，否则引导改走新建向导
    function OpenWorkspaceForm({ toast, busy, setBusy, pickDirectory, onDone, onFinish, onBack, onSwitchToNew }) {
      const [wsPath, setWsPath] = useState('');
      const [err, setErr] = useState(null);
      const [notHarness, setNotHarness] = useState(false);

      const pick = async () => {
        const p = await pickDirectory();
        if (p) { setWsPath(p); setErr(null); setNotHarness(false); }
      };
      const submit = async () => {
        setErr(null); setNotHarness(false); setBusy(true);
        try {
          const j = await fetch('/harness-kit/workspace/open', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: wsPath.trim() }),
          }).then((r) => r.json());
          if (!j.ok) {
            setErr(j.error || '打开失败');
            if (j.code === 'not-harness') setNotHarness(true);
            return;
          }
          toast(`已打开工作区：${j.workspace.title || j.workspace.id}`);
          onDone(j.workspace.id);
          onFinish();
        } catch (e) { setErr(String(e?.message || e)); }
        finally {
          if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
          setBusy(false);
        }
      };

      return h('div', null,
        h('div', { style: S.section },
          h('div', { style: S.secTitle }, '工作区目录'),
          h('div', { style: { display: 'flex', gap: 8 } },
            h('input', {
              style: { ...S.input, flex: 1 }, value: wsPath,
              placeholder: '已初始化的 Harness 工作区目录',
              onChange: (e) => { setWsPath(e.target.value); setErr(null); setNotHarness(false); },
            }),
            h('button', { style: S.btn(busy), disabled: busy, onClick: pick }, '浏览…')),
          h('div', { style: { fontSize: 12, color: V.sub, marginTop: 6 } },
            '该目录必须包含 .harness/kit.json（由新建向导或 /hk-init 生成）。')),
        err && h('div', { style: { fontSize: 12, color: V.err, marginBottom: 10, whiteSpace: 'pre-wrap' } }, err),
        h('div', { style: { display: 'flex', gap: 8 } },
          h('button', { style: S.btn(false), onClick: onBack }, '返回'),
          notHarness && h('button', { style: S.btn(busy, true), disabled: busy, onClick: () => onSwitchToNew(wsPath.trim()) },
            '改为在此目录初始化 →'),
          h('button', { style: S.btn(busy || !wsPath.trim(), true), disabled: busy || !wsPath.trim(), onClick: submit },
            '打开工作区')));
    }

    // 配置视图内联：添加子工程（等价 /hk-setup --add）
    function AddSourceForm({ busy, onSubmit }) {
      const [open, setOpen] = useState(false);
      const [s, setS] = useState({ ...EMPTY_SOURCE });
      if (!open) return h('button', { style: S.btn(false), onClick: () => setOpen(true) }, '＋ 添加子工程');
      const set = (k) => (e) => setS({ ...s, [k]: e.target.value });
      return h('div', { style: { flex: '1 1 100%', marginTop: 8 } },
        h('div', { style: { display: 'flex', gap: 6, marginBottom: 6 } },
          h('input', { style: { ...S.input, flex: 1 }, value: s.url, placeholder: 'git 仓库地址', onChange: set('url') })),
        h('div', { style: { display: 'flex', gap: 6, marginBottom: 6 } },
          h('input', { style: { ...S.input, width: 100 }, value: s.name, placeholder: '名称', onChange: set('name') }),
          h('input', { style: { ...S.input, flex: 1 }, value: s.path, placeholder: `路径（留空 = ${derivePathHint(s)}）`, onChange: set('path') }),
          h('select', { style: { ...S.select, borderColor: s.role.trim() ? undefined : V.warn }, value: s.role, onChange: set('role') },
            h('option', { value: '' }, '角色（必选）'),
            ROLE_OPTIONS.map((r) => h('option', { key: r, value: r }, r))),
          h('input', { style: { ...S.input, width: 80 }, value: s.branch, placeholder: '分支', onChange: set('branch') })),
        h('div', { style: { fontSize: 11, color: V.sub, marginBottom: 6 } },
          '名称默认取 git 仓名（任务跑起来后不可改）；角色是流程语义标签，必选。'),
        h('div', { style: { display: 'flex', gap: 8 } },
          h('button', { style: S.btn(false), onClick: () => setOpen(false) }, '收起'),
          h('button', {
            style: S.btn(busy || !s.url.trim() || !s.role.trim(), true), disabled: busy || !s.url.trim() || !s.role.trim(),
            title: !s.role.trim() ? '请先选择角色' : undefined,
            onClick: () => {
              const spec = { url: s.url.trim() };
              for (const k of ['name', 'path', 'role', 'branch']) if (s[k].trim()) spec[k] = s[k].trim();
              onSubmit(spec);
              setS({ ...EMPTY_SOURCE });
              setOpen(false);
            },
          }, busy ? '登记中…' : '登记并克隆')));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // uiWorkspace 是界面服务，可能在插件 apply 时尚未就绪（冷启动/重载竞态）：
        // 必须在渲染时惰性解析，不能在这里一次性捕获——否则拿到 undefined 后
        // 「继续会话」等所有跳转会永久降级为「界面未提供工作区操作能力」报错（2026-11-17 事故）。
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: 'harness-kit', order: 20,
        }, Icon));
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock', id: 'harness-kit-attention', order: 5,
        }, (props) => h(AttentionDock, { ...props, ctx })));
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: 'harness-kit', id: 'harness-kit',
        }, (props) => h(Panel, { ...props, uiWorkspace: ctx.get('uiWorkspace') })));
      },
    };
  },
});
