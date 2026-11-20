import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	api,
	type Artifact,
	formatBytes,
	type Kind,
	KIND_LABEL,
	sourceLabel,
	timeAgo,
	type Visibility,
	VISIBILITY_LABEL,
} from "../api.ts";
import { ConfirmDialog, Icon, kindIcon, Thumbnail, useToast } from "../components.tsx";
import { Link, navigate, useLocation } from "../router.tsx";

const PAGE = 48;
const SORTS = [
	["updated", "Recently updated"],
	["created", "Recently created"],
	["title", "Title"],
	["size", "Largest"],
] as const;

export function GalleryPage() {
	const { search } = useLocation();
	const visibility = (search.get("visibility") ?? "") as Visibility | "";
	const kind = (search.get("kind") ?? "") as Kind | "";
	const sort = search.get("sort") ?? "updated";
	const q = search.get("q") ?? "";
	const toast = useToast();

	const [query, setQuery] = useState(q);
	const [data, setData] = useState<Awaited<ReturnType<typeof api.list>> | null>(null);
	const [items, setItems] = useState<Artifact[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [confirm, setConfirm] = useState(false);
	const reqId = useRef(0);

	const setParam = useCallback((key: string, value: string) => {
		const next = new URLSearchParams(location.search);
		if (value) next.set(key, value);
		else next.delete(key);
		navigate(`/${next.size ? `?${next}` : ""}`, { replace: key === "q" });
	}, []);

	// Debounced search box → URL
	useEffect(() => {
		if (query === q) return;
		const t = setTimeout(() => setParam("q", query.trim()), 250);
		return () => clearTimeout(t);
	}, [query, q, setParam]);

	const load = useCallback(
		async (offset = 0) => {
			const id = ++reqId.current;
			setLoading(true);
			try {
				const res = await api.list({ q, kind, visibility, sort, limit: PAGE, offset });
				if (id !== reqId.current) return;
				setData(res);
				setItems((prev) => (offset === 0 ? res.items : [...prev, ...res.items]));
				setError(null);
			} catch (err) {
				if (id === reqId.current) setError(err instanceof Error ? err.message : String(err));
			} finally {
				if (id === reqId.current) setLoading(false);
			}
		},
		[q, kind, visibility, sort],
	);

	useEffect(() => {
		setSelected(new Set());
		void load(0);
	}, [load]);

	const totals = useMemo(() => {
		const stats = data?.stats ?? [];
		return {
			count: stats.reduce((n, s) => n + s.n, 0),
			bytes: stats.reduce((n, s) => n + (s.bytes ?? 0), 0),
			kinds: stats.sort((a, b) => b.n - a.n),
		};
	}, [data]);

	const toggle = (id: string) =>
		setSelected((s) => {
			const next = new Set(s);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});

	const title = visibility ? VISIBILITY_LABEL[visibility] : "All artifacts";
	const selecting = selected.size > 0;

	return (
		<div className="page">
			<header className="page-head">
				<div>
					<h1>{title}</h1>
					<p className="muted">
						{totals.count} {totals.count === 1 ? "artifact" : "artifacts"} · {formatBytes(totals.bytes)}
					</p>
				</div>
				<label className="search">
					<Icon name="search" size={16} />
					<input
						type="search"
						placeholder="Search titles, descriptions, files"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						aria-label="Search artifacts"
					/>
				</label>
			</header>

			<div className="toolbar">
				<div className="chips" role="group" aria-label="Filter by type">
					<button type="button" className="chip" aria-pressed={!kind} onClick={() => setParam("kind", "")}>
						All
					</button>
					{totals.kinds.map((s) => (
						<button
							type="button"
							key={s.kind}
							className="chip"
							aria-pressed={kind === s.kind}
							onClick={() => setParam("kind", kind === s.kind ? "" : s.kind)}
						>
							<Icon name={kindIcon(s.kind)} size={14} />
							{KIND_LABEL[s.kind]}
							<span className="chip-count">{s.n}</span>
						</button>
					))}
				</div>
				<select className="select" value={sort} onChange={(e) => setParam("sort", e.target.value === "updated" ? "" : e.target.value)} aria-label="Sort">
					{SORTS.map(([v, label]) => (
						<option key={v} value={v}>
							{label}
						</option>
					))}
				</select>
			</div>

			{selecting ? (
				<div className="selection-bar" role="region" aria-label="Selection">
					<strong>{selected.size} selected</strong>
					<button type="button" className="btn" onClick={() => setSelected(new Set(items.map((i) => i.id)))}>
						Select all {items.length}
					</button>
					<span className="grow" />
					<button
						type="button"
						className="btn"
						onClick={async () => {
							await api.bulkShare([...selected], "link");
							toast(`Shared ${selected.size} by link`);
							void load(0);
						}}
					>
						<Icon name="globe" size={16} /> Share by link
					</button>
					<button
						type="button"
						className="btn"
						onClick={async () => {
							await api.bulkShare([...selected], "private");
							toast(`Made ${selected.size} private`);
							void load(0);
						}}
					>
						<Icon name="lock" size={16} /> Make private
					</button>
					<button type="button" className="btn btn-danger" onClick={() => setConfirm(true)}>
						<Icon name="trash" size={16} /> Delete
					</button>
					<button type="button" className="icon-btn" aria-label="Clear selection" onClick={() => setSelected(new Set())}>
						<Icon name="close" />
					</button>
				</div>
			) : null}

			{error ? (
				<div className="empty">
					<h2>Couldn't load artifacts</h2>
					<p>{error}</p>
					<button type="button" className="btn" onClick={() => load(0)}>
						Try again
					</button>
				</div>
			) : !loading && items.length === 0 ? (
				<EmptyState filtered={!!(q || kind || visibility)} />
			) : (
				<ul className="grid" aria-busy={loading}>
					{items.map((a) => (
						<li key={a.id} className={`card${selected.has(a.id) ? " is-selected" : ""}`}>
							<Link href={`/a/${a.id}`} className="card-link" aria-label={a.title} />
							<Thumbnail artifact={a} />
							<label className="card-check" title="Select">
								<input
									type="checkbox"
									checked={selected.has(a.id)}
									onChange={() => toggle(a.id)}
									aria-label={`Select ${a.title}`}
								/>
							</label>
							<div className="card-body">
								<h3 title={a.title}>{a.title}</h3>
								<div className="card-meta">
									<span className="kind-tag">
										<Icon name={kindIcon(a.kind)} size={13} />
										{KIND_LABEL[a.kind]}
									</span>
									<VisibilityBadge artifact={a} />
									<span className="muted">{timeAgo(a.updated_at)}</span>
								</div>
								{a.source || a.model ? (
									<div className="card-source muted" title={[sourceLabel(a.source), a.model].filter(Boolean).join(" · ")}>
										{[a.model, sourceLabel(a.source)].filter(Boolean).join(" · ")}
									</div>
								) : null}
							</div>
						</li>
					))}
					{loading && items.length === 0
						? Array.from({ length: 8 }, (_, i) => (
								<li key={`s${i}`} className="card card-skeleton">
									<div className="thumb" />
									<div className="card-body">
										<div className="sk sk-title" />
										<div className="sk sk-meta" />
									</div>
								</li>
							))
						: null}
				</ul>
			)}

			{data && items.length < data.total ? (
				<div className="load-more">
					<button type="button" className="btn" disabled={loading} onClick={() => load(items.length)}>
						{loading ? "Loading…" : `Load more (${data.total - items.length})`}
					</button>
				</div>
			) : null}

			<ConfirmDialog
				open={confirm}
				title={`Delete ${selected.size} ${selected.size === 1 ? "artifact" : "artifacts"}?`}
				body="Their files, versions and share links are removed permanently."
				confirmLabel="Delete"
				destructive
				onClose={() => setConfirm(false)}
				onConfirm={async () => {
					const res = await api.bulkDelete([...selected]);
					toast(`Deleted ${res.deleted.length}`);
					setConfirm(false);
					setSelected(new Set());
					void load(0);
				}}
			/>
		</div>
	);
}

export function VisibilityBadge({ artifact }: { artifact: Pick<Artifact, "visibility" | "expired"> }) {
	if (artifact.visibility === "private") return null;
	const expired = artifact.expired;
	return (
		<span className={`vis vis-${expired ? "expired" : artifact.visibility}`}>
			<Icon name={artifact.visibility === "password" ? "key" : "globe"} size={12} />
			{expired ? "Expired" : artifact.visibility === "password" ? "Password" : "Shared"}
		</span>
	);
}

function EmptyState({ filtered }: { filtered: boolean }) {
	if (filtered) {
		return (
			<div className="empty">
				<h2>No matches</h2>
				<p>Try a different search or filter.</p>
				<Link href="/" className="btn">
					Clear filters
				</Link>
			</div>
		);
	}
	return (
		<div className="empty empty-onboard">
			<Icon name="plug" size={28} />
			<h2>Publish your first artifact</h2>
			<p>
				Connect an assistant like Claude Code, Codex, Cursor or Gemini CLI to this site's MCP server, then ask it to publish
				something: a page, a report, a chart, an image.
			</p>
			<Link href="/settings" className="btn btn-primary">
				Connect an assistant
			</Link>
		</div>
	);
}
