import { createContext, useContext, useEffect, useState } from "react";
import { ApiError, api, type Me } from "./api.ts";
import { Avatar, Icon } from "./components.tsx";
import { AdminPage } from "./pages/Admin.tsx";
import { DetailPage } from "./pages/Detail.tsx";
import { GalleryPage } from "./pages/Gallery.tsx";
import { SettingsPage } from "./pages/Settings.tsx";
import { Link, match, useLocation } from "./router.tsx";

const MeContext = createContext<Me | null>(null);
export const useMe = () => useContext(MeContext)!;

export function App() {
	const [me, setMe] = useState<Me | null | undefined>(undefined);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		api
			.me()
			.then(setMe)
			.catch((err) => {
				if (err instanceof ApiError && err.status === 401) setMe(null);
				else setError(err instanceof Error ? err.message : String(err));
			});
	}, []);

	if (error)
		return (
			<Splash
				title="Can't reach Artifacts"
				detail="Check your connection, then try again. If it keeps happening, the service may be down."
				retry
			/>
		);
	if (me === undefined) return <Splash />;
	if (me === null) return <SignIn />;
	return (
		<MeContext.Provider value={me}>
			<Shell />
		</MeContext.Provider>
	);
}

function Splash({ title, detail, retry }: { title?: string; detail?: string; retry?: boolean }) {
	return (
		<div className="splash" role={title ? "alert" : undefined} aria-busy={title ? undefined : true}>
			<img src="/icon.svg" alt="" width={40} height={40} />
			{title ? <h1>{title}</h1> : null}
			{detail ? <p>{detail}</p> : null}
			{retry ? (
				<button type="button" className="btn btn-primary" onClick={() => location.reload()}>
					Try again
				</button>
			) : null}
		</div>
	);
}

/** Provider error codes come back raw in ?auth_error; translate the common ones. */
const AUTH_ERRORS: Record<string, string> = {
	access_denied: "Sign-in was cancelled, or this account isn't allowed in.",
	login_required: "Your cubityfir.st session ended. Sign in again.",
	consent_required: "Sign-in needs your approval on cubityfir.st. Try again.",
	server_error: "cubityfir.st had a problem signing you in. Try again in a moment.",
	temporarily_unavailable: "cubityfir.st is busy right now. Try again in a moment.",
};

function SignIn() {
	const { pathname, search } = useLocation();
	const authError = search.get("auth_error");
	const returnTo = pathname === "/" ? "/" : pathname + (search.size ? `?${search}` : "");
	return (
		<main className="signin">
			<div className="signin-card">
				<img src="/icon.svg" alt="" width={48} height={48} />
				<h1>Artifacts</h1>
				<p>Publish pages, documents and media from any AI assistant, then browse, share and manage them in one place.</p>
				{authError ? (
					<p className="signin-error" role="alert">
						<strong>Couldn't sign you in.</strong> {Object.hasOwn(AUTH_ERRORS, authError) ? AUTH_ERRORS[authError] : authError}
					</p>
				) : null}
				<a className="btn btn-primary btn-lg" href={`/auth/login?return_to=${encodeURIComponent(returnTo)}`}>
					{authError ? "Try again" : "Sign in with cubityfir.st"}
				</a>
			</div>
		</main>
	);
}

function Shell() {
	const me = useMe();
	const { pathname, search } = useLocation();
	const visibility = search.get("visibility");
	const name = me.user.name || me.user.email || "Account";

	let page: React.ReactNode;
	let params: Record<string, string> | null;
	if ((params = match("/a/:id", pathname))) page = <DetailPage key={params.id} id={params.id} />;
	else if (pathname === "/settings") page = <SettingsPage />;
	else if (pathname === "/admin" && me.user.is_admin) page = <AdminPage />;
	else page = <GalleryPage />;

	const onGallery = !pathname.startsWith("/a/") && pathname !== "/settings" && pathname !== "/admin";
	const nav = [
		{ href: "/", label: "All artifacts", icon: "grid", active: onGallery && !visibility },
		{ href: "/?visibility=link", label: "Shared", icon: "globe", active: onGallery && visibility === "link" },
		{ href: "/?visibility=password", label: "Password", icon: "key", active: onGallery && visibility === "password" },
		{ href: "/?visibility=private", label: "Private", icon: "lock", active: onGallery && visibility === "private" },
	];

	return (
		<div className="shell">
			<aside className="sidebar">
				<Link href="/" className="brand">
					<img src="/icon.svg" alt="" width={26} height={26} />
					<span>Artifacts</span>
				</Link>
				<nav aria-label="Main">
					{nav.map((n) => (
						<Link key={n.href} href={n.href} className="nav-item" aria-current={n.active ? "page" : undefined}>
							<Icon name={n.icon} />
							<span>{n.label}</span>
						</Link>
					))}
					<div className="nav-sep" />
					<Link href="/settings" className="nav-item" aria-current={pathname === "/settings" ? "page" : undefined}>
						<Icon name="plug" />
						<span>Connect &amp; settings</span>
					</Link>
					{me.user.is_admin ? (
						<Link href="/admin" className="nav-item" aria-current={pathname === "/admin" ? "page" : undefined}>
							<Icon name="shield" />
							<span>Admin</span>
						</Link>
					) : null}
				</nav>
				<div className="sidebar-user">
					<Avatar name={name} src={me.user.picture} size={30} />
					<div className="sidebar-user-text">
						<strong>{me.user.name || me.user.email}</strong>
						{me.user.name && me.user.email ? <span>{me.user.email}</span> : null}
					</div>
					<button
						type="button"
						className="icon-btn"
						aria-label="Sign out"
						title="Sign out"
						onClick={async () => {
							window.location.href = await api.logout();
						}}
					>
						<Icon name="logout" />
					</button>
				</div>
			</aside>
			<div className="main">{page}</div>
		</div>
	);
}
