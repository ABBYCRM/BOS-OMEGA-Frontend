import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
import { AuditLog } from "@/pages/AuditLog";
import { Settings } from "@/pages/Settings";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function NotFound() {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="text-center font-mono">
        <div className="text-6xl font-bold text-muted-foreground mb-4">404</div>
        <div className="text-primary text-sm">BOS-OMEGA: Route not found</div>
      </div>
    </div>
  );
}

function Router() {
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
        <Route path="/audit" component={AuditLog} />
        <Route path="/settings" component={Settings} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
