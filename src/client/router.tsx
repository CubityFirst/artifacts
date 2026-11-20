import { type AnchorHTMLAttributes, type MouseEvent, useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
function subscribe(fn: () => void) {
	listeners.add(fn);
	window.addEventListener("popstate", fn);
	return () => {
		listeners.delete(fn);
		window.removeEventListener("popstate", fn);
	};
}

export function navigate(to: string, opts: { replace?: boolean } = {}) {
	if (opts.replace) history.replaceState(null, "", to);
	else history.pushState(null, "", to);
	for (const fn of listeners) fn();
	if (!opts.replace) window.scrollTo(0, 0);
}

export function useLocation() {
	const href = useSyncExternalStore(subscribe, () => location.pathname + location.search);
	const url = new URL(href, location.origin);
	return { pathname: url.pathname, search: url.searchParams };
}

/** Matches "/a/:id" style patterns. */
export function match(pattern: string, pathname: string): Record<string, string> | null {
	const p = pattern.split("/");
	const s = pathname.replace(/\/+$/, "").split("/");
	if (p.length !== s.length) return null;
	const params: Record<string, string> = {};
	for (let i = 0; i < p.length; i++) {
		if (p[i].startsWith(":")) params[p[i].slice(1)] = decodeURIComponent(s[i]);
		else if (p[i] !== s[i]) return null;
	}
	return params;
}

export function Link({ href, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
	return (
		<a
			href={href}
			onClick={(e: MouseEvent<HTMLAnchorElement>) => {
				onClick?.(e);
				if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
				if (rest.target === "_blank") return;
				e.preventDefault();
				navigate(href);
			}}
			{...rest}
		/>
	);
}
