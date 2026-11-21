import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import type { Artifact, Kind } from "./api.ts";

// Icons ------------------------------------------------------------------------

const PATHS: Record<string, ReactNode> = {
	grid: (
		<>
			<rect x="3" y="3" width="7" height="7" rx="1.5" />
			<rect x="14" y="3" width="7" height="7" rx="1.5" />
			<rect x="3" y="14" width="7" height="7" rx="1.5" />
			<rect x="14" y="14" width="7" height="7" rx="1.5" />
		</>
	),
	globe: (
		<>
			<circle cx="12" cy="12" r="9" />
			<path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
		</>
	),
	lock: (
		<>
			<rect x="4" y="11" width="16" height="10" rx="2" />
			<path d="M8 11V7a4 4 0 0 1 8 0v4" />
		</>
	),
	key: (
		<>
			<circle cx="7.5" cy="15.5" r="4.5" />
			<path d="m10.7 12.3 9.3-9.3M16 7l3 3M14 9l2 2" />
		</>
	),
	settings: (
		<>
			<circle cx="12" cy="12" r="3" />
			<path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
		</>
	),
	shield: <path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3Z" />,
	search: (
		<>
			<circle cx="11" cy="11" r="7" />
			<path d="m20 20-3.5-3.5" />
		</>
	),
	external: <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />,
	link: <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />,
	copy: (
		<>
			<rect x="9" y="9" width="11" height="11" rx="2" />
			<path d="M5 15V5a1 1 0 0 1 1-1h9" />
		</>
	),
	check: <path d="m5 12 5 5L20 7" />,
	trash: <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />,
	back: <path d="M15 18l-6-6 6-6" />,
	close: <path d="M6 6l12 12M18 6 6 18" />,
	history: (
		<>
			<path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
			<path d="M3 3v5h5M12 7v5l3 3" />
		</>
	),
	file: (
		<>
			<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" />
			<path d="M14 3v5h5" />
		</>
	),
	download: <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />,
	maximize: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />,
	monitor: (
		<>
			<rect x="3" y="4" width="18" height="12" rx="2" />
			<path d="M8 20h8M12 16v4" />
		</>
	),
	phone: (
		<>
			<rect x="7" y="2.5" width="10" height="19" rx="2" />
			<path d="M11 18.5h2" />
		</>
	),
	tablet: (
		<>
			<rect x="4.5" y="2.5" width="15" height="19" rx="2" />
			<path d="M11 18.5h2" />
		</>
	),
	logout: <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H4" />,
	alert: (
		<>
			<circle cx="12" cy="12" r="9" />
			<path d="M12 7.5v5.5M12 16.5v.01" />
		</>
	),
	eye: (
		<>
			<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" />
			<circle cx="12" cy="12" r="3" />
		</>
	),
	eyeOff: <path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2" />,
	pencil: <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4ZM13.5 6.5l4 4" />,
	refresh: <path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5" />,
	plus: <path d="M12 5v14M5 12h14" />,
	users: (
		<>
			<circle cx="9" cy="8" r="3.5" />
			<path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6" />
		</>
	),
	plug: <path d="M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0V8ZM12 17v5" />,
	// Kind glyphs
	html: <path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 5l-4 14" />,
	markdown: (
		<>
			<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" />
			<path d="M9 13h6M9 17h4M14 3v5h5" />
		</>
	),
	image: (
		<>
			<rect x="3" y="4" width="18" height="16" rx="2" />
			<circle cx="9" cy="10" r="2" />
			<path d="m21 16-5-5-9 9" />
		</>
	),
	video: (
		<>
			<rect x="3" y="5" width="13" height="14" rx="2" />
			<path d="m16 10 5-3v10l-5-3" />
		</>
	),
	audio: (
		<>
			<path d="M9 18V5l11-2v13" />
			<circle cx="6" cy="18" r="3" />
			<circle cx="17" cy="16" r="3" />
		</>
	),
	pdf: (
		<>
			<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" />
			<path d="M14 3v5h5M9 15h1.5a1.5 1.5 0 0 0 0-3H9v5" />
		</>
	),
	code: <path d="m9 8-5 4 5 4M15 8l5 4-5 4" />,
	text: <path d="M5 6h14M5 10h14M5 14h10M5 18h7" />,
	data: (
		<>
			<ellipse cx="12" cy="6" rx="8" ry="3" />
			<path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
		</>
	),
};

export function Icon({ name, size = 18, className }: { name: string; size?: number; className?: string }) {
	return (
		<svg
			className={className}
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={1.75}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			{PATHS[name] ?? PATHS.file}
		</svg>
	);
}

export const kindIcon = (kind: Kind) => (PATHS[kind] ? kind : "file");

// Avatar (the `picture` claim may 404, so fall back to initials) ---------------

export function Avatar({ name, src, size = 32 }: { name: string; src?: string | null; size?: number }) {
	const [failed, setFailed] = useState(false);
	const initials =
		name
			.split(/[\s@._-]+/)
			.filter(Boolean)
			.slice(0, 2)
			.map((p) => p[0]!.toUpperCase())
			.join("") || "?";
	let hue = 0;
	for (const ch of name) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
	return (
		<span className="avatar" style={{ width: size, height: size, fontSize: size * 0.4, "--hue": hue } as React.CSSProperties}>
			{src && !failed ? (
				<img src={src} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
			) : (
				<span aria-hidden="true">{initials}</span>
			)}
		</span>
	);
}

// Toasts -------------------------------------------------------------------------

type Toast = { id: number; message: string; tone: "ok" | "error" };
const ToastContext = createContext<(message: string, tone?: Toast["tone"]) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
	const [toasts, setToasts] = useState<Toast[]>([]);
	const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
	const push = useCallback(
		(message: string, tone: Toast["tone"] = "ok") => {
			const id = Date.now() + Math.random();
			setToasts((t) => [...t, { id, message, tone }]);
			// Errors stay until dismissed or 12s: long enough to read a real message.
			setTimeout(() => dismiss(id), tone === "error" ? 12000 : 2800);
		},
		[dismiss],
	);
	return (
		<ToastContext.Provider value={push}>
			{children}
			<div className="toasts" aria-live="polite">
				{toasts.map((t) => (
					<div key={t.id} className={`toast toast-${t.tone}`} role={t.tone === "error" ? "alert" : "status"}>
						<Icon name={t.tone === "ok" ? "check" : "alert"} size={16} />
						<span>{t.message}</span>
						{t.tone === "error" ? (
							<button type="button" className="toast-close" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
								<Icon name="close" size={14} />
							</button>
						) : null}
					</div>
				))}
			</div>
		</ToastContext.Provider>
	);
}

export const useToast = () => useContext(ToastContext);

// Copy button ----------------------------------------------------------------------

export function CopyButton({
	value,
	label = "Copy",
	className = "btn",
	iconOnly = false,
}: {
	value: string;
	label?: string;
	className?: string;
	iconOnly?: boolean;
}) {
	const [copied, setCopied] = useState(false);
	const toast = useToast();
	return (
		<button
			type="button"
			className={className}
			aria-label={iconOnly ? label : undefined}
			title={iconOnly ? label : undefined}
			onClick={async () => {
				try {
					await navigator.clipboard.writeText(value);
					setCopied(true);
					setTimeout(() => setCopied(false), 1600);
				} catch {
					toast("Couldn't copy to the clipboard", "error");
				}
			}}
		>
			<Icon name={copied ? "check" : "copy"} size={16} />
			{iconOnly ? null : copied ? "Copied" : label}
		</button>
	);
}

// Confirm dialog ---------------------------------------------------------------------

export function ConfirmDialog({
	open,
	title,
	body,
	confirmLabel,
	destructive,
	onConfirm,
	onClose,
}: {
	open: boolean;
	title: string;
	body: ReactNode;
	confirmLabel: string;
	destructive?: boolean;
	onConfirm: () => Promise<void> | void;
	onClose: () => void;
}) {
	const ref = useRef<HTMLDialogElement>(null);
	const cancelRef = useRef<HTMLButtonElement>(null);
	const confirmRef = useRef<HTMLButtonElement>(null);
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		const d = ref.current;
		if (!d) return;
		if (open && !d.open) {
			d.showModal();
			// React autoFocus only runs on mount, while the dialog is still closed. Enter on a destructive dialog should be the safe choice.
			(destructive ? cancelRef : confirmRef).current?.focus();
		}
		if (!open && d.open) d.close();
	}, [open]);
	return (
		<dialog ref={ref} className={destructive ? "dialog dialog-danger" : "dialog"} onClose={onClose} onCancel={onClose}>
			{destructive ? (
				<span className="dialog-icon" aria-hidden="true">
					<Icon name="alert" size={20} />
				</span>
			) : null}
			<h2>{title}</h2>
			<div className="dialog-body">{body}</div>
			<div className="dialog-actions">
				<button ref={cancelRef} type="button" className="btn" onClick={onClose} disabled={busy}>
					Cancel
				</button>
				<button
					type="button"
					className={destructive ? "btn btn-danger" : "btn btn-primary"}
					ref={confirmRef}
					disabled={busy}
					onClick={async () => {
						setBusy(true);
						try {
							await onConfirm();
						} finally {
							setBusy(false);
						}
					}}
				>
					{busy ? "Working…" : confirmLabel}
				</button>
			</div>
		</dialog>
	);
}

// Thumbnail ------------------------------------------------------------------------

const IFRAME_KINDS = new Set<Kind>(["html", "markdown", "code", "text", "data"]);

/** Live, lazily-mounted preview of an artifact for gallery cards. */
export function Thumbnail({ artifact }: { artifact: Artifact }) {
	const ref = useRef<HTMLDivElement>(null);
	const [visible, setVisible] = useState(false);
	const [scale, setScale] = useState(0.25);
	const [loaded, setLoaded] = useState(false);

	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const io = new IntersectionObserver(
			([e]) => {
				if (e?.isIntersecting) {
					setVisible(true);
					io.disconnect();
				}
			},
			{ rootMargin: "300px" },
		);
		io.observe(el);
		return () => io.disconnect();
	}, []);

	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		const ro = new ResizeObserver(([e]) => e && setScale(e.contentRect.width / 1280));
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	const src = artifact.preview_url;
	let content: ReactNode = null;
	if (visible && src) {
		if (IFRAME_KINDS.has(artifact.kind)) {
			content = (
				<iframe
					src={src}
					title=""
					tabIndex={-1}
					loading="lazy"
					sandbox="allow-scripts allow-same-origin"
					onLoad={() => setLoaded(true)}
					style={{ transform: `scale(${scale})`, opacity: loaded ? 1 : 0 }}
				/>
			);
		} else if (artifact.kind === "image") {
			content = <img src={src} alt="" loading="lazy" onLoad={() => setLoaded(true)} style={{ opacity: loaded ? 1 : 0 }} />;
		} else if (artifact.kind === "video") {
			content = (
				<video
					src={`${src}#t=0.5`}
					muted
					playsInline
					preload="metadata"
					onLoadedData={() => setLoaded(true)}
					style={{ opacity: loaded ? 1 : 0 }}
				/>
			);
		}
	}
	return (
		<div ref={ref} className={`thumb thumb-${artifact.kind}`} aria-hidden="true">
			<div className="thumb-glyph">
				<Icon name={kindIcon(artifact.kind)} size={28} />
				<span>{artifact.entry.split("/").pop()}</span>
			</div>
			{content}
		</div>
	);
}
