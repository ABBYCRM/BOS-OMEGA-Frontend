import { Link, useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { fetchAuthState, logout, roleLabel, type AuthUser } from "@/lib/auth";
import { ConversationsList } from "@/components/ConversationsList";
import { LatticeMenu } from "@/components/LatticeMenu";
import { CorporateLogo } from "@/components/CorporateLogo";
import { ProviderPreflightBanner } from "@/components/ProviderPreflightBanner";
import { useTheme } from "@/lib/theme";
import { MatrixRain } from "@/components/MatrixRain";
import { Button } from "@/components/ui/button";
import {
  Terminal,
  Server,
  Brain,
  Settings,
  Users as UsersIcon,
  ShieldCheck,
  LogOut,
  HardDrive,
  ScrollText,
  GitBranch,
  Cpu,
  Building2,
} from "lucide-react";

function LogoutButton() {
  const qc = useQueryClient();
  return (
    <div className="mt-2 pt-2 border-t border-sidebar-border">
      <Button
        variant="ghost"
        size="sm"
        onClick={async () => {
          await logout();
          await qc.invalidateQueries({ queryKey: ["auth-state"] });
        }}
        className="w-full flex items-center justify-start gap-2 text-[11px] text-muted-foreground hover:text-foreground transition-colors h-auto py-2 px-2"
        data-testid="button-logout"
        aria-label="Sign out"
      >
        <LogOut className="w-3 h-3" strokeWidth={1.75} />
        <span>Sign out</span>
      </Button>
    </div>
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
    label: "Intel",
    items: [
      { href: "/console", label: "Console", icon: Terminal },
      { href: "/memory", label: "Memory", icon: Brain },
      { href: "/local-memory", label: "Local Memory", icon: HardDrive },
    ],
  },
  {
    label: "Ops",
    items: [
      { href: "/audit", label: "Audit Log", icon: ScrollText },
      { href: "/fallback-events", label: "Fallback Events", icon: GitBranch },
    ],
  },
  {
    label: "Registry",
    items: [
      { href: "/models", label: "Models", icon: Cpu },
      { href: "/local-agent", label: "Local Agent", icon: Building2, superAdminOnly: true },
    ],
  },
  {
    label: "System",
    items: [
      { href: "/providers", label: "Providers", icon: Server },
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
      ? "border-accent/60 bg-accent/10 text-accent-foreground"
      : role === "admin"
        ? "border-primary/40 bg-primary/10 text-primary"
        : "border-border bg-secondary text-secondary-foreground";
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
  // The umbrella-corp theme swaps in a tactical brand lockup + extra
  // header chrome. Other themes keep the existing minimal brand badge.
  const [theme] = useTheme();
  const umbrellaCorp = theme === "umbrella-corp";

  return (
    <div className="relative flex h-screen bg-background overflow-hidden text-foreground">
      {umbrellaCorp && <MatrixRain />}
      {/* Sidebar */}
      <aside className="relative w-52 flex-shrink-0 bg-sidebar border-r border-sidebar-border flex flex-col overflow-hidden z-10">
        {/* Brand */}
        <div className="h-16 flex items-center px-5 border-b border-sidebar-border">
          <Link href="/console">
            {umbrellaCorp ? (
              <div className="flex items-center cursor-pointer group" data-testid="brand-umbrella-corp">
                <CorporateLogo size="md" variant="lockup" />
              </div>
            ) : (
              <div className="flex items-center gap-2.5 cursor-pointer group">
                <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center shadow-card group-hover:shadow-card-hover transition-shadow">
                  <span className="text-primary-foreground font-serif text-base font-semibold leading-none">B</span>
                </div>
                <div>
                  <div className="text-[15px] font-serif font-semibold text-foreground tracking-tight leading-none">BOS-Omega</div>
                  <div className="text-[10.5px] text-muted-foreground tracking-wide mt-1 font-medium">Orchestration platform</div>
                </div>
              </div>
            )}
          </Link>
        </div>

        {/* Scary upper-left warning — only visible under umbrella-corp theme */}
        <div className="uc-lethal-warning" data-testid="lethal-warning">
          <span className="uc-lethal-dot" aria-hidden />
          <span>⚠ THREAT LEVEL: CRITICAL</span>
          <div className="uc-lethal-sub">LETHAL FORCE AUTHORIZED</div>
          <div className="uc-lethal-sub">TERMINATE ON SIGHT</div>
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
            <div key={section.label}>
              <div className="mb-4">
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
              {/* Lattice continuity (Task #68): conversations belong with
                  the Operate group since they scope the Task Console. */}
              {section.label === "Intel" && user && <ConversationsList />}
            </div>
          ))}
        </nav>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-sidebar-border space-y-1">
          {/* Confidential badge — only visible under the umbrella-corp
              theme (display:none under every other theme via CSS).
              When visible it carries its own bottom margin so non-umbrella
              themes keep their original space-y-1 spacing exactly. */}
          <div
            className="umbrella-corp-confidential mb-2"
            data-testid="confidential-footer"
          >
            {/* Warning stripe at top */}
            <div className="uc-danger-stripe" aria-hidden />

            {/* Clearance level row */}
            <div className="uc-clearance-row">
              <span className="uc-blink-dot" aria-hidden />
              <span>CLEARANCE: ALPHA-7</span>
              <span className="uc-clearance-code">UC-SEC-0</span>
            </div>

            {/* Classification stamp */}
            <div className="uc-stamp-row">
              <strong>⬛ CONFIDENTIAL ⬛</strong>
            </div>
            <div className="uc-classification-sub">SCI // NOFORN // ORCON</div>

            {/* Divider */}
            <div className="uc-divider" />

            {/* Access restrictions */}
            <div className="uc-restriction-line">▶ RESTRICTED ACCESS</div>
            <div className="uc-warning-line">
              ⚠ UNAUTHORIZED ACCESS IS PROHIBITED
            </div>
            <div className="uc-restriction-line">
              ALL ACTIVITY IS LOGGED AND MONITORED
            </div>

            {/* Warning stripe at bottom */}
            <div className="uc-danger-stripe" aria-hidden />
          </div>
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
      <main className="relative flex-1 overflow-hidden flex flex-col z-10">
        {/* Top bar */}
        <div className="h-16 border-b border-border flex items-center px-6 gap-4 flex-shrink-0 bg-background">
          <h1 className="text-[15px] font-serif font-semibold text-foreground tracking-tight">
            {currentItem?.label || "BOS-Omega"}
          </h1>
          {/* Tactical tagline — visible only under the umbrella-corp theme. */}
          <span className="umbrella-corp-tagline" data-testid="header-tagline">
            OUR BUSINESS IS CONTROL
          </span>
          <div className="ml-auto flex items-center gap-4">
            {/* Tactical status chips — replace the regular status text under
                the umbrella-corp theme (CSS toggles which set is shown). */}
            <span className="umbrella-corp-chip umbrella-corp-only" data-testid="chip-system-status">
              <span className="uc-dot" />
              <span className="uc-label-dim">System Status</span>
              <span>All Systems Operational</span>
            </span>
            <span className="umbrella-corp-chip umbrella-corp-only" data-testid="chip-breakers">
              <span className="uc-label-dim">Circuit Breakers</span>
              <span>Closed</span>
            </span>
            <span className="umbrella-corp-chip umbrella-corp-only" data-testid="chip-soc2">
              <span className="uc-label-dim">SOC2-Ready</span>
              <span>Encrypted</span>
            </span>

            {/* Default chrome: hidden under umbrella-corp via .umbrella-corp-hide */}
            <div className="flex items-center gap-2 text-[11.5px] text-muted-foreground umbrella-corp-hide">
              <span className="w-1.5 h-1.5 rounded-full bg-green-600" />
              <span>Circuit breakers closed</span>
            </div>
            <div className="w-px h-4 bg-border umbrella-corp-hide" />
            <div className="flex items-center gap-2 text-[11.5px] text-muted-foreground umbrella-corp-hide">
              <ShieldCheck className="w-3.5 h-3.5 text-green-700" />
              <span>SOC2-ready · encrypted</span>
            </div>
            {user && (
              <>
                <div className="w-px h-4 bg-border" />
                <LatticeMenu />
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

        {/* No-provider warning — only renders when /api/providers/preflight
            reports no reachable LLM key. Hidden on /settings to avoid
            duplicating the affordance the user is already looking at. */}
        <ProviderPreflightBanner />

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          <div className="px-6 py-6 max-w-[1600px] mx-auto">
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}
