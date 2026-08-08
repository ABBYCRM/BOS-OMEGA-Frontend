import { Link, useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
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
  Sheet,
  SheetContent,
  SheetTrigger,
  SheetClose,
} from "@/components/ui/sheet";
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
  Menu,
  X,
} from "lucide-react";
import { useBreakpoint } from "@/hooks/use-breakpoint";

function LogoutButton({ collapsed }: { collapsed?: boolean }) {
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
        className={cn(
          "w-full flex items-center text-[11px] text-muted-foreground hover:text-foreground transition-colors h-auto py-2 px-2",
          collapsed ? "justify-center" : "justify-start gap-2",
        )}
        data-testid="button-logout"
        aria-label="Sign out"
        title={collapsed ? "Sign out" : undefined}
      >
        <LogOut className="w-3 h-3 flex-shrink-0" strokeWidth={1.75} />
        {!collapsed && <span>Sign out</span>}
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

/**
 * Brand block reused in the full sidebar, the icon rail, and the
 * mobile drawer. `collapsed` is true for the icon rail — we show the
 * logo only and let the parent center it.
 */
function BrandBlock({
  umbrellaCorp,
  collapsed,
}: {
  umbrellaCorp: boolean;
  collapsed?: boolean;
}) {
  return (
    <div
      className={cn(
        "h-16 flex items-center border-b border-sidebar-border",
        collapsed ? "justify-center px-0" : "px-5",
      )}
    >
      <Link href="/console">
        {umbrellaCorp ? (
          <div
            className="flex items-center cursor-pointer group"
            data-testid="brand-umbrella-corp"
          >
            <CorporateLogo size={collapsed ? "sm" : "md"} variant="lockup" />
          </div>
        ) : collapsed ? (
          <div
            className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center shadow-card cursor-pointer"
            data-testid="brand-icon-only"
            aria-label="BOS-Omega home"
          >
            <span className="text-primary-foreground font-serif text-base font-semibold leading-none">B</span>
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
  );
}

/**
 * The actual nav body. Used in all three layouts (full / icon rail /
 * mobile drawer). When `collapsed` is true, only the icon is shown
 * (with a title attribute for hover hint) and the section labels
 * are hidden.
 */
function NavBody({
  sections,
  location,
  user,
  collapsed,
}: {
  sections: NavSection[];
  location: string;
  user: AuthUser | undefined;
  collapsed?: boolean;
}) {
  return (
    <nav className="flex-1 py-3 overflow-y-auto">
      {sections.map((section) => (
        <div key={section.label} className="mb-4">
          {!collapsed && (
            <div className="px-5 mb-1.5 text-[10px] uppercase tracking-[0.12em] text-muted-foreground/70 font-semibold">
              {section.label}
            </div>
          )}
          {section.items.map((item) => {
            const Icon = item.icon;
            const active =
              location === item.href ||
              (item.href === "/console" && location === "/");
            return (
              <Link key={item.href} href={item.href}>
                <div
                  className={cn(
                    "flex items-center rounded-md text-sm cursor-pointer transition-all duration-150",
                    collapsed
                      ? "justify-center mx-1.5 my-0.5 py-2.5"
                      : "gap-3 px-3 py-2 mx-2",
                    active
                      ? "bg-card text-foreground shadow-card font-medium"
                      : "text-sidebar-foreground hover:bg-sidebar-accent",
                  )}
                  data-testid={`nav-${item.href.replace(/^\//, "") || "home"}`}
                  title={collapsed ? item.label : undefined}
                  aria-label={collapsed ? item.label : undefined}
                >
                  <Icon
                    className={cn(
                      "flex-shrink-0",
                      collapsed ? "w-4 h-4" : "w-4 h-4",
                      active ? "text-accent" : "text-muted-foreground",
                    )}
                    strokeWidth={active ? 2.25 : 1.75}
                  />
                  {!collapsed && (
                    <span className="text-[13px]">{item.label}</span>
                  )}
                </div>
              </Link>
            );
          })}
        </div>
      ))}
      {!collapsed && sections.some((s) => s.label === "Intel") && user && (
        <ConversationsList />
      )}
    </nav>
  );
}

function UmbrellaCorpFooter() {
  return (
    <div
      className="umbrella-corp-confidential mb-2"
      data-testid="confidential-footer"
    >
      <div className="uc-danger-stripe" aria-hidden />
      <div className="uc-clearance-row">
        <span className="uc-blink-dot" aria-hidden />
        <span>CLEARANCE: ALPHA-7</span>
        <span className="uc-clearance-code">UC-SEC-0</span>
      </div>
      <div className="uc-stamp-row">
        <strong>⬛ CONFIDENTIAL ⬛</strong>
      </div>
      <div className="uc-classification-sub">SCI // NOFORN // ORCON</div>
      <div className="uc-divider" />
      <div className="uc-restriction-line">▶ RESTRICTED ACCESS</div>
      <div className="uc-warning-line">
        ⚠ UNAUTHORIZED ACCESS IS PROHIBITED
      </div>
      <div className="uc-restriction-line">
        ALL ACTIVITY IS LOGGED AND MONITORED
      </div>
      <div className="uc-danger-stripe" aria-hidden />
    </div>
  );
}

function StatusBlock({ collapsed }: { collapsed?: boolean }) {
  return (
    <div className="space-y-1">
      {!collapsed && (
        <div className="flex items-center gap-2 text-[10.5px] text-muted-foreground">
          <span className="w-1.5 h-1.5 rounded-full bg-green-600" />
          <span>Tri-State Engine</span>
          <span className="ml-auto font-mono">v1.0</span>
        </div>
      )}
      <div className="flex items-center gap-2 text-[10.5px] text-muted-foreground">
        <span className="w-1.5 h-1.5 rounded-full bg-green-600" />
        {collapsed ? (
          <ShieldCheck className="w-3 h-3 ml-auto" aria-label="Encrypted" />
        ) : (
          <span>AES-256-GCM at rest</span>
        )}
      </div>
    </div>
  );
}

/**
 * Lethal warning — only shown under the umbrella-corp theme.
 * Always renders its text in the full sidebar / drawer; hidden in
 * the icon rail to keep the rail tight.
 */
function LethalWarning() {
  return (
    <div className="uc-lethal-warning" data-testid="lethal-warning">
      <span className="uc-lethal-dot" aria-hidden />
      <span>⚠ THREAT LEVEL: CRITICAL</span>
      <div className="uc-lethal-sub">LETHAL FORCE AUTHORIZED</div>
      <div className="uc-lethal-sub">TERMINATE ON SIGHT</div>
    </div>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const bp = useBreakpoint();
  const [drawerOpen, setDrawerOpen] = useState(false);
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
  const [theme] = useTheme();
  const umbrellaCorp = theme === "umbrella-corp";

  // Close the mobile drawer on route change so users don't have to
  // dismiss it after tapping a link.
  const onNavigate = () => {
    if (bp === "mobile") setDrawerOpen(false);
  };

  // On mobile, the sidebar is a Sheet. We render the SheetRoot open
  // state from `drawerOpen` and close it on any nav.
  const isMobile = bp === "mobile";
  const isTablet = bp === "tablet";

  // The sidebar BODY (brand + status + nav + footer) shared across
  // all three layouts. Each layout wraps it differently.
  const sidebarBody = (
    <>
      <BrandBlock umbrellaCorp={umbrellaCorp} collapsed={isTablet} />
      {!isTablet && umbrellaCorp && <LethalWarning />}
      {!isTablet && (
        <div className="px-4 py-3 border-b border-sidebar-border">
          <div className="flex items-center gap-2 px-2.5 py-2 rounded-md badge-secure">
            <ShieldCheck className="w-3.5 h-3.5 flex-shrink-0" />
            <span className="text-[11px] font-medium tracking-tight truncate">
              All systems operational
            </span>
            <span className="ml-auto w-1.5 h-1.5 rounded-full bg-green-600 animate-pulse" />
          </div>
        </div>
      )}
      <NavBody
        sections={sections}
        location={location}
        user={user}
        collapsed={isTablet}
      />
      <div
        className={cn(
          "border-t border-sidebar-border space-y-1",
          isTablet ? "px-1.5 py-3" : "px-4 py-3",
        )}
      >
        {umbrellaCorp && !isTablet && <UmbrellaCorpFooter />}
        <StatusBlock collapsed={isTablet} />
        <LogoutButton collapsed={isTablet} />
      </div>
    </>
  );

  return (
    <div className="relative flex h-screen bg-background overflow-hidden text-foreground">
      {umbrellaCorp && !isMobile && <MatrixRain />}

      {/* DESKTOP: full sidebar (w-52 = 208px) */}
      {!isMobile && !isTablet && (
        <aside className="relative w-52 flex-shrink-0 bg-sidebar border-r border-sidebar-border flex flex-col overflow-hidden z-10">
          {sidebarBody}
        </aside>
      )}

      {/* TABLET: collapsed icon rail (w-14 = 56px) */}
      {!isMobile && isTablet && (
        <aside
          className="relative w-14 flex-shrink-0 bg-sidebar border-r border-sidebar-border flex flex-col overflow-hidden z-10"
          aria-label="Primary"
        >
          {sidebarBody}
        </aside>
      )}

      {/* MOBILE: hidden sidebar — the Sheet below handles it */}
      {isMobile && (
        <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
          <SheetContent
            side="left"
            className="w-[85vw] max-w-[320px] p-0 bg-sidebar border-r border-sidebar-border flex flex-col overflow-hidden"
          >
            <div className="flex items-center justify-between px-4 h-16 border-b border-sidebar-border">
              <span className="text-[15px] font-serif font-semibold text-foreground tracking-tight">
                BOS-Omega
              </span>
              <SheetClose
                className="rounded-sm p-2 hover:bg-sidebar-accent transition-colors"
                aria-label="Close menu"
              >
                <X className="h-4 w-4" />
              </SheetClose>
            </div>
            {umbrellaCorp && <LethalWarning />}
            <NavBody
              sections={sections}
              location={location}
              user={user}
            />
            <div className="border-t border-sidebar-border px-4 py-3 space-y-1">
              {umbrellaCorp && <UmbrellaCorpFooter />}
              <StatusBlock />
              <LogoutButton />
            </div>
          </SheetContent>
        </Sheet>
      )}

      {/* Main */}
      <main className="relative flex-1 overflow-hidden flex flex-col z-10 min-w-0">
        {/* Top bar — responsive padding + chip collapse */}
        <div
          className={cn(
            "h-16 border-b border-border flex items-center gap-3 sm:gap-4 flex-shrink-0 bg-background",
            // Horizontal padding shrinks on mobile
            "px-3 sm:px-6",
          )}
        >
          {/* Hamburger on mobile */}
          {isMobile && (
            <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
              <SheetTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-11 w-11 -ml-1"
                  aria-label="Open menu"
                  data-testid="button-mobile-menu"
                >
                  <Menu className="h-5 w-5" />
                </Button>
              </SheetTrigger>
            </Sheet>
          )}
          <h1
            className="text-[15px] font-serif font-semibold text-foreground tracking-tight truncate min-w-0"
            onClick={onNavigate}
          >
            {currentItem?.label || "BOS-Omega"}
          </h1>
          {/* Tactical tagline — only visible under umbrella-corp theme. */}
          <span className="umbrella-corp-tagline hidden md:inline" data-testid="header-tagline">
            OUR BUSINESS IS CONTROL
          </span>
          <div className="ml-auto flex items-center gap-2 sm:gap-4 min-w-0">
            {/* Tactical status chips — desktop-only under umbrella-corp */}
            <span className="umbrella-corp-chip umbrella-corp-only hidden lg:inline-flex" data-testid="chip-system-status">
              <span className="uc-dot" />
              <span className="uc-label-dim">System Status</span>
              <span>All Systems Operational</span>
            </span>
            <span className="umbrella-corp-chip umbrella-corp-only hidden lg:inline-flex" data-testid="chip-breakers">
              <span className="uc-label-dim">Circuit Breakers</span>
              <span>Closed</span>
            </span>
            <span className="umbrella-corp-chip umbrella-corp-only hidden lg:inline-flex" data-testid="chip-soc2">
              <span className="uc-label-dim">SOC2-Ready</span>
              <span>Encrypted</span>
            </span>

            {/* Default chrome: hidden on mobile */}
            <div className="hidden md:flex items-center gap-2 text-[11.5px] text-muted-foreground umbrella-corp-hide">
              <span className="w-1.5 h-1.5 rounded-full bg-green-600" />
              <span className="hidden lg:inline">Circuit breakers closed</span>
            </div>
            <div className="hidden md:block w-px h-4 bg-border umbrella-corp-hide" />
            <div className="hidden md:flex items-center gap-2 text-[11.5px] text-muted-foreground umbrella-corp-hide">
              <ShieldCheck className="w-3.5 h-3.5 text-green-700" />
              <span className="hidden lg:inline">SOC2-ready · encrypted</span>
            </div>
            {user && (
              <>
                <div className="hidden sm:block w-px h-4 bg-border" />
                <LatticeMenu />
                <div className="hidden sm:block w-px h-4 bg-border" />
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className="text-[11.5px] font-mono text-foreground truncate max-w-[120px] sm:max-w-[200px]"
                    data-testid="text-user-email"
                    title={user.email}
                  >
                    {user.email}
                  </span>
                  <RoleBadge role={user.role} />
                </div>
              </>
            )}
          </div>
        </div>

        {/* No-provider warning */}
        <ProviderPreflightBanner />

        {/* Content — responsive padding */}
        <div className="flex-1 overflow-y-auto">
          <div
            className={cn(
              // Generous on desktop, tight on mobile
              "px-3 py-3 sm:px-6 sm:py-6",
              "max-w-[1600px] mx-auto",
            )}
          >
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}
