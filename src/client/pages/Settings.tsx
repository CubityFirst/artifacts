import { useEffect, useState } from "react";
import { api, formatDate, timeAgo, type Token } from "../api.ts";
import { useMe } from "../App.tsx";
import { Avatar, ConfirmDialog, CopyButton, Icon, useToast } from "../components.tsx";

export function SettingsPage() {
	const [fresh, setFresh] = useState<string | null>(null);
	return (
		<div className="page page-narrow">
			<header className="page-head">
				<div>
					<h1>Connect &amp; settings</h1>
					<p className="muted">Give your AI assistants a token, then they can publish here over MCP.</p>
				</div>
			</header>
			<Tokens onCreated={setFresh} />
			<Connect token={fresh} />
			<Account />
		</div>
	);
}

function Tokens({ onCreated }: { onCreated: (token: string) => void }) {
	const toast = useToast();
	const [items, setItems] = useState<Token[] | null>(null);
	const [name, setName] = useState("");
	const [created, setCreated] = useState<string | null>(null);
	const [revoke, setRevoke] = useState<Token | null>(null);

	const load = () =>
		api
			.tokens()
			.then((r) => setItems(r.items))
			.catch(() => setItems([]));
	useEffect(() => {
		void load();
	}, []);

	return (
		<section className="section">
			<div className="section-head">
				<h2>Access tokens</h2>
				<p className="muted">
					One per assistant or machine, so you can see what published what and revoke them separately.
				</p>
			</div>
			<form
				className="row"
				onSubmit={async (e) => {
					e.preventDefault();
					try {
						const res = await api.createToken(name || "Untitled token");
						setCreated(res.token);
						onCreated(res.token);
						setName("");
						void load();
					} catch (err) {
						toast(err instanceof Error ? err.message : "Couldn't create token", "error");
					}
				}}
			>
				<input
					className="input grow"
					placeholder='Name, e.g. "Claude Code – laptop"'
					value={name}
					onChange={(e) => setName(e.target.value)}
					aria-label="Token name"
					maxLength={80}
				/>
				<button type="submit" className="btn btn-primary">
					<Icon name="plus" size={16} /> Create token
				</button>
			</form>

			{created ? (
				<div className="token-reveal" role="status">
					<p>
						<strong>Copy this token now.</strong> It won't be shown again. The setup snippets below already include it.
					</p>
					<div className="row">
						<code className="token-value">{created}</code>
						<CopyButton value={created} className="btn btn-primary" />
					</div>
				</div>
			) : null}

			{items && items.length > 0 ? (
				<ul className="token-list">
					{items.map((t) => (
						<li key={t.id}>
							<Icon name="key" size={16} />
							<div className="grow">
								<strong>{t.name}</strong>
								<span className="muted">
									<code>{t.prefix}…</code> · created {timeAgo(t.created_at)} ·{" "}
									{t.last_used_at ? `last used ${timeAgo(t.last_used_at)}` : "never used"}
								</span>
							</div>
							<button type="button" className="btn btn-sm btn-danger-ghost" onClick={() => setRevoke(t)}>
								Revoke
							</button>
						</li>
					))}
				</ul>
			) : items ? (
				<p className="muted">No tokens yet.</p>
			) : null}

			<ConfirmDialog
				open={!!revoke}
				title={`Revoke "${revoke?.name}"?`}
				body="Assistants using this token will lose access immediately. Artifacts they published stay."
				confirmLabel="Revoke token"
				destructive
				onClose={() => setRevoke(null)}
				onConfirm={async () => {
					if (!revoke) return;
					await api.revokeToken(revoke.id);
					setRevoke(null);
					toast("Token revoked");
					void load();
				}}
			/>
		</section>
	);
}

function Connect({ token }: { token: string | null }) {
	const me = useMe();
	const url = me.config.mcp_url;
	const t = token ?? "<YOUR_TOKEN>";
	const clients: { id: string; name: string; where: string; code: string }[] = [
		{
			id: "claude",
			name: "Claude Code",
			where: "Run in a terminal",
			code: `claude mcp add --transport http --scope user artifacts ${url} \\\n  --header "Authorization: Bearer ${t}"`,
		},
		{
			id: "codex",
			name: "Codex",
			where: "~/.codex/config.toml (and export ARTIFACTS_TOKEN in your shell)",
			code: `[mcp_servers.artifacts]\nurl = "${url}"\nbearer_token_env_var = "ARTIFACTS_TOKEN"\n\n# export ARTIFACTS_TOKEN=${t}`,
		},
		{
			id: "gemini",
			name: "Gemini CLI",
			where: "~/.gemini/settings.json",
			code: JSON.stringify(
				{ mcpServers: { artifacts: { httpUrl: url, headers: { Authorization: `Bearer ${t}` } } } },
				null,
				2,
			),
		},
		{
			id: "cursor",
			name: "Cursor",
			where: "~/.cursor/mcp.json",
			code: JSON.stringify({ mcpServers: { artifacts: { url, headers: { Authorization: `Bearer ${t}` } } } }, null, 2),
		},
		{
			id: "vscode",
			name: "VS Code",
			where: ".vscode/mcp.json",
			code: JSON.stringify(
				{ servers: { artifacts: { type: "http", url, headers: { Authorization: `Bearer ${t}` } } } },
				null,
				2,
			),
		},
		{
			id: "other",
			name: "Other",
			where: "Any MCP client with Streamable HTTP and custom headers",
			code: `URL:    ${url}\nHeader: Authorization: Bearer ${t}`,
		},
	];
	const [active, setActive] = useState(clients[0]!.id);
	const client = clients.find((c) => c.id === active)!;

	return (
		<section className="section">
			<div className="section-head">
				<h2>Connect an assistant</h2>
				<p className="muted">
					The MCP server gives assistants tools to publish, update, edit, list, share and delete your artifacts.
				</p>
			</div>
			<div className="row mcp-url">
				<span className="muted">MCP URL</span>
				<code className="grow">{url}</code>
				<CopyButton value={url} iconOnly label="Copy MCP URL" className="icon-btn" />
			</div>
			<div className="tabs tabs-inline" role="tablist" aria-label="Client">
				{clients.map((c) => (
					<button key={c.id} type="button" role="tab" aria-selected={c.id === active} onClick={() => setActive(c.id)}>
						{c.name}
					</button>
				))}
			</div>
			<div className="snippet" role="tabpanel">
				<div className="snippet-head">
					<span className="muted">{client.where}</span>
					<CopyButton value={client.code} className="btn btn-sm" />
				</div>
				<pre>
					<code>{client.code}</code>
				</pre>
			</div>
			<p className="muted small">
				Then try: <em>“Publish an interactive chart of this data as an artifact and share it by link.”</em>
			</p>
		</section>
	);
}

function Account() {
	const me = useMe();
	const u = me.user;
	const claims = me.session.id_token_claims;
	const claimRows = Object.entries(claims).map(([k, v]) => {
		let shown = typeof v === "string" ? v : JSON.stringify(v);
		if (["exp", "iat", "auth_time"].includes(k) && typeof v === "number") shown = `${v}  (${formatDate(v * 1000)})`;
		return [k, shown] as const;
	});
	return (
		<section className="section">
			<div className="section-head">
				<h2>Account</h2>
			</div>
			<div className="profile">
				<Avatar name={u.name || u.email || "?"} src={u.picture} size={56} />
				<div>
					<strong>{u.name || "—"}</strong>
					<span className="muted">
						{u.email}
						{u.email ? (u.email_verified ? " · verified" : " · unverified") : ""}
					</span>
					<span className="role-list">
						{u.roles.map((r) => (
							<span key={r} className={`pill${r === "admin" ? " pill-accent" : ""}`}>
								{r}
							</span>
						))}
					</span>
				</div>
			</div>
			<details className="claims">
				<summary>
					<Icon name="shield" size={16} /> Verified sign-in claims
				</summary>
				<p className="muted small">
					From the id_token issued by cubityfir.st at sign-in on {formatDate(me.session.created_at)}. Its RS256 signature was
					checked against the provider's JWKS, along with iss, aud, exp and nonce. This session lasts until{" "}
					{formatDate(me.session.expires_at)}.
				</p>
				<dl className="meta-list">
					{claimRows.map(([k, v]) => (
						<div key={k}>
							<dt>
								<code>{k}</code>
							</dt>
							<dd>
								<code>{v}</code>
							</dd>
						</div>
					))}
				</dl>
			</details>
		</section>
	);
}
