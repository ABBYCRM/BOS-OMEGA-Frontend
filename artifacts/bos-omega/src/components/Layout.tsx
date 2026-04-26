import { Link, useLocation } from "wouter";
import { cn } from "@/lib/utils";
import {
  Terminal,
  Server,
  Cpu,
  List,
  GitBranch,
  Brain,
  ScrollText,
  Settings,
  Activity,
  Zap,
} from "lucide-react";

const navItems = [
  { href: "/console", label: "Task Console", icon: Terminal },
  { href: "/providers", label: "Provider Status", icon: Server },
  { href: "/models", label: "Model Registry", icon: Cpu },
  { href: "/tasks", label: "Task Logs", icon: List },
  { href: "/fallbacks", label: "Fallback Events", icon: GitBranch },
  { href: "/memory", label: "Memory Manager", icon: Brain },
  { href: "/audit", label: "Audit Log", icon: ScrollText },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  return (
    <div className="flex h-screen bg-background overflow-hidden">
      {/* Sidebar */}
      <aside className="w-56 flex-shrink-0 bg-sidebar border-r border-sidebar-border flex flex-col">
        {/* Logo */}
        <div className="h-14 flex items-center px-4 border-b border-sidebar-border">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded bg-primary/20 border border-primary/40 flex items-center justify-center bos-glow-sm">
              <Zap className="w-4 h-4 text-primary" />
            </div>
            <div>
              <div className="text-xs font-bold text-foreground tracking-widest font-mono">BOS-OMEGA</div>
              <div className="text-[10px] text-muted-foreground tracking-wider">ORCHESTRATION v1.0</div>
            </div>
          </div>
        </div>

        {/* Status indicator */}
        <div className="px-3 py-2 border-b border-sidebar-border">
          <div className="flex items-center gap-2 px-2 py-1.5 rounded bg-primary/10 border border-primary/20">
            <div className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
            <span className="text-[10px] font-mono text-primary tracking-wider">RUNTIME ACTIVE</span>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 py-2 overflow-y-auto">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = location === item.href || (item.href === "/console" && location === "/");
            return (
              <Link key={item.href} href={item.href}>
                <div
                  className={cn(
                    "flex items-center gap-3 px-3 py-2 mx-2 rounded text-sm cursor-pointer transition-all duration-150",
                    active
                      ? "bg-primary/15 text-primary border border-primary/25 bos-glow-sm"
                      : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                  )}
                >
                  <Icon className={cn("w-4 h-4 flex-shrink-0", active ? "text-primary" : "text-muted-foreground")} />
                  <span className={cn("text-xs font-medium", active ? "font-semibold" : "")}>{item.label}</span>
                  {active && <div className="ml-auto w-1 h-1 rounded-full bg-primary" />}
                </div>
              </Link>
            );
          })}
        </nav>

        {/* Footer */}
        <div className="p-3 border-t border-sidebar-border">
          <div className="text-[10px] text-muted-foreground font-mono text-center">
            TRI-STATE ENGINE ONLINE
          </div>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-hidden flex flex-col">
        {/* Top bar */}
        <div className="h-14 border-b border-border flex items-center px-6 gap-4 flex-shrink-0">
          <Activity className="w-4 h-4 text-primary" />
          <span className="text-sm font-mono text-muted-foreground tracking-wider">
            {navItems.find((n) => n.href === location || (n.href === "/console" && location === "/"))?.label || "BOS-OMEGA"}
          </span>
          <div className="ml-auto flex items-center gap-3">
            <span className="text-[10px] font-mono text-muted-foreground">CIRCUIT BREAKERS: CLOSED</span>
            <div className="w-px h-4 bg-border" />
            <span className="text-[10px] font-mono text-green-400">ALL SYSTEMS GO</span>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {children}
        </div>
      </main>
    </div>
  );
}
