import { useCallback } from "react";
import {
  useListPersonas,
  useUpdatePersonaSlot,
  getListPersonasQueryKey,
  type PersonaSlot as PersonaSlotRow,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

export type PersonaSlotKey = "A" | "B" | "C";

export interface PersonaSlotView {
  slot: PersonaSlotKey;
  id: string | null;
  title: string;
  content: string;
  authority_level: number | null;
  updated_at: string | null;
}

const SLOT_ORDER: PersonaSlotKey[] = ["A", "B", "C"];

const FALLBACK_TITLES: Record<PersonaSlotKey, string> = {
  A: "Persona A",
  B: "Persona B",
  C: "Persona C",
};

export function normalizePersonaSlots(rows: PersonaSlotRow[] | undefined): PersonaSlotView[] {
  const by_slot = new Map<PersonaSlotKey, PersonaSlotRow>();
  for (const r of rows ?? []) {
    if (r.slot === "A" || r.slot === "B" || r.slot === "C") {
      by_slot.set(r.slot, r);
    }
  }
  return SLOT_ORDER.map((slot) => {
    const r = by_slot.get(slot);
    return {
      slot,
      id: r?.id ?? null,
      title: r?.title ?? FALLBACK_TITLES[slot],
      content: r?.content ?? "",
      authority_level: r?.authority_level ?? null,
      updated_at: r?.updated_at ?? null,
    };
  });
}

export function usePersonas() {
  const query = useListPersonas();
  const slots = normalizePersonaSlots(query.data);
  return {
    slots,
    is_loading: query.isLoading,
    error: query.error as Error | undefined,
    refetch: query.refetch,
  };
}

export function useUpdatePersona() {
  const qc = useQueryClient();
  const mutation = useUpdatePersonaSlot();
  const update = useCallback(
    async (slot: PersonaSlotKey, body: { title: string; content: string }) => {
      await mutation.mutateAsync({ slot, data: body });
      await qc.invalidateQueries({ queryKey: getListPersonasQueryKey() });
    },
    [mutation, qc],
  );
  return { update, is_pending: mutation.isPending, error: mutation.error as Error | undefined };
}
