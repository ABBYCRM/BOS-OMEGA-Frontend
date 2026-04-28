import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, KeyRound, ArrowRight } from "lucide-react";

type PreflightResponse =
  | { ok: true; reachable: Array<{ name: string; source: string }> }
  | { ok: false; reachable: []; reason: string; hint: string };

async function fetchPreflight(): Promise<PreflightResponse> {
  const r = await fetch("/api/providers/preflight", { credentials: "include" });
  if (r.status === 401) {
    // Anonymous user (login page); banner has no business rendering.
    return { ok: true, reachable: [] };
  }
  if (!r.ok) {
    throw new Error(`GET /api/providers/preflight failed: ${r.status}`);
  }
  return (await r.json()) as PreflightResponse;
}

/**
 * Top-of-page warning rendered on every authenticated route when
 * NO LLM provider has a usable key (DB-stored, vendor-env, legacy
 * canonical env, or AI Integrations proxy). Without at least one
 * reachable provider, every task submission HOLDs on
 * `no_provider_available`, so this is the single highest-priority
 * "your install isn't usable yet" hint we can surface.
 *
 * The CTA deep-links to /settings#provider-prov_openai so the user
 * jumps straight to the OpenAI ProviderCard with the input field
 * focused on arrival (handled in Settings.tsx).
 */
export function ProviderPreflightBanner() {
  const [location] = useLocation();
  const { data, isLoading, isError } = useQuery({
    queryKey: ["/api/providers/preflight"],
    queryFn: fetchPreflight,
    // Cheap; refetch when the user comes back to the tab so a key
    // pasted in another tab clears the banner immediately.
    refetchOnWindowFocus: true,
    // Short stale time so saving a key in Settings → invalidate
    // makes the banner disappear within a beat.
    staleTime: 5_000,
    retry: false,
  });

  // Hide on the Settings page itself — the user is already where they
  // need to be; another banner just steals real estate.
  if (location.startsWith("/settings")) return null;
  if (isLoading || isError || !data || data.ok) return null;

  return (
    <div
      role="alert"
      data-testid="banner-no-provider"
      className="border-b border-amber-300/70 bg-amber-50 text-amber-900"
    >
      <div className="max-w-[1400px] mx-auto px-8 py-3 flex items-center gap-3">
        <AlertTriangle aria-hidden="true" className="w-4 h-4 shrink-0 text-amber-700" />
        <div className="flex-1 min-w-0 text-[13px] leading-snug">
          <span className="font-medium">No LLM provider is configured.</span>{" "}
          <span className="text-amber-900/80">
            Tasks will hold on <code className="font-mono text-[12px] bg-amber-100/80 px-1 py-0.5 rounded">no_provider_available</code> until
            you paste an API key. Add one now and BOS-Omega will validate it
            and discover models automatically.
          </span>
        </div>
        <Link
          href="/settings#provider-prov_openai"
          data-testid="link-add-openai-key"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-amber-700 text-white text-[12.5px] font-medium hover:bg-amber-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-amber-50 transition-colors shrink-0"
        >
          <KeyRound aria-hidden="true" className="w-3.5 h-3.5" />
          Add OpenAI key
          <ArrowRight aria-hidden="true" className="w-3.5 h-3.5" />
        </Link>
      </div>
    </div>
  );
}
