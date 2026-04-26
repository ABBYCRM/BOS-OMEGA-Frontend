import { useGetProviderHealth, useListProviders, useUpdateProvider } from "@workspace/api-client-react";
import { ProviderStatusBadge } from "@/components/StatusBadge";
import { formatDate, formatMs } from "@/lib/utils";
import { RefreshCw, Shield, AlertTriangle, CheckCircle, XCircle } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { getGetProviderHealthQueryKey, getListProvidersQueryKey } from "@workspace/api-client-react";

export function ProviderStatus() {
  const { data: health = [], isLoading } = useGetProviderHealth();
  const { data: providers = [] } = useListProviders();
  const updateProvider = useUpdateProvider();
  const queryClient = useQueryClient();

  function handleToggle(id: string, enabled: boolean) {
    updateProvider.mutate(
      { id, enabled },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListProvidersQueryKey() });
        },
      }
    );
  }

  function handleStatusChange(id: string, status: string) {
    updateProvider.mutate(
      { id, status: status as "HEALTHY" | "DEGRADED" | "OPEN_CIRCUIT" | "RECOVERY_TEST" },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetProviderHealthQueryKey() });
        },
      }
    );
  }

  const providerMap = new Map(providers.map((p) => [p.id, p]));

  const statusIcons: Record<string, React.ReactNode> = {
    HEALTHY: <CheckCircle className="w-5 h-5 text-green-400" />,
    DEGRADED: <AlertTriangle className="w-5 h-5 text-amber-400" />,
    OPEN_CIRCUIT: <XCircle className="w-5 h-5 text-red-400" />,
    RECOVERY_TEST: <RefreshCw className="w-5 h-5 text-blue-400" />,
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Shield className="w-4 h-4 text-primary" />
          <h1 className="text-sm font-mono font-bold tracking-wider">PROVIDER STATUS DASHBOARD</h1>
        </div>
        <button
          onClick={() => queryClient.invalidateQueries({ queryKey: getGetProviderHealthQueryKey() })}
          className="flex items-center gap-1.5 px-3 py-1.5 border border-border rounded text-xs font-mono text-muted-foreground hover:text-foreground hover:border-primary/30 transition-all"
        >
          <RefreshCw className="w-3 h-3" />
          REFRESH
        </button>
      </div>

      {isLoading ? (
        <div className="text-xs font-mono text-muted-foreground">Loading provider health...</div>
      ) : (
        <div className="grid grid-cols-1 gap-4">
          {health.map((h) => {
            const provider = providerMap.get(h.provider_id);
            return (
              <div key={h.id} className="bg-card border border-card-border rounded-lg p-5">
                <div className="flex items-start justify-between mb-4">
                  <div className="flex items-center gap-3">
                    {statusIcons[h.status] || <Shield className="w-5 h-5 text-muted-foreground" />}
                    <div>
                      <div className="font-mono font-bold text-foreground">{h.provider_name}</div>
                      <div className="text-[11px] text-muted-foreground font-mono mt-0.5">
                        {provider?.base_url || "No base URL configured"}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <ProviderStatusBadge status={h.status} />
                    {provider && (
                      <button
                        onClick={() => handleToggle(h.provider_id, !provider.enabled)}
                        className={`px-3 py-1 rounded border text-[11px] font-mono transition-all ${
                          provider.enabled
                            ? "bg-green-500/15 text-green-400 border-green-500/30 hover:bg-red-500/15 hover:text-red-400 hover:border-red-500/30"
                            : "bg-red-500/15 text-red-400 border-red-500/30 hover:bg-green-500/15 hover:text-green-400 hover:border-green-500/30"
                        }`}
                      >
                        {provider.enabled ? "ENABLED" : "DISABLED"}
                      </button>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-4 gap-3 mb-4">
                  {[
                    { label: "FAILURES", value: h.failure_count, alert: h.failure_count > 3 },
                    { label: "AVG LATENCY", value: formatMs(h.avg_latency_ms), alert: (h.avg_latency_ms || 0) > 3000 },
                    { label: "LAST SUCCESS", value: formatDate(h.last_success), alert: false },
                    { label: "LAST FAILURE", value: formatDate(h.last_failure), alert: !!h.last_failure },
                  ].map((stat) => (
                    <div key={stat.label} className="bg-muted/30 border border-border rounded p-2.5">
                      <div className="text-[10px] font-mono text-muted-foreground tracking-wider">{stat.label}</div>
                      <div className={`text-sm font-mono font-bold mt-1 ${stat.alert ? "text-amber-400" : "text-foreground"}`}>
                        {stat.value}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Circuit breaker controls */}
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-mono text-muted-foreground">OVERRIDE STATUS:</span>
                  {["HEALTHY", "DEGRADED", "OPEN_CIRCUIT", "RECOVERY_TEST"].map((s) => (
                    <button
                      key={s}
                      onClick={() => handleStatusChange(h.provider_id, s)}
                      className={`px-2 py-1 rounded text-[10px] font-mono border transition-all ${
                        h.status === s
                          ? "bg-primary/20 border-primary/50 text-primary"
                          : "border-border text-muted-foreground hover:border-primary/30 hover:text-foreground"
                      }`}
                    >
                      {s.replace("_", " ")}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
