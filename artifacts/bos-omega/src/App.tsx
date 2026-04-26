import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Layout } from "@/components/Layout";
import { TaskConsole } from "@/pages/TaskConsole";
import { ProviderStatus } from "@/pages/ProviderStatus";
import { ModelRegistry } from "@/pages/ModelRegistry";
import { TaskLogs } from "@/pages/TaskLogs";
import { TaskDetail } from "@/pages/TaskDetail";
import { FallbackEvents } from "@/pages/FallbackEvents";
import { MemoryManager } from "@/pages/MemoryManager";
import { LocalMemoryPage } from "@/pages/LocalMemory";
import { AuditLog } from "@/pages/AuditLog";
import { Settings } from "@/pages/Settings";
import { Users } from "@/pages/Users";
import { Login } from "@/pages/Login";
import { fetchAuthState } from "@/lib/auth";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry(failureCount, err: unknown) {
        // Never retry 401s — go straight to login.
        const status = (err as { status?: number } | null)?.status;
        if (status === 401) return false;
        return failureCount < 1;
      },
      refetchOnWindowFocus: false,
    },
  },
});

queryClient.getQueryCache().subscribe((event) => {
  if (event.type === "updated" && event.action.type === "error") {
    const err = event.action.error as { status?: number } | null;
    if (err?.status === 401) {
      void queryClient.invalidateQueries({ queryKey: ["auth-state"] });
    }
  }
});

function NotFound() {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="text-center">
        <div className="text-6xl font-serif font-semibold text-muted-foreground mb-4">404</div>
        <div className="text-foreground text-sm">Route not found</div>
      </div>
    </div>
  );
}

function AuthedRouter() {
  return (
    <Layout>
      <Switch>
        <Route path="/">
          <Redirect to="/console" />
        </Route>
        <Route path="/console" component={TaskConsole} />
        <Route path="/providers" component={ProviderStatus} />
        <Route path="/models" component={ModelRegistry} />
        <Route path="/tasks/:id" component={TaskDetail} />
        <Route path="/tasks" component={TaskLogs} />
        <Route path="/fallbacks" component={FallbackEvents} />
        <Route path="/memory" component={MemoryManager} />
        <Route path="/local-memory" component={LocalMemoryPage} />
        <Route path="/audit" component={AuditLog} />
        <Route path="/users" component={Users} />
        <Route path="/settings" component={Settings} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function AuthGate() {
  const { data, isLoading } = useQuery({
    queryKey: ["auth-state"],
    queryFn: fetchAuthState,
    staleTime: 30_000,
    retry: false,
  });

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-sm text-muted-foreground">Loading…</div>
      </div>
    );
  }

  if (!data?.authenticated) {
    return <Login />;
  }

  return <AuthedRouter />;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <AuthGate />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
