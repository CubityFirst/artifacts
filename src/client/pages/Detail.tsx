import { useCallback, useEffect, useRef, useState } from "react";
import {
	api,
	type ArtifactDetail,
	formatBytes,
	formatDate,
	KIND_LABEL,
	sourceLabel,
	timeAgo,
	type Visibility,
} from "../api.ts";
import { ConfirmDialog, CopyButton, Icon, kindIcon, useToast } from "../components.tsx";
import { Link, navigate, useLocation } from "../router.tsx";
import { VisibilityBadge } from "./Gallery.tsx";

type Tab = "share" | "details" | "versions" | "files";
type Device = "desktop" | "tablet" | "phone";

export function DetailPage({ id }: { id: string }) {
	const { search } = useLocation();
	const versionParam = Number(search.get("v") || 0) || undefined;
	const [art, setArt] = useState<ArtifactDetail | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [tab, setTab] = useState<Tab>("share");
	const [device, setDevice] = useState<Device>("desktop");
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [frameKey, setFrameKey] = useState(0);
	const frameWrap = useRef<HTMLDivElement>(null);
	const toast = useToast();

	const reload = useCallback(async () => {
		try {
			setArt(await api.get(id, versionParam));
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, [id, versionParam]);

	useEffect(() => {
		void reload();
	}, [reload]);

	if (error) {
		return (
			<div className="page">
				<div className="empty" role="alert">
					<Icon name="file" size={28} />
					<h2>{error === "Artifact not found" ? "This artifact isn't here" : "Couldn't open this artifact"}</h2>
					<p>
						{error === "Artifact not found"
							? "It may have been deleted, or the link belongs to a different account."
							: error}
					</p>
					<div className="row">
						<Link href="/" className="btn btn-primary">
							Back to artifacts
						</Link>
						{error === "Artifact not found" ? null : (
							<button type="button" className="btn" onClick={() => void reload()}>
								Try again
							</button>
						)}
					</div>
				</div>
			</div>
		);
	}
	if (!art)
		return (
			<div className="detail" aria-busy="true" aria-label="Loading artifact">
				<header className="detail-head">
					<span className="icon-btn" />
					<div className="detail-title">
						<div className="sk sk-title" style={{ width: 260, height: 18 }} />
						<div className="sk sk-meta" style={{ width: 180 }} />
					</div>
				</header>
				<div className="detail-body">
					<section className="preview">
						<div className="preview-bar">
							<div className="sk" style={{ width: 96, height: 28 }} />
						</div>
						<div className="frame-wrap">
							<div className="sk sk-frame" />
						</div>
					</section>
					<aside className="panel">
						<div className="panel-body stack" style={{ alignContent: "start" }}>
							<div className="sk" style={{ height: 40 }} />
							<div className="sk" style={{ height: 56 }} />
							<div className="sk" style={{ height: 56 }} />
							<div className="sk" style={{ height: 56 }} />
						</div>
					</aside>
				</div>
			</div>
		);

	const viewingOld = art.viewing_version !== art.version;
	const openUrl = art.url && !viewingOld ? art.url : art.preview_url;
	const viewedAt = art.versions.find((v) => v.version === art.viewing_version)?.created_at;

	return (
		<div className="detail">
			<header className="detail-head">
				<Link href="/" className="icon-btn" aria-label="Back to artifacts">
					<Icon name="back" />
				</Link>
				<div className="detail-title">
					<TitleEditor art={art} onSaved={reload} />
					<div className="detail-sub">
						<span className="kind-tag">
							<Icon name={kindIcon(art.kind)} size={13} />
							{KIND_LABEL[art.kind]}
						</span>
						<VisibilityBadge artifact={art} />
						<span className="muted">
							v{art.version} · updated {timeAgo(art.updated_at)}
						</span>
					</div>
				</div>
				<div className="detail-actions">
					{art.url ? <CopyButton value={art.url} label="Copy link" /> : null}
					<a className="btn" href={openUrl} target="_blank" rel="noreferrer">
						<Icon name="external" size={16} /> Open
					</a>
				</div>
			</header>

			<div className="detail-body">
				<section className="preview" aria-label="Preview">
					{viewingOld ? (
						<div className="banner">
							<Icon name="history" size={16} />
							<span className="banner-text">
								<strong>
									Viewing v{art.viewing_version} of {art.version}
									{viewedAt ? `, from ${timeAgo(viewedAt)}` : ""}
								</strong>
								<span>Restoring publishes it as v{art.version + 1}. Nothing is deleted.</span>
							</span>
							<span className="grow" />
							<button
								type="button"
								className="btn btn-sm btn-primary"
								onClick={async () => {
									try {
										await api.restore(art.id, art.viewing_version);
										toast(`Restored as v${art.version + 1}`);
										navigate(`/a/${art.id}`, { replace: true });
									} catch (err) {
										toast(err instanceof Error ? err.message : "Couldn't restore this version", "error");
									}
								}}
							>
								Restore this version
							</button>
							<Link href={`/a/${art.id}`} className="btn btn-sm">
								Back to latest
							</Link>
						</div>
					) : null}
					<div className="preview-bar">
						<div className="seg" role="group" aria-label="Preview width">
							{(["desktop", "tablet", "phone"] as const).map((d) => (
								<button
									key={d}
									type="button"
									aria-pressed={device === d}
									aria-label={`${d} width`}
									title={`${d[0]!.toUpperCase()}${d.slice(1)} width`}
									onClick={() => setDevice(d)}
								>
									<Icon name={d === "desktop" ? "monitor" : d} size={16} />
								</button>
							))}
						</div>
						<span className="preview-entry muted">{art.viewing_entry}</span>
						<button
							type="button"
							className="icon-btn"
							aria-label="Reload preview"
							title="Reload preview"
							// Refetch first: the preview URL is a capability that expires after 2 hours.
							onClick={() => void reload().then(() => setFrameKey((k) => k + 1))}
						>
							<Icon name="refresh" size={16} />
						</button>
						<button
							type="button"
							className="icon-btn"
							aria-label="Full screen"
							title="Full screen"
							onClick={() => frameWrap.current?.requestFullscreen?.()}
						>
							<Icon name="maximize" size={16} />
						</button>
					</div>
					<div className={`frame-wrap frame-${device}`} ref={frameWrap}>
						<iframe
							key={`${art.preview_url}-${frameKey}`}
							src={art.preview_url}
							title={`Preview of ${art.title}`}
							sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"
							allow="fullscreen; clipboard-write; autoplay"
						/>
					</div>
				</section>

				<aside className="panel">
					<div className="tabs" role="tablist">
						{(
							[
								["share", "Share"],
								["details", "Details"],
								["versions", `Versions · ${art.versions.length}`],
								["files", `Files · ${art.file_count}`],
							] as const
						).map(([t, label]) => (
							<button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
								{label}
							</button>
						))}
					</div>
					<div className="panel-body" role="tabpanel">
						{tab === "share" ? <SharePanel art={art} onSaved={reload} /> : null}
						{tab === "details" ? <DetailsPanel art={art} onSaved={reload} onDelete={() => setConfirmDelete(true)} /> : null}
						{tab === "versions" ? <VersionsPanel art={art} /> : null}
						{tab === "files" ? <FilesPanel art={art} /> : null}
					</div>
				</aside>
			</div>

			<ConfirmDialog
				open={confirmDelete}
				title={`Delete "${art.title}"?`}
				body="All versions and files are removed and its links stop working. This can't be undone."
				confirmLabel="Delete artifact"
				destructive
				onClose={() => setConfirmDelete(false)}
				onConfirm={async () => {
					await api.remove(art.id);
					toast("Artifact deleted");
					navigate("/");
				}}
			/>
		</div>
	);
}

function TitleEditor({ art, onSaved }: { art: ArtifactDetail; onSaved: () => void }) {
	const [value, setValue] = useState(art.title);
	const toast = useToast();
	useEffect(() => setValue(art.title), [art.title]);
	const save = async () => {
		const next = value.trim();
		if (!next || next === art.title) return setValue(art.title);
		try {
			await api.update(art.id, { title: next });
			toast("Renamed");
			onSaved();
		} catch (err) {
			toast(err instanceof Error ? err.message : "Couldn't rename", "error");
			setValue(art.title);
		}
	};
	return (
		<label className="title-edit" title="Rename">
			<input
				className="title-input"
				value={value}
				aria-label="Title"
				onChange={(e) => setValue(e.target.value)}
				onBlur={save}
				onKeyDown={(e) => {
					if (e.key === "Enter") e.currentTarget.blur();
					if (e.key === "Escape") {
						setValue(art.title);
						requestAnimationFrame(() => (e.target as HTMLInputElement).blur());
					}
				}}
			/>
			<Icon name="pencil" size={14} className="title-edit-icon" />
		</label>
	);
}

const VIS_OPTIONS: { value: Visibility; title: string; body: string; icon: string }[] = [
	{ value: "private", title: "Private", body: "Only you, from this dashboard.", icon: "lock" },
	{ value: "link", title: "Anyone with the link", body: "No sign-in needed to view.", icon: "globe" },
	{ value: "password", title: "Link + password", body: "Visitors enter a password first.", icon: "key" },
];

const EXPIRY_PRESETS: [string, number][] = [
	["Never", 0],
	["1 day", 1],
	["7 days", 7],
	["30 days", 30],
];

function toLocalInput(ms: number) {
	const d = new Date(ms);
	d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
	return d.toISOString().slice(0, 16);
}

function SharePanel({ art, onSaved }: { art: ArtifactDetail; onSaved: () => void }) {
	const toast = useToast();
	const [visibility, setVisibility] = useState<Visibility>(art.visibility);
	const [password, setPassword] = useState("");
	const [showPassword, setShowPassword] = useState(false);
	// A past expiry isn't a useful starting value (and the server rejects it): start from "Never".
	const [expires, setExpires] = useState(art.expires_at && !art.expired ? toLocalInput(art.expires_at) : "");
	const [busy, setBusy] = useState(false);
	const [confirmRegen, setConfirmRegen] = useState(false);

	useEffect(() => {
		setVisibility(art.visibility);
		setExpires(art.expires_at && !art.expired ? toLocalInput(art.expires_at) : "");
		setPassword("");
	}, [art.visibility, art.expires_at, art.expired]);

	const expiresMs = expires ? new Date(expires).getTime() : null;
	const dirty =
		visibility !== art.visibility ||
		!!password ||
		(visibility !== "private" && expiresMs !== art.expires_at);
	const needsPassword = visibility === "password" && !art.has_password && !password;

	const save = async () => {
		setBusy(true);
		try {
			await api.share(art.id, {
				visibility,
				password: password || undefined,
				expires_at: visibility === "private" ? undefined : expiresMs,
			});
			toast(visibility === "private" ? "Artifact is private" : "Sharing updated");
			onSaved();
		} catch (err) {
			toast(err instanceof Error ? err.message : "Couldn't update sharing", "error");
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="stack">
			{art.url ? (
				<div className="share-link">
					<span className="share-url" title={art.url}>
						{art.url.replace(/^https?:\/\//, "")}
					</span>
					<CopyButton value={art.url} label="Copy link" className="btn btn-sm btn-primary" />
				</div>
			) : (
				<div className="share-link share-link-off">
					<Icon name="lock" size={16} />
					<span>No public link. Choose who can open it below to get one.</span>
				</div>
			)}
			{art.expired && art.expires_at ? (
				<p className="note note-warn" role="status">
					<strong>This link expired {timeAgo(art.expires_at)}.</strong> Visitors see a “Link expired” page. Save to reopen it
					with no expiry, or pick a new date below.
				</p>
			) : null}

			<fieldset className="radio-cards">
				<legend>Who can open it</legend>
				{VIS_OPTIONS.map((o) => (
					<label key={o.value} className="radio-card">
						<input
							type="radio"
							name="visibility"
							value={o.value}
							checked={visibility === o.value}
							onChange={() => setVisibility(o.value)}
						/>
						<Icon name={o.icon} size={18} />
						<span>
							<strong>{o.title}</strong>
							<span className="muted">{o.body}</span>
						</span>
					</label>
				))}
			</fieldset>

			{visibility === "password" ? (
				<div className="field">
					<label htmlFor="share-password">{art.has_password ? "New password" : "Password"}</label>
					<div className="input-affix">
						<input
							id="share-password"
							type={showPassword ? "text" : "password"}
							className="input"
							value={password}
							autoComplete="new-password"
							aria-describedby="share-password-hint"
							placeholder={art.has_password ? "Unchanged" : undefined}
							onChange={(e) => setPassword(e.target.value)}
						/>
						<button
							type="button"
							className="icon-btn"
							aria-label={showPassword ? "Hide password" : "Show password"}
							aria-pressed={showPassword}
							onClick={() => setShowPassword((s) => !s)}
						>
							<Icon name={showPassword ? "eyeOff" : "eye"} size={16} />
						</button>
					</div>
					<p className="hint" id="share-password-hint">
						{art.has_password ? "Leave blank to keep the current password. " : ""}
						Visitors enter it once; the page then stays open for them for 12 hours.
					</p>
				</div>
			) : null}

			{visibility !== "private" ? (
				<div className="field">
					<span id="expiry-label">Link expires</span>
					<div className="chips expiry-presets" role="group" aria-labelledby="expiry-label">
						{EXPIRY_PRESETS.map(([label, days]) => (
							<button
								key={label}
								type="button"
								className="chip"
								aria-pressed={days === 0 ? !expires : undefined}
								onClick={() => setExpires(days ? toLocalInput(Date.now() + days * 86_400_000) : "")}
							>
								{label}
							</button>
						))}
					</div>
					<input
						type="datetime-local"
						className="input"
						aria-labelledby="expiry-label"
						value={expires}
						min={toLocalInput(Date.now() + 60_000)}
						onChange={(e) => setExpires(e.target.value)}
					/>
					<p className="hint">
						{expiresMs ? `Stops working ${formatDate(expiresMs)} (${timeAgo(expiresMs)}).` : "Works until you change it."}
					</p>
				</div>
			) : null}

			<button
				type="button"
				className={dirty ? "btn btn-primary" : "btn btn-quiet"}
				disabled={!dirty || needsPassword || busy}
				onClick={save}
			>
				{busy ? (
					"Saving…"
				) : !dirty ? (
					<>
						<Icon name="check" size={16} /> Sharing is up to date
					</>
				) : needsPassword ? (
					"Enter a password to save"
				) : (
					"Save sharing"
				)}
			</button>

			{art.visibility !== "private" ? (
				<div className="subtle-section">
					<p className="muted">
						Regenerating gives the artifact a new address. Anyone holding the old link, or already past the password, loses
						access.
					</p>
					<button type="button" className="btn btn-sm" onClick={() => setConfirmRegen(true)}>
						<Icon name="link" size={15} /> Regenerate link
					</button>
				</div>
			) : null}

			<ConfirmDialog
				open={confirmRegen}
				title="Regenerate the share link?"
				body={
					<>
						<code className="strike">{art.url?.replace(/^https?:\/\//, "")}</code> stops working immediately, including for
						visitors who already entered the password. Send the new link to anyone who should keep access.
					</>
				}
				confirmLabel="Regenerate link"
				destructive
				onClose={() => setConfirmRegen(false)}
				onConfirm={async () => {
					await api.share(art.id, { regenerate_link: true });
					setConfirmRegen(false);
					toast("New link created");
					onSaved();
				}}
			/>
		</div>
	);
}

function DetailsPanel({ art, onSaved, onDelete }: { art: ArtifactDetail; onSaved: () => void; onDelete: () => void }) {
	const [description, setDescription] = useState(art.description);
	const [saved, setSaved] = useState(false);
	const toast = useToast();
	useEffect(() => setDescription(art.description), [art.description]);
	const rows: [string, React.ReactNode][] = [
		["Type", KIND_LABEL[art.kind]],
		["Entry file", <code key="e">{art.entry}</code>],
		["Size", `${formatBytes(art.size_bytes)} · ${art.file_count} ${art.file_count === 1 ? "file" : "files"}`],
		["Published by", sourceLabel(art.source) || "—"],
		["Model", art.model || "—"],
		["Created", formatDate(art.created_at)],
		["Updated", formatDate(art.updated_at)],
		["ID", <code key="i">{art.id}</code>],
	];
	return (
		<div className="stack">
			<label className="field">
				<span className="field-label-row">
					Description
					<span className="saved" role="status">
						{saved ? (
							<>
								<Icon name="check" size={13} /> Saved
							</>
						) : (
							"Saves when you click away"
						)}
					</span>
				</span>
				<textarea
					className="input"
					rows={3}
					value={description}
					placeholder="What is this?"
					onChange={(e) => setDescription(e.target.value)}
					onBlur={async () => {
						if (description === art.description) return;
						try {
							await api.update(art.id, { description });
							setSaved(true);
							setTimeout(() => setSaved(false), 2400);
							onSaved();
						} catch (err) {
							toast(err instanceof Error ? err.message : "Couldn't save", "error");
						}
					}}
				/>
			</label>
			<dl className="meta-list">
				{rows.map(([k, v]) => (
					<div key={k}>
						<dt>{k}</dt>
						<dd>{v}</dd>
					</div>
				))}
			</dl>
			<div className="subtle-section">
				<button type="button" className="btn btn-danger-ghost" onClick={onDelete}>
					<Icon name="trash" size={16} /> Delete artifact
				</button>
			</div>
		</div>
	);
}

function VersionsPanel({ art }: { art: ArtifactDetail }) {
	return (
		<ol className="versions">
			{art.versions.map((v) => {
				const current = v.version === art.version;
				const viewing = v.version === art.viewing_version;
				return (
					<li key={v.version} aria-current={viewing ? "true" : undefined}>
						<Link href={current ? `/a/${art.id}` : `/a/${art.id}?v=${v.version}`} className="version">
							<span className="version-n">v{v.version}</span>
							<span className="version-text">
								<strong>{v.message || "Updated"}</strong>
								<span className="muted version-meta">
									<span title={formatDate(v.created_at)}>{timeAgo(v.created_at)}</span>
									{v.source ? <span>{sourceLabel(v.source)}</span> : null}
									{v.model ? <span>{v.model}</span> : null}
								</span>
							</span>
							{current ? <span className="pill">Current</span> : null}
						</Link>
					</li>
				);
			})}
		</ol>
	);
}

const EXT_ICON: [RegExp, string][] = [
	[/\.html?$/, "html"],
	[/\.(md|markdown)$/, "markdown"],
	[/\.(png|jpe?g|gif|webp|avif|svg|ico)$/, "image"],
	[/\.(mp4|webm|mov|m4v)$/, "video"],
	[/\.(mp3|wav|ogg|m4a|flac)$/, "audio"],
	[/\.pdf$/, "pdf"],
	[/\.(csv|tsv|json|ya?ml|xml|toml)$/, "data"],
	[/\.(js|mjs|ts|tsx|jsx|css|py|rb|go|rs|sh|java|c|cpp|h)$/, "code"],
	[/\.txt$/, "text"],
];
const fileIcon = (path: string) => EXT_ICON.find(([re]) => re.test(path.toLowerCase()))?.[1] ?? "file";

function FilesPanel({ art }: { art: ArtifactDetail }) {
	const base = art.preview_url;
	return (
		<ul className="files">
			{art.files.map((f) => {
				const href = `${base}${f.path.split("/").map(encodeURIComponent).join("/")}`;
				return (
					<li key={f.path}>
						<Icon name={fileIcon(f.path)} size={16} />
						<a href={href} target="_blank" rel="noreferrer" className="file-path" title={f.path}>
							{f.path}
							{f.path === art.viewing_entry ? <span className="pill">entry</span> : null}
						</a>
						<span className="muted file-size">{formatBytes(f.size)}</span>
						<a href={`${href}?download=1`} className="icon-btn" aria-label={`Download ${f.path}`} title="Download">
							<Icon name="download" size={16} />
						</a>
					</li>
				);
			})}
		</ul>
	);
}
