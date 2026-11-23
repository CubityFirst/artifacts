import { useCallback, useEffect, useState } from "react";
import { api, formatBytes, formatDate, KIND_LABEL, timeAgo, type TrashedArtifact } from "../api.ts";
import { ConfirmDialog, Icon, kindIcon, useToast } from "../components.tsx";

type Data = Awaited<ReturnType<typeof api.trash>>;

export function TrashPage() {
	const toast = useToast();
	const [data, setData] = useState<Data | null>(null);
	const [items, setItems] = useState<TrashedArtifact[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState<string | null>(null);
	const [forever, setForever] = useState<TrashedArtifact | null>(null);
	const [confirmEmpty, setConfirmEmpty] = useState(false);

	const load = useCallback(async (offset = 0) => {
		setLoading(true);
		try {
			const res = await api.trash(offset);
			setData(res);
			setItems((prev) => (offset === 0 ? res.items : [...prev, ...res.items]));
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void load(0);
	}, [load]);

	const drop = (id: string) => {
		setItems((prev) => prev.filter((i) => i.id !== id));
		setData((d) => (d ? { ...d, total: d.total - 1 } : d));
	};

	const restore = async (a: TrashedArtifact) => {
		setBusy(a.id);
		try {
			await api.restoreFromTrash(a.id);
			toast(`Restored "${a.title}" as private`);
			drop(a.id);
		} catch (err) {
			toast(err instanceof Error ? err.message : "Couldn't restore", "error");
		} finally {
			setBusy(null);
		}
	};

	const total = data?.total ?? 0;

	return (
		<div className="page">
			<header className="page-head">
				<div>
					<h1>Trash</h1>
					<p className="muted" aria-live="polite">
						{!data
							? " "
							: total
								? `${total} ${total === 1 ? "artifact" : "artifacts"} · deleted for good 30 days after they were moved here`
								: "Deleted artifacts stay here for 30 days"}
					</p>
				</div>
				{total ? (
					<button type="button" className="btn btn-danger-ghost" onClick={() => setConfirmEmpty(true)}>
						<Icon name="trash" size={16} /> Empty trash
					</button>
				) : null}
			</header>

			{error ? (
				<div className="empty" role="alert">
					<h2>Couldn't load trash</h2>
					<p>{error}</p>
					<button type="button" className="btn" onClick={() => load(0)}>
						Try again
					</button>
				</div>
			) : !loading && items.length === 0 ? (
				<div className="empty">
					<Icon name="trash" size={28} />
					<h2>Trash is empty</h2>
					<p>Deleted artifacts wait here for 30 days, so you can restore them, before they're removed for good.</p>
				</div>
			) : (
				<div className="table-wrap" aria-busy={loading}>
					<table className="table trash-table">
						<thead>
							<tr>
								<th>Artifact</th>
								<th>Deleted</th>
								<th>Deleted for good</th>
								<th aria-label="Actions" />
							</tr>
						</thead>
						<tbody>
							{items.map((a) => (
								<tr key={a.id}>
									<td>
										<div className="user-cell">
											<span className="trash-glyph" aria-hidden="true">
												<Icon name={kindIcon(a.kind)} size={16} />
											</span>
											<div>
												<strong>{a.title}</strong>
												<span className="muted">
													{KIND_LABEL[a.kind]} · {formatBytes(a.size_bytes)}
												</span>
											</div>
										</div>
									</td>
									<td className="muted" data-label="Deleted">
										<time dateTime={new Date(a.deleted_at).toISOString()} title={formatDate(a.deleted_at)}>
											{timeAgo(a.deleted_at)}
										</time>
									</td>
									<td className="muted" data-label="Deleted for good">
										<time dateTime={new Date(a.purge_at).toISOString()} title={formatDate(a.purge_at)}>
											{/* The hourly purge can lag the 30-day mark by up to an hour. */}
											{a.purge_at <= Date.now() ? "Within the hour" : timeAgo(a.purge_at)}
										</time>
									</td>
									<td className="actions">
										<div className="trash-actions">
											<button type="button" className="btn btn-sm" disabled={busy === a.id} onClick={() => restore(a)}>
												<Icon name="history" size={15} /> Restore
											</button>
											<button
												type="button"
												className="btn btn-sm btn-danger-ghost"
												disabled={busy === a.id}
												onClick={() => setForever(a)}
											>
												Delete forever
											</button>
										</div>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}

			{data && items.length < data.total ? (
				<div className="load-more">
					<button type="button" className="btn" disabled={loading} onClick={() => load(items.length)}>
						{loading ? "Loading…" : `Load more (${data.total - items.length})`}
					</button>
				</div>
			) : null}

			<ConfirmDialog
				open={!!forever}
				title={`Delete "${forever?.title ?? ""}" forever?`}
				body="All its versions and files are removed. This can't be undone."
				confirmLabel="Delete forever"
				destructive
				onClose={() => setForever(null)}
				onConfirm={async () => {
					if (!forever) return;
					try {
						await api.deleteForever(forever.id);
						toast("Deleted forever");
						drop(forever.id);
					} catch (err) {
						toast(err instanceof Error ? err.message : "Couldn't delete", "error");
					}
					setForever(null);
				}}
			/>
			<ConfirmDialog
				open={confirmEmpty}
				title={`Empty trash?`}
				body={`${total} ${total === 1 ? "artifact is" : "artifacts are"} deleted forever, with all versions and files. This can't be undone.`}
				confirmLabel="Empty trash"
				destructive
				onClose={() => setConfirmEmpty(false)}
				onConfirm={async () => {
					try {
						let deleted = 0;
						let remaining = 0;
						// The server empties in batches; keep going until nothing is left or a batch makes no progress.
						for (;;) {
							const res = await api.emptyTrash();
							deleted += res.deleted;
							remaining = res.remaining;
							if (remaining === 0 || res.deleted === 0) break;
						}
						if (remaining) toast(`Deleted ${deleted} forever; ${remaining} couldn't be deleted. Try again.`, "error");
						else toast(`Deleted ${deleted} forever`);
					} catch (err) {
						toast(err instanceof Error ? err.message : "Couldn't empty trash", "error");
					}
					setConfirmEmpty(false);
					void load(0);
				}}
			/>
		</div>
	);
}
