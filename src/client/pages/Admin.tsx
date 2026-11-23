import { useEffect, useState } from "react";
import { type AdminUser, ApiError, api, formatBytes, timeAgo } from "../api.ts";
import { useMe } from "../App.tsx";
import { Avatar, ConfirmDialog, useToast } from "../components.tsx";

export function AdminPage() {
	const me = useMe();
	const toast = useToast();
	const [users, setUsers] = useState<AdminUser[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [remove, setRemove] = useState<AdminUser | null>(null);

	const load = () =>
		api
			.adminUsers()
			.then((r) => setUsers(r.items))
			.catch((err) =>
				setError(err instanceof ApiError && err.status === 403 ? "Forbidden" : err instanceof Error ? err.message : String(err)),
			);
	useEffect(() => {
		void load();
	}, []);

	const totalBytes = users?.reduce((n, u) => n + u.bytes, 0) ?? 0;
	const totalArtifacts = users?.reduce((n, u) => n + u.artifact_count, 0) ?? 0;
	const trashCount = users?.reduce((n, u) => n + u.trash_count, 0) ?? 0;
	const trashBytes = users?.reduce((n, u) => n + u.trash_bytes, 0) ?? 0;

	return (
		<div className="page">
			<header className="page-head">
				<div>
					<h1>Admin</h1>
					<p className="muted">
						{users
							? `${users.length} users · ${totalArtifacts} artifacts · ${formatBytes(totalBytes)}, not counting trash` +
								(trashCount ? ` · ${trashCount} in trash (${formatBytes(trashBytes)})` : "")
							: error
								? " "
								: "Loading…"}
					</p>
				</div>
			</header>
			{error ? (
				<div className="empty" role="alert">
					<h2>Couldn't load users</h2>
					<p>{error === "Forbidden" ? "Your account doesn't have the admin role any more. Sign in again to refresh it." : error}</p>
					<button
						type="button"
						className="btn"
						onClick={() => {
							setError(null);
							void load();
						}}
					>
						Try again
					</button>
				</div>
			) : null}
			{users ? (
				<div className="table-wrap">
					<table className="table">
						<thead>
							<tr>
								<th>User</th>
								<th>Roles</th>
								<th className="num">Artifacts</th>
								<th className="num" title="Current versions of live artifacts; trash is listed underneath">
									Storage
								</th>
								<th>Last sign-in</th>
								<th aria-label="Actions" />
							</tr>
						</thead>
						<tbody>
							{users.map((u) => (
								<tr key={u.id}>
									<td>
										<div className="user-cell">
											<Avatar name={u.name || u.email || u.sub} src={u.picture} size={28} />
											<div>
												<strong>{u.name || u.email || u.sub}</strong>
												{u.name && u.email ? <span className="muted">{u.email}</span> : null}
											</div>
										</div>
									</td>
									<td>
										{u.roles.map((r) => (
											<span key={r} className={`pill${r === "admin" ? " pill-accent" : ""}`}>
												{r}
											</span>
										))}
									</td>
									<td className="num" data-label="Artifacts">
										{u.artifact_count}
										{u.trash_count ? <span className="muted small cell-sub">+{u.trash_count} in trash</span> : null}
									</td>
									<td className="num" data-label="Storage">
										{formatBytes(u.bytes)}
										{u.trash_count ? <span className="muted small cell-sub">+{formatBytes(u.trash_bytes)} in trash</span> : null}
									</td>
									<td className="muted" data-label="Last sign-in">
										{timeAgo(u.last_login_at)}
									</td>
									<td className="actions">
										{u.id !== me.user.id ? (
											<button type="button" className="btn btn-sm btn-danger-ghost" onClick={() => setRemove(u)}>
												Delete data
											</button>
										) : (
											<span className="muted small">You</span>
										)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			) : null}
			<ConfirmDialog
				open={!!remove}
				title={`Delete ${remove?.name || remove?.email || "this user"}'s data?`}
				body={`Removes their ${remove?.artifact_count ?? 0} artifacts${remove?.trash_count ? ` and ${remove.trash_count} in trash` : ""}, tokens and sessions from this site. Their cubityfir.st account isn't affected, and they can sign in again later with an empty library.`}
				confirmLabel="Delete user data"
				destructive
				onClose={() => setRemove(null)}
				onConfirm={async () => {
					if (!remove) return;
					await api.adminDeleteUser(remove.id);
					toast("User data deleted");
					setRemove(null);
					void load();
				}}
			/>
		</div>
	);
}
