"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { CrmProvider } from "./CrmProvider";
import { Icon, type IconName } from "./Icon";
import type { UserRole } from "@/types/db";

const NAV: {
  href: string;
  label: string;
  icon: IconName;
  roles: UserRole[];
  // A section with more than one list underneath it. The parent still links to
  // its own default list, so clicking "RRR" never lands nowhere.
  children?: { href: string; label: string }[];
}[] = [
  {
    href: "/today",
    label: "Today",
    icon: "today",
    roles: ["sales_exec", "sales_manager", "admin"],
  },
  {
    href: "/leads",
    label: "Leads",
    icon: "leads",
    roles: ["sales_exec", "sales_manager", "admin", "coo", "ceo", "auditor"],
  },
  {
    href: "/consultation",
    label: "Consultations",
    icon: "consultation",
    roles: [
      "sales_exec",
      "sales_manager",
      "doctor",
      "admin",
      "coo",
      "ceo",
      "auditor",
    ],
  },
  {
    href: "/orders",
    label: "Orders",
    icon: "orders",
    roles: [
      "sales_exec",
      "sales_manager",
      "ops",
      "admin",
      "coo",
      "ceo",
      "auditor",
    ],
  },
  {
    // Everyone who works repeat business. RLS decides what each one sees:
    // an oversight role gets the whole base to hand out, a sales exec gets
    // only their own customers to call. The assign controls are a separate
    // permission on top, checked in the database, not just hidden here.
    href: "/rrr",
    label: "RRR",
    icon: "orders",
    roles: ["sales_exec", "sales_manager", "auditor", "coo", "admin", "ceo"],
    children: [
      { href: "/rrr", label: "All customers" },
      { href: "/rrr/ai", label: "AI Leads · today" },
    ],
  },
];
const ROLE_LABEL: Record<UserRole, string> = {
  sales_exec: "Sales executive",
  sales_manager: "Sales manager",
  doctor: "Doctor",
  ops: "Operations",
  coo: "COO",
  ceo: "CEO",
  admin: "Administrator",
  auditor: "Auditor · read only",
};

export function Shell({
  name,
  role,
  userId,
  children,
}: {
  name: string;
  role: UserRole;
  userId: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname(),
    router = useRouter();
  const [theme, setTheme] = useState<"light" | "dark">("light");
  // Only what the user has explicitly opened or closed. Anything absent falls
  // back to "open if you are inside that section", so arriving on /rrr/ai
  // shows the section already open without a click.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [command, setCommand] = useState("");
  const [logoutError, setLogoutError] = useState("");
  const [loggingOut, setLoggingOut] = useState(false);
  const palette = useRef<HTMLDialogElement>(null),
    commandInput = useRef<HTMLInputElement>(null);
  const items = NAV.filter((item) => item.roles.includes(role));
  useEffect(() => {
    let preferred: "light" | "dark" = window.matchMedia(
      "(prefers-color-scheme: dark)",
    ).matches
      ? "dark"
      : "light";
    try {
      const saved = localStorage.getItem("theme");
      if (saved === "light" || saved === "dark") preferred = saved;
    } catch {}
    setTheme(preferred);
    document.documentElement.dataset.theme = preferred;
  }, []);
  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("theme", next);
    } catch {}
  }
  function openPalette() {
    setCommand("");
    palette.current?.showModal();
    commandInput.current?.focus();
  }
  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (!document.querySelector("dialog[open]")) {
          setCommand("");
          palette.current?.showModal();
          commandInput.current?.focus();
        }
      }
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, []);
  async function signOut() {
    setLoggingOut(true);
    const { error } = await createClient().auth.signOut();
    if (error) {
      setLogoutError(error.message);
      setLoggingOut(false);
      return;
    }
    router.replace("/login");
    router.refresh();
  }
  return (
    <CrmProvider key={userId} viewer={{ id: userId, name, role }}>
      <div className="crm-windowbar">
        <span>Kamour Sales OS</span>
        <span>Workspace</span>
        <span className="windowbar-right">{ROLE_LABEL[role]}</span>
      </div>
      <div className="crm-shell">
        <aside className="crm-sidebar">
          <Link className="crm-brand" href={items[0]?.href ?? "/"}>
            <span className="brand-mark">K</span>
            <span>
              kamour<small>SALES OS</small>
            </span>
          </Link>
          <div className="nav-caption">WORKSPACE</div>
          <nav aria-label="Main navigation">
            {items.map((item) => {
              const inSection =
                pathname === item.href || pathname.startsWith(item.href + "/");
              const open = item.children ? (expanded[item.href] ?? inSection) : false;
              return (
                <div key={item.href}>
                  <div className="nav-row">
                    <Link
                      className={
                        // A parent with children is highlighted by its own
                        // child, not by itself: two things lit at once reads
                        // as being in two places.
                        "nav-link " +
                        (pathname === item.href && !item.children ? "active" : "") +
                        (item.children && inSection ? " in-section" : "")
                      }
                      href={item.href}
                      aria-current={pathname === item.href ? "page" : undefined}
                    >
                      <Icon name={item.icon} />
                      {item.label}
                    </Link>
                    {item.children ? (
                      <button
                        type="button"
                        className={"nav-toggle " + (open ? "open" : "")}
                        aria-expanded={open}
                        aria-label={`${open ? "Collapse" : "Expand"} ${item.label}`}
                        onClick={() =>
                          setExpanded((prev) => ({ ...prev, [item.href]: !open }))
                        }
                      >
                        <Icon name="chevron" />
                      </button>
                    ) : null}
                  </div>
                  {item.children && open ? (
                    <div className="nav-sub">
                      {item.children.map((child) => (
                        <Link
                          key={child.href}
                          className={
                            "nav-sublink " +
                            (pathname === child.href ? "active" : "")
                          }
                          href={child.href}
                          aria-current={pathname === child.href ? "page" : undefined}
                        >
                          {child.label}
                        </Link>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </nav>
          <div className="sidebar-foot">
            <button className="sidebar-command" onClick={openPalette}>
              <Icon name="command" />
              <span>Find a command</span>
              <kbd>Ctrl K</kbd>
            </button>
            <button className="sidebar-command" onClick={toggleTheme}>
              <Icon name="moon" />
              Switch to {theme === "dark" ? "light" : "dark"}
            </button>
            <button
              className="sidebar-command"
              disabled={loggingOut}
              onClick={() => void signOut()}
            >
              <Icon name="logout" />
              {loggingOut ? "Signing out…" : "Sign out"}
            </button>
            {logoutError ? <p role="alert">{logoutError}</p> : null}
            <div className="user-block">
              <span className="user-avatar">
                {name
                  .split(" ")
                  .map((s) => s[0])
                  .slice(0, 2)
                  .join("")}
              </span>
              <span>
                {name}
                <small>{ROLE_LABEL[role]}</small>
              </span>
            </div>
          </div>
        </aside>
        <main className="crm-main">{children}</main>
      </div>
      <dialog ref={palette} className="crm-dialog command-palette">
        <div className="dialog-title">
          <h2>Find a command</h2>
          <button
            onClick={() => palette.current?.close()}
            aria-label="Close command palette"
          >
            Esc
          </button>
        </div>
        <label className="sr-only" htmlFor="command-search">
          Search commands
        </label>
        <input
          id="command-search"
          ref={commandInput}
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder="Jump to a screen…"
        />
        <div className="command-results">
          {items
            .filter((item) =>
              item.label.toLowerCase().includes(command.toLowerCase()),
            )
            .map((item) => (
              <button
                key={item.href}
                onClick={() => {
                  palette.current?.close();
                  router.push(item.href);
                }}
              >
                <Icon name={item.icon} />
                Open {item.label}
              </button>
            ))}
          {"switch theme".includes(command.toLowerCase()) ? (
            <button
              onClick={() => {
                toggleTheme();
                palette.current?.close();
              }}
            >
              <Icon name="moon" />
              Switch theme
            </button>
          ) : null}
        </div>
        <p className="muted">Tab to a result · Enter to open</p>
      </dialog>
    </CrmProvider>
  );
}
