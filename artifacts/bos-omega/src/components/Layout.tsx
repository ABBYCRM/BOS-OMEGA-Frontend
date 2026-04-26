import { Link, useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { fetchAuthState, logout, roleLabel, type AuthUser } from "@/lib/auth";
import {
  Terminal,
  Server,
  Cpu,
  List,
  GitBranch,
  Brain,
  HardDrive,
  ScrollText,
  Settings,
  Users as UsersIcon,
  ShieldCheck,
  LogOut,
  Laptop,
} from "lucide-react";

function LogoutButton() {
  const qc = useQueryClient();
  return (
    <button
      type="button"
      onClick={async () => {
        await logout();
        await qc.invalidateQueries({ queryKey: ["auth-state"] });
      }}
      className="w-full flex items-center gap-2 text-[11px] text-muted-foreground hover:text-foreground mt-2 pt-2 border-t border-sidebar-border transition-colors"
      data-testid="button-logout"
      aria-label="Sign out"
    >
      <LogOut className="w-3 h-3" strokeWidth={1.75} />
      <span>Sign out</span>
    </button>
  );
}

type NavItem = {
  href: string;
  label: string;
  icon: typeof Terminal;
  superAdminOnly?: boolean;
};

type NavSection = {
  label: string;
  items: NavItem[];
};

const navSections: NavSection[] = [
  {
    label: "Operate",
    items: [
      { href: "/console", label: "Task Console", icon: Terminal },
      { href: "/tasks", label: "Task Logs", icon: List },
      { href: "/fallbacks", label: "Fallback Events", icon: GitBranch },
    ],
  },
  {
    label: "Infrastructure",
    items: [
      { href: "/providers", label: "Providers", icon: Server },
      { href: "/models", label: "Model Registry", icon: Cpu },
      { href: "/memory", label: "Memory", icon: Brain },
      { href: "/local-memory", label: "Local Memory", icon: HardDrive },
      { href: "/local-agent", label: "Local Agent", icon: Laptop },
    ],
  },
  {
    label: "Governance",
    items: [
      { href: "/audit", label: "Audit Log", icon: ScrollText },
      { href: "/users", label: "Users", icon: UsersIcon, superAdminOnly: true },
      { href: "/settings", label: "Settings", icon: Settings },
    ],
  },
];

const flatNav = navSections.flatMap((s) => s.items);

function visibleSections(user: AuthUser | undefined): NavSection[] {
  return navSections
    .map((s) => ({
      ...s,
      items: s.items.filter((i) => !i.superAdminOnly || user?.role === "super_admin"),
    }))
    .filter((s) => s.items.length > 0);
}

function RoleBadge({ role }: { role: AuthUser["role"] }) {
  const tone =
    role === "super_admin"
      ? "border-amber-300 bg-amber-50 text-amber-800"
      : role === "admin"
        ? "border-blue-300 bg-blue-50 text-blue-800"
        : "border-border bg-secondary text-foreground";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-2 py-0.5 text-[10.5px] font-mono uppercase tracking-wider rounded border",
        tone,
      )}
      data-testid="badge-role"
    >
      {roleLabel(role)}
    </span>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { data: auth } = useQuery({
    queryKey: ["auth-state"],
    queryFn: fetchAuthState,
    staleTime: 30_000,
    retry: false,
  });
  const user = auth?.authenticated ? auth.user : undefined;
  const sections = visibleSections(user);
  const currentItem = flatNav.find(
    (n) => n.href === location || (n.href === "/console" && location === "/"),
  );

  return (
    <div className="flex h-screen bg-background overflow-hidden text-foreground">
      {/* Sidebar */}
      <aside className="w-64 flex-shrink-0 bg-sidebar border-r border-sidebar-border flex flex-col">
        {/* Brand */}
        <div className="h-16 flex items-center px-5 border-b border-sidebar-border">
          <Link href="/console">
            <div className="flex items-center gap-2.5 cursor-pointer group">
              <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center shadow-card group-hover:shadow-card-hover transition-shadow">
                <span className="text-primary-foreground font-serif text-base font-semibold leading-none">B</span>
              </div>
              <div>
                <div className="text-[15px] font-serif font-semibold text-foreground tracking-tight leading-none">BOS-Omega</div>
                <div className="text-[10.5px] text-muted-foreground tracking-wide mt-1 font-medium">Orchestration platform</div>
              </div>
            </div>
          </Link>
        </div>

        {/* Status pill */}
        <div className="px-4 py-3 border-b border-sidebar-border">
          <div className="flex items-center gap-2 px-2.5 py-2 rounded-md badge-secure">
            <ShieldCheck className="w-3.5 h-3.5" />
            <span className="text-[11px] font-medium tracking-tight">All systems operational</span>
            <span className="ml-auto w-1.5 h-1.5 rounded-full bg-green-600 animate-pulse" />
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 py-3 overflow-y-auto">
          {sections.map((section) => (
            <div key={section.label} className="mb-4">
              <div className="px-5 mb-1.5 text-[10px] uppercase tracking-[0.12em] text-muted-foreground/70 font-semibold">
                {section.label}
              </div>
              {section.items.map((item) => {
                const Icon = item.icon;
                const active = location === item.href || (item.href === "/console" && location === "/");
                return (
                  <Link key={item.href} href={item.href}>
                    <div
                      className={cn(
                        "flex items-center gap-3 px-3 py-2 mx-2 rounded-md text-sm cursor-pointer transition-all duration-150",
                        active
                          ? "bg-card text-foreground shadow-card font-medium"
                          : "text-sidebar-foreground hover:bg-sidebar-accent",
                      )}
                      data-testid={`nav-${item.href.replace(/^\//, "") || "home"}`}
                    >
                      <Icon
                        className={cn(
                          "w-4 h-4 flex-shrink-0",
                          active ? "text-accent" : "text-muted-foreground",
                        )}
                        strokeWidth={active ? 2.25 : 1.75}
                      />
                      <span className="text-[13px]">{item.label}</span>
                    </div>
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-sidebar-border space-y-1">
          <div className="flex items-center gap-2 text-[10.5px] text-muted-foreground">
            <span className="w-1.5 h-1.5 rounded-full bg-green-600" />
            <span>Tri-State Engine</span>
            <span className="ml-auto font-mono">v1.0</span>
          </div>
          <div className="flex items-center gap-2 text-[10.5px] text-muted-foreground">
            <span className="w-1.5 h-1.5 rounded-full bg-green-600" />
            <span>AES-256-GCM at rest</span>
          </div>
          <LogoutButton />
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-hidden flex flex-col">
        {/* Top bar */}
        <div className="h-16 border-b border-border flex items-center px-8 gap-4 flex-shrink-0 bg-background">
          <h1 className="text-[15px] font-serif font-semibold text-foreground tracking-tight">
            {currentItem?.label || "BOS-Omega"}
          </h1>
          <div className="ml-auto flex items-center gap-4">
            <div className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
              <span className="w-1.5 h-1.5 rounded-full bg-green-600" />
              <span>Circuit breakers closed</span>
            </div>
            <div className="w-px h-4 bg-border" />
            <div className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
              <ShieldCheck className="w-3.5 h-3.5 text-green-700" />
              <span>SOC2-ready · encrypted</span>
            </div>
            {user && (
              <>
                <div className="w-px h-4 bg-border" />
                <div className="flex items-center gap-2">
                  <span className="text-[11.5px] font-mono text-foreground" data-testid="text-user-email">
                    {user.email}
                  </span>
                  <RoleBadge role={user.role} />
                </div>
              </>
            )}
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          <div className="px-8 py-8 max-w-[1400px] mx-auto">
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}
